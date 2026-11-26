'use strict';
/**
 * Integration — loans (receivables lent out, ADR-010). Mirrors the vault
 * model: no money columns on the record, amount/pending derived from the
 * append-only loan_history ledger. Validates: creation semantics (plain,
 * lending on create, over-available rollback, pre_existing opening income),
 * the /balance equilibrium (available = total - locked - lent), lend/repay
 * bounds and response shape, journal transactions being read-only and
 * loan_id being server-owned, invariant interplay with the opening income,
 * the delete-at-zero-pending rule, the history feed, team RBAC, and event
 * emission (including that journal rows never log a transaction event).
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

const INSUFFICIENT_LOAN = 'Insufficient available balance: cannot lend more than is spendable';
const JOURNAL_READONLY = 'Loan journal transactions are read-only; use the loan lend/repay endpoints';

let me;

beforeEach(async () => {
  wipeAll();
  seedUser('lender@test.local', 'secret123');
  me = api(await login('lender@test.local', 'secret123'));
});

afterAll(wipeAll);

describe('creation semantics', () => {
  it('creates a plain loan with zero amount and zero pending', async () => {
    const res = await me.post('/loans', { name: 'Ana' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Ana', amount: 0, pending: 0 });
  });

  it('lending on create discounts available without touching total', async () => {
    await me.post('/transactions', { type: 'income', amount: 500.75 });
    const res = await me.post('/loans', { name: 'Bob', amount: 200.5 });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Bob', amount: 200.5, pending: 200.5 });
    expect((await me.get('/balance')).body).toMatchObject({ total: 500.75, available: 300.25 });
  });

  it('rejects an over-available create and writes nothing', async () => {
    await me.post('/transactions', { type: 'income', amount: 100 });
    const res = await me.post('/loans', { name: 'Overreach', amount: 200 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INSUFFICIENT_LOAN });
    expect((await me.get('/loans')).body).toHaveLength(0);
    expect((await me.get('/transactions')).body.items).toHaveLength(1); // only the income
  });

  it('books a pre-existing loan as a counted opening income plus its journal expense, bypassing the guard', async () => {
    await me.post('/transactions', { type: 'income', amount: 100 });
    const res = await me.post('/loans', { name: 'Carla', amount: 150, pre_existing: true }); // exceeds available on purpose
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Carla', amount: 150, pending: 150 });
    expect((await me.get('/balance')).body).toMatchObject({ total: 250, available: 100 });

    const txns = (await me.get('/transactions')).body.items;
    expect(txns).toHaveLength(3); // income + opening income + journal expense
    const opening = txns.find((t) => t.description === 'Loan opening: Carla');
    expect(opening).toMatchObject({ type: 'income', amount: 150, loan_id: null });
    const journal = txns.find((t) => t.description === 'Carla');
    expect(journal).toMatchObject({ type: 'expense', amount: 150, loan_id: res.body.id });
  });
});

describe('/balance equilibrium', () => {
  it('reflects vault allocation and loan lending together', async () => {
    await me.post('/transactions', { type: 'income', amount: 1000 });
    const vault = (await me.post('/vaults', { name: 'Emergency' })).body;
    await me.post(`/vaults/${vault.id}/allocate`, { amount: 200 });
    const loan = (await me.post('/loans', { name: 'Dana', amount: 300 })).body;

    const bal = await me.get('/balance');
    expect(bal.body).toMatchObject({ total: 1000, available: 500, lent: 300 });
    expect(bal.body.loans).toEqual([{ id: loan.id, name: 'Dana', amount: 300, pending: 300 }]);
  });
});

describe('lend / repay', () => {
  let loanId;
  beforeEach(async () => {
    await me.post('/transactions', { type: 'income', amount: 1000 });
    loanId = (await me.post('/loans', { name: 'Eli' })).body.id;
    await me.post(`/loans/${loanId}/lend`, { amount: 400.25 });
  });

  it('repay releases available and drops pending, keeping amount at total lent', async () => {
    const res = await me.post(`/loans/${loanId}/repay`, { amount: 150.25 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: loanId, name: 'Eli', amount: 400.25, pending: 250 });
    expect((await me.get('/balance')).body).toMatchObject({ total: 1000, available: 750, lent: 250 });
  });

  it('rejects repaying more than pending', async () => {
    const res = await me.post(`/loans/${loanId}/repay`, { amount: 400.26 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Cannot repay more than the loan pending amount' });
  });

  it('rejects lending more than available', async () => {
    const res = await me.post(`/loans/${loanId}/lend`, { amount: 600 }); // available = 599.75
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INSUFFICIENT_LOAN });
  });

  it('rejects missing, zero, or negative amounts on lend and repay', async () => {
    expect((await me.post(`/loans/${loanId}/lend`, {})).status).toBe(400);
    expect((await me.post(`/loans/${loanId}/lend`, { amount: 0 })).status).toBe(400);
    expect((await me.post(`/loans/${loanId}/lend`, { amount: -10 })).status).toBe(400);
    expect((await me.post(`/loans/${loanId}/repay`, {})).status).toBe(400);
    expect((await me.post(`/loans/${loanId}/repay`, { amount: 0 })).status).toBe(400);
    expect((await me.post(`/loans/${loanId}/repay`, { amount: -10 })).status).toBe(400);
  });
});

describe('journal read-only', () => {
  let loanId, journalId;
  beforeEach(async () => {
    await me.post('/transactions', { type: 'income', amount: 500 });
    loanId = (await me.post('/loans', { name: 'Fran' })).body.id;
    await me.post(`/loans/${loanId}/lend`, { amount: 100 });
    journalId = (await me.get('/transactions?type=expense')).body.items[0].id;
  });

  it('rejects editing a journal row', async () => {
    const res = await me.put(`/transactions/${journalId}`, { amount: 50 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: JOURNAL_READONLY });
  });

  it('rejects deleting a journal row', async () => {
    const res = await me.del(`/transactions/${journalId}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: JOURNAL_READONLY });
  });

  it('ignores a client-sent loan_id on POST /transactions', async () => {
    const tx = (await me.post('/transactions', { type: 'expense', amount: 10, loan_id: loanId })).body;
    expect(tx.loan_id).toBeNull();
  });
});

describe('negative available interplay (ADR-012)', () => {
  it('allows deleting the pre-existing opening income while pending > 0 — available goes negative', async () => {
    const loan = (await me.post('/loans', { name: 'Gia', amount: 200, pre_existing: true })).body;
    const opening = (await me.get('/transactions?type=income')).body.items
      .find((t) => t.description === 'Loan opening: Gia');
    expect(opening).toBeDefined();

    expect((await me.del(`/transactions/${opening.id}`)).status).toBe(204);
    const bal = (await me.get('/balance')).body;
    expect(bal).toMatchObject({ total: 0, lent: 200, available: -200 });
    expect(bal.loans).toEqual([{ id: loan.id, name: 'Gia', amount: 200, pending: 200 }]); // receivable untouched
  });

  it('allows an expense when money is lent; lending more stays capped', async () => {
    await me.post('/transactions', { type: 'income', amount: 300 });
    const loan = (await me.post('/loans', { name: 'Hana', amount: 300 })).body; // available = 0
    expect((await me.post('/transactions', { type: 'expense', amount: 1 })).status).toBe(201);
    expect((await me.get('/balance')).body.available).toBe(-1);
    expect((await me.post(`/loans/${loan.id}/lend`, { amount: 1 })).status).toBe(400);
  });
});

describe('delete rule', () => {
  it('rejects deleting a loan with pending money', async () => {
    await me.post('/transactions', { type: 'income', amount: 300 });
    const loanId = (await me.post('/loans', { name: 'Ivy', amount: 100 })).body.id;
    const res = await me.del(`/loans/${loanId}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Cannot delete a loan with pending money; repay it to zero first' });
  });

  it('deletes once repaid to zero, leaving journal rows readable in /transactions', async () => {
    await me.post('/transactions', { type: 'income', amount: 300 });
    const loanId = (await me.post('/loans', { name: 'Jon', amount: 100 })).body.id;
    await me.post(`/loans/${loanId}/repay`, { amount: 100 });

    expect((await me.del(`/loans/${loanId}`)).status).toBe(204);
    expect((await me.get(`/loans/${loanId}`)).status).toBe(404);
    expect((await me.get('/transactions')).body.items).toHaveLength(3); // income + lend journal + repay journal
  });
});

describe('history endpoint', () => {
  it('returns movements newest-first with decimal amounts', async () => {
    await me.post('/transactions', { type: 'income', amount: 300 });
    const loanId = (await me.post('/loans', { name: 'Kim', amount: 100 })).body.id;
    await me.post(`/loans/${loanId}/repay`, { amount: 40 });

    const history = (await me.get(`/loans/${loanId}/history`)).body;
    expect(history).toHaveLength(2);
    expect(history.map((h) => h.action)).toEqual(['repay', 'lend']);
    expect(history[0]).toMatchObject({ action: 'repay', amount: 40 });
    expect(history[1]).toMatchObject({ action: 'lend', amount: 100 });
  });

  it('404s a foreign loan', async () => {
    seedUser('other@test.local', 'secret123');
    const other = api(await login('other@test.local', 'secret123'));
    const loanId = (await me.post('/loans', { name: 'Leo' })).body.id;

    const res = await other.get(`/loans/${loanId}/history`);
    expect(res.status).toBe(404);
  });
});

describe('team RBAC', () => {
  let owner, member, guest, teamId, loanId;

  beforeEach(async () => {
    seedUser('owner@test.local', 'secret123');
    seedUser('member@test.local', 'secret123');
    seedUser('guest@test.local', 'secret123');
    owner  = api(await login('owner@test.local', 'secret123'));
    member = api(await login('member@test.local', 'secret123'));
    guest  = api(await login('guest@test.local', 'secret123'));

    const team = (await owner.post('/teams', { name: 'Household' })).body;
    teamId = team.id;
    await owner.post(`/teams/${teamId}/members`, { email: 'member@test.local', role: 'member' });
    await owner.post(`/teams/${teamId}/members`, { email: 'guest@test.local', role: 'guest' });
    await owner.post(`/transactions?team_id=${teamId}`, { type: 'income', amount: 1000 });

    loanId = (await member.post(`/loans?team_id=${teamId}`, { name: 'Team loan' })).body.id;
  });

  it('denies a guest from lending', async () => {
    const res = await guest.post(`/loans/${loanId}/lend?team_id=${teamId}`, { amount: 10 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Guests have read-only access' });
  });

  it("lets a member lend on their own loan but not mutate another member's loan", async () => {
    expect((await member.post(`/loans/${loanId}/lend?team_id=${teamId}`, { amount: 100 })).status).toBe(200);

    seedUser('member2@test.local', 'secret123');
    const member2 = api(await login('member2@test.local', 'secret123'));
    await owner.post(`/teams/${teamId}/members`, { email: 'member2@test.local', role: 'member' });

    const res = await member2.post(`/loans/${loanId}/lend?team_id=${teamId}`, { amount: 10 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Members can only modify records they created' });
  });

  it('lets the owner mutate any member loan', async () => {
    const res = await owner.post(`/loans/${loanId}/lend?team_id=${teamId}`, { amount: 50 });
    expect(res.status).toBe(200);
  });

  it('scopes /loans and /balance by team_id', async () => {
    await owner.post(`/loans?team_id=${teamId}`, { name: 'Owner loan' });

    expect((await owner.get(`/loans?team_id=${teamId}`)).body).toHaveLength(2);
    expect((await owner.get('/loans')).body).toHaveLength(0); // not in personal

    expect((await owner.get(`/balance?team_id=${teamId}`)).body.loans).toHaveLength(2);
  });
});

describe('events', () => {
  it('logs the loan lifecycle without a stray transaction event for journal rows', async () => {
    await me.post('/transactions', { type: 'income', amount: 500 });
    const loan = (await me.post('/loans', { name: 'Mia', amount: 200 })).body;
    await me.post(`/loans/${loan.id}/repay`, { amount: 50 });
    await me.post(`/loans/${loan.id}/repay`, { amount: 150 });
    await me.del(`/loans/${loan.id}`);

    const loanFeed = (await me.get('/events?entity=loan')).body;
    expect(loanFeed.map((e) => e.action)).toEqual(['deleted', 'repaid', 'repaid', 'created']);
    expect(loanFeed[3]).toMatchObject({
      entity: 'loan', entity_id: loan.id, action: 'created', summary: { name: 'Mia', amount: 200 },
    });
    expect(loanFeed[2].summary).toEqual({ name: 'Mia', amount: 50 });
    expect(loanFeed[1].summary).toEqual({ name: 'Mia', amount: 150 });
    expect(loanFeed[0].summary).toEqual({ name: 'Mia' });

    // journal rows book transactions, but never emit a transaction event
    const txEvents = (await me.get('/events?entity=transaction')).body;
    expect(txEvents).toHaveLength(1); // just the plain income
  });
});
