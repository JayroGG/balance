'use strict';
/**
 * Integration — shopping lists (pre-expense checklists) + checkout.
 * Validates: CRUD + status filter, item writes gated to open lists, checkout
 * atomically posts one expense in the LIST's context and freezes the list,
 * the available>=0 invariant on checkout (nothing written on breach), the
 * checked-item / already-purchased guards, cascade delete, team context
 * sharing, and the RBAC matrix (guest / member / owner).
 */
const { db, wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

const activeItemCount = (listId) =>
  db.prepare('SELECT COUNT(*) AS n FROM shopping_list_items WHERE list_id = ? AND deleted_at IS NULL').get(listId).n;

const INSUFFICIENT_TX = 'Insufficient available balance: the amount exceeds spendable money (funds are allocated to vaults)';

let me;

beforeEach(async () => {
  wipeAll();
  seedUser('shopper@test.local', 'secret123');
  me = api(await login('shopper@test.local', 'secret123'));
});

afterAll(wipeAll);

describe('personal lifecycle', () => {
  it('creates a list, adds items, and checks out into the ledger', async () => {
    await me.post('/transactions', { type: 'income', amount: 1000 });

    const list = (await me.post('/shopping-lists', { name: 'Supermarket' })).body;
    expect(list).toMatchObject({ name: 'Supermarket', status: 'open', transaction_id: null });

    const milk = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Milk', qty: 2, price: 25.5 })).body;
    expect(milk).toMatchObject({ list_id: list.id, name: 'Milk', qty: 2, price: 25.5, checked: 0 });
    await me.post('/shopping-list-items', { list_id: list.id, name: 'Bread', price: 3 });

    // status filter
    expect((await me.get('/shopping-lists?status=open')).body).toHaveLength(1);
    expect((await me.get('/shopping-lists?status=purchased')).body).toHaveLength(0);

    // check one item, then check out
    expect((await me.put(`/shopping-list-items/${milk.id}`, { checked: true })).body.checked).toBe(1);

    const done = await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 41.87 });
    expect(done.status).toBe(200);
    expect(done.body.status).toBe('purchased');
    expect(done.body.transaction_id).toEqual(expect.any(Number));

    // one expense titled with the list name landed in the ledger
    const txns = (await me.get('/transactions?type=expense')).body;
    expect(txns).toHaveLength(1);
    expect(txns[0]).toMatchObject({ id: done.body.transaction_id, description: 'Supermarket', amount: 41.87 });
    expect((await me.get('/balance')).body).toMatchObject({ total: 958.13, available: 958.13 });
  });

  it('applies the list default category, overridable per checkout', async () => {
    await me.post('/transactions', { type: 'income', amount: 100 });
    const cat = (await me.post('/categories', { name: 'Groceries', kind: 'expense' })).body;
    const list = (await me.post('/shopping-lists', { name: 'Weekly', category_id: cat.id })).body;
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Eggs' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });

    const done = await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 10 });
    const tx = (await me.get(`/transactions/${done.body.transaction_id}`)).body;
    expect(tx.category_id).toBe(cat.id);
  });
});

describe('checkout guards', () => {
  let list;
  beforeEach(async () => {
    await me.post('/transactions', { type: 'income', amount: 1000 });
    list = (await me.post('/shopping-lists', { name: 'Groceries' })).body;
  });

  it('rejects checkout with no checked items and writes nothing', async () => {
    await me.post('/shopping-list-items', { list_id: list.id, name: 'Milk' }); // unchecked
    const res = await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at least one checked item/);
    expect((await me.get('/transactions?type=expense')).body).toHaveLength(0);
  });

  it('rejects a second checkout', async () => {
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Milk' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });
    expect((await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 10 })).status).toBe(200);

    const again = await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 10 });
    expect(again.status).toBe(400);
    expect(again.body.error).toMatch(/already checked out/);
    expect((await me.get('/transactions?type=expense')).body).toHaveLength(1); // no extra tx
  });

  it('rejects checkout that would push available below zero — nothing is written', async () => {
    const vault = (await me.post('/vaults', { name: 'Savings' })).body;
    await me.post(`/vaults/${vault.id}/allocate`, { amount: 950 }); // available = 50
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Milk' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });

    const res = await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 60 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: INSUFFICIENT_TX });
    expect((await me.get('/transactions?type=expense')).body).toHaveLength(0);
    expect((await me.get(`/shopping-lists/${list.id}`)).body.status).toBe('open'); // not flipped
  });

  it('rejects a non-positive amount', async () => {
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Milk' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });
    expect((await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 0 })).status).toBe(400);
  });
});

describe('purchased lists are frozen; delete never touches the ledger', () => {
  let list, itemId, txId;
  beforeEach(async () => {
    await me.post('/transactions', { type: 'income', amount: 1000 });
    list = (await me.post('/shopping-lists', { name: 'Frozen' })).body;
    itemId = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Milk' })).body.id;
    await me.put(`/shopping-list-items/${itemId}`, { checked: true });
    txId = (await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 10 })).body.transaction_id;
  });

  it('blocks edits to a purchased list and its items', async () => {
    expect((await me.put(`/shopping-lists/${list.id}`, { name: 'Renamed' })).status).toBe(400);
    expect((await me.put(`/shopping-list-items/${itemId}`, { checked: false })).status).toBe(400);
    expect((await me.post('/shopping-list-items', { list_id: list.id, name: 'Late' })).status).toBe(400);
  });

  it('deletes the list (cascading items) but leaves the transaction', async () => {
    expect(activeItemCount(list.id)).toBe(1);
    expect((await me.del(`/shopping-lists/${list.id}`)).status).toBe(204);
    expect((await me.get(`/shopping-lists/${list.id}`)).status).toBe(404);
    expect(activeItemCount(list.id)).toBe(0); // items cascade soft-deleted
    expect((await me.get(`/transactions/${txId}`)).status).toBe(200); // ledger untouched
  });
});

describe('team context + RBAC', () => {
  let owner, member, guest, other, teamId, listId;

  beforeEach(async () => {
    seedUser('owner@test.local', 'secret123');
    seedUser('member@test.local', 'secret123');
    seedUser('guest@test.local', 'secret123');
    seedUser('other@test.local', 'secret123');
    owner  = api(await login('owner@test.local', 'secret123'));
    member = api(await login('member@test.local', 'secret123'));
    guest  = api(await login('guest@test.local', 'secret123'));
    other  = api(await login('other@test.local', 'secret123'));

    const team = (await owner.post('/teams', { name: 'Household' })).body;
    teamId = team.id;
    await owner.post(`/teams/${teamId}/members`, { email: 'member@test.local', role: 'member' });
    await owner.post(`/teams/${teamId}/members`, { email: 'guest@test.local', role: 'guest' });
    await owner.post(`/transactions?team_id=${teamId}`, { type: 'income', amount: 1000 });

    listId = (await member.post(`/shopping-lists?team_id=${teamId}`, { name: 'Shared' })).body.id;
    await member.post(`/shopping-list-items?team_id=${teamId}`, { list_id: listId, name: 'Milk' });
  });

  it('shares a list and its items across the team', async () => {
    // owner sees the member-created list AND its member-created item
    expect((await owner.get(`/shopping-lists?team_id=${teamId}`)).body).toHaveLength(1);
    expect((await owner.get(`/shopping-list-items?list_id=${listId}&team_id=${teamId}`)).body).toHaveLength(1);
  });

  it('lets a guest read but not write', async () => {
    expect((await guest.get(`/shopping-lists?team_id=${teamId}`)).status).toBe(200);
    expect((await guest.post(`/shopping-lists?team_id=${teamId}`, { name: 'Nope' })).status).toBe(403);
    expect((await guest.post(`/shopping-list-items?team_id=${teamId}`, { list_id: listId, name: 'Nope' })).status).toBe(403);
  });

  it('denies a non-member entirely', async () => {
    expect((await other.get(`/shopping-lists?team_id=${teamId}`)).status).toBe(403);
  });

  it('lets the owner check out any member list; a member only their own', async () => {
    const items = (await owner.get(`/shopping-list-items?list_id=${listId}&team_id=${teamId}`)).body;
    await owner.put(`/shopping-list-items/${items[0].id}?team_id=${teamId}`, { checked: true });

    // a second member cannot check out the first member's list
    seedUser('member2@test.local', 'secret123');
    const member2 = api(await login('member2@test.local', 'secret123'));
    await owner.post(`/teams/${teamId}/members`, { email: 'member2@test.local', role: 'member' });
    expect((await member2.post(`/shopping-lists/${listId}/checkout?team_id=${teamId}`, { amount: 10 })).status).toBe(403);

    // owner bypasses ownership
    const done = await owner.post(`/shopping-lists/${listId}/checkout?team_id=${teamId}`, { amount: 10 });
    expect(done.status).toBe(200);
    // the expense booked into the TEAM ledger
    expect((await owner.get(`/transactions?type=expense&team_id=${teamId}`)).body).toHaveLength(1);
    expect((await owner.get('/transactions?type=expense')).body).toHaveLength(0); // not personal
  });
});
