'use strict';
/**
 * Integration — the vault/balance model (ADR-004), following the PRD §6
 * worked example. Validates: derived total/available/vault figures, the hard
 * negative `available` (ADR-012, supersedes the old ≥ 0 guard), allocate/lend caps, withdraw ≤
 * vault balance, and vault deletion only at balance 0.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let me;

const balance = async () => (await me.get('/balance')).body;

beforeEach(async () => {
  wipeAll();
  seedUser('saver@test.local', 'secret123');
  me = api(await login('saver@test.local', 'secret123'));
});

afterAll(wipeAll);

describe('PRD worked example', () => {
  it('walks income → allocate → expense → rejection → withdraw', async () => {
    await me.post('/transactions', { type: 'income', amount: 2000 });
    expect(await balance()).toMatchObject({ total: 2000, available: 2000 });

    const vault = (await me.post('/vaults', { name: 'Emergency' })).body;
    const alloc = await me.post(`/vaults/${vault.id}/allocate`, { amount: 500 });
    expect(alloc.status).toBe(200);
    expect(alloc.body.balance).toBe(500);
    expect(await balance()).toMatchObject({ total: 2000, available: 1500 });

    expect((await me.post('/transactions', { type: 'expense', amount: 1500 })).status).toBe(201);
    expect(await balance()).toMatchObject({ total: 500, available: 0 });

    // available goes to -1 — allowed since ADR-012; the vault stays intact
    expect((await me.post('/transactions', { type: 'expense', amount: 1 })).status).toBe(201);
    expect(await balance()).toMatchObject({ total: 499, available: -1 });
    await me.post('/transactions', { type: 'income', amount: 1 });

    const withdrawn = await me.post(`/vaults/${vault.id}/withdraw`, { amount: 500 });
    expect(withdrawn.body.balance).toBe(0);
    const final = await balance();
    expect(final).toMatchObject({ total: 500, available: 500 });
    expect(final.vaults).toEqual([{ id: vault.id, name: 'Emergency', balance: 0, target: null }]);
  });
});

describe('available may go negative; allocate stays capped (ADR-012)', () => {
  let vaultId, incomeId;
  beforeEach(async () => {
    incomeId = (await me.post('/transactions', { type: 'income', amount: 100 })).body.id;
    vaultId = (await me.post('/vaults', { name: 'Locked' })).body.id;
    await me.post(`/vaults/${vaultId}/allocate`, { amount: 80 }); // available = 20
  });

  it('rejects over-allocating', async () => {
    const res = await me.post(`/vaults/${vaultId}/allocate`, { amount: 21 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot allocate more than is spendable/);
  });

  it('allows increasing an expense past available', async () => {
    const expense = (await me.post('/transactions', { type: 'expense', amount: 10 })).body;
    expect((await me.put(`/transactions/${expense.id}`, { amount: 21 })).status).toBe(200);
    expect(await balance()).toMatchObject({ total: 79, available: -1 });
  });

  it('allows shrinking or deleting income the vaults depend on', async () => {
    expect((await me.put(`/transactions/${incomeId}`, { amount: 79 })).status).toBe(200);
    expect(await balance()).toMatchObject({ total: 79, available: -1 });
    expect((await me.del(`/transactions/${incomeId}`)).status).toBe(204);
    expect(await balance()).toMatchObject({ total: 0, available: -80 });
  });

  it('with available <= 0 nothing can be allocated or lent', async () => {
    await me.post('/transactions', { type: 'expense', amount: 50 }); // available = -30
    expect((await me.post(`/vaults/${vaultId}/allocate`, { amount: 0.01 })).status).toBe(400);
    const loan = (await me.post('/loans', { name: 'Eli' })).body;
    expect((await me.post(`/loans/${loan.id}/lend`, { amount: 0.01 })).status).toBe(400);
    // the vault itself is untouched and still withdrawable
    expect((await me.post(`/vaults/${vaultId}/withdraw`, { amount: 80 })).body.balance).toBe(0);
  });

  it('rejects withdrawing more than the vault balance', async () => {
    const res = await me.post(`/vaults/${vaultId}/withdraw`, { amount: 81 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Cannot withdraw more than the vault balance' });
  });
});

describe('vault deletion', () => {
  it('only deletes at balance 0', async () => {
    await me.post('/transactions', { type: 'income', amount: 100 });
    const vaultId = (await me.post('/vaults', { name: 'Trip' })).body.id;
    await me.post(`/vaults/${vaultId}/allocate`, { amount: 40 });

    const blocked = await me.del(`/vaults/${vaultId}`);
    expect(blocked.status).toBe(400);
    expect(blocked.body).toEqual({
      error: 'Cannot delete a vault with a non-zero balance; withdraw it to zero first',
    });

    await me.post(`/vaults/${vaultId}/withdraw`, { amount: 40 });
    expect((await me.del(`/vaults/${vaultId}`)).status).toBe(204);
    expect((await me.get(`/vaults/${vaultId}`)).status).toBe(404); // soft-deleted → 404
    expect((await balance()).vaults).toEqual([]);
  });
});
