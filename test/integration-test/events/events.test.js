'use strict';
/**
 * Integration — activity events ledger (/events feed, ADR-009).
 * Validates: per-entity emission (transactions, vaults incl. allocate/withdraw,
 * shopping lists/items incl. atomic checkout, team management), personal vs team
 * scoping (personal = own actions; team = every member's), guest read access,
 * non-member 403, query params (entity/action/since_id/limit), admin ?user_id=
 * targeting, and that a failed checkout logs nothing.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let me;
let meId;

beforeEach(async () => {
  wipeAll();
  meId = seedUser('actor@test.local', 'secret123');
  me = api(await login('actor@test.local', 'secret123'));
});

afterAll(wipeAll);

describe('personal feed', () => {
  it('logs transaction create/update/delete newest-first with decimal summaries', async () => {
    const tx = (await me.post('/transactions', { type: 'income', amount: 100, description: 'Salary' })).body;
    await me.put(`/transactions/${tx.id}`, { amount: 150.5 });
    await me.del(`/transactions/${tx.id}`);

    const feed = (await me.get('/events')).body;
    expect(feed).toHaveLength(3);
    expect(feed.map((e) => e.action)).toEqual(['deleted', 'updated', 'created']);
    expect(feed[2]).toMatchObject({
      entity: 'transaction', entity_id: tx.id, action: 'created', team_id: null,
      user_id: meId, actor_email: 'actor@test.local',
      summary: { type: 'income', amount: 100, description: 'Salary' },
    });
    expect(feed[1].summary.amount).toBe(150.5); // updated logs the new record
  });

  it('logs the vault lifecycle including allocate/withdraw with amounts', async () => {
    await me.post('/transactions', { type: 'income', amount: 100 });
    const vault = (await me.post('/vaults', { name: 'Emergency' })).body;
    await me.post(`/vaults/${vault.id}/allocate`, { amount: 40.25 });
    await me.post(`/vaults/${vault.id}/withdraw`, { amount: 40.25 });
    await me.del(`/vaults/${vault.id}`);

    const actions = (await me.get('/events?entity=vault')).body.map((e) => e.action);
    expect(actions).toEqual(['deleted', 'withdrawn', 'allocated', 'created']);
    const alloc = (await me.get('/events?entity=vault&action=allocated')).body[0];
    expect(alloc.summary).toEqual({ name: 'Emergency', amount: 40.25 });
    expect(alloc.entity_id).toBe(vault.id);
  });

  it('logs the shopping flow: list, items, checked toggle, checkout, delete', async () => {
    await me.post('/transactions', { type: 'income', amount: 100 });
    const list = (await me.post('/shopping-lists', { name: 'Groceries' })).body;
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Milk' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });
    const done = await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 12.5 });
    expect(done.status).toBe(200);
    await me.del(`/shopping-lists/${list.id}`);

    const feed = (await me.get('/events')).body.filter((e) => e.entity !== 'transaction');
    expect(feed.map((e) => [e.entity, e.action])).toEqual([
      ['shopping_list', 'deleted'],
      ['shopping_list', 'checked_out'],
      ['shopping_list_item', 'updated'],
      ['shopping_list_item', 'created'],
      ['shopping_list', 'created'],
    ]);
    const checkout = feed[1];
    expect(checkout.summary).toEqual({
      name: 'Groceries', amount: 12.5, transaction_id: done.body.transaction_id,
    });
    expect(feed[2].summary).toEqual({ list_id: list.id, name: 'Milk', checked: true });
    expect(feed[3].summary.checked).toBe(false);
  });

  it('a rejected checkout logs nothing (atomic with the expense)', async () => {
    await me.post('/transactions', { type: 'income', amount: 10 });
    const list = (await me.post('/shopping-lists', { name: 'Big plans' })).body;
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'TV' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });
    const before = (await me.get('/events')).body.length;

    const res = await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 999, category_ids: [999999] });
    expect(res.status).toBe(400);
    expect((await me.get('/events')).body).toHaveLength(before);
  });

  it('rejected writes log nothing', async () => {
    const res = await me.post('/transactions', { type: 'transfer', amount: 50 }); // invalid type
    expect(res.status).toBe(400);
    expect((await me.get('/events')).body).toHaveLength(0);
  });
});

describe('query params', () => {
  it('supports since_id and limit; rejects invalid values', async () => {
    await me.post('/transactions', { type: 'income', amount: 1 });
    await me.post('/transactions', { type: 'income', amount: 2 });
    const all = (await me.get('/events')).body;
    expect(all).toHaveLength(2);

    expect((await me.get('/events?limit=1')).body).toHaveLength(1);

    const newer = (await me.get(`/events?since_id=${all[1].id}`)).body;
    expect(newer.map((e) => e.id)).toEqual([all[0].id]);
    expect((await me.get(`/events?since_id=${all[0].id}`)).body).toHaveLength(0);

    expect((await me.get('/events?limit=0')).status).toBe(400);
    expect((await me.get('/events?since_id=abc')).status).toBe(400);
  });

  it('has no write routes', async () => {
    expect((await me.post('/events', { entity: 'transaction' })).status).toBe(404);
  });
});

describe('team scoping', () => {
  let owner, member, guest, memberId, team;

  beforeEach(async () => {
    seedUser('owner@test.local', 'secret123');
    memberId = seedUser('member@test.local', 'secret123');
    seedUser('guest@test.local', 'secret123');
    owner = api(await login('owner@test.local', 'secret123'));
    member = api(await login('member@test.local', 'secret123'));
    guest = api(await login('guest@test.local', 'secret123'));
    team = (await owner.post('/teams', { name: 'Casa' })).body;
    await owner.post(`/teams/${team.id}/members`, { email: 'member@test.local', role: 'member' });
    await owner.post(`/teams/${team.id}/members`, { email: 'guest@test.local', role: 'guest' });
  });

  it("shows every member's actions in the team feed, none in personal feeds", async () => {
    await member.post(`/transactions?team_id=${team.id}`, { type: 'income', amount: 50 });

    const teamFeed = (await owner.get(`/events?team_id=${team.id}&entity=transaction`)).body;
    expect(teamFeed).toHaveLength(1);
    expect(teamFeed[0]).toMatchObject({
      actor_email: 'member@test.local', team_id: team.id, action: 'created',
    });
    // personal feeds are own personal actions only — the team write isn't there
    expect((await member.get('/events')).body).toHaveLength(0);
    expect((await owner.get('/events?entity=transaction')).body).toHaveLength(0);
  });

  it('guest can read the feed; non-member cannot', async () => {
    expect((await guest.get(`/events?team_id=${team.id}`)).status).toBe(200);
    expect((await me.get(`/events?team_id=${team.id}`)).status).toBe(403);
  });

  it('logs team management: add, role change, remove, update', async () => {
    await owner.put(`/teams/${team.id}/members/${memberId}`, { role: 'owner' });
    await owner.del(`/teams/${team.id}/members/${memberId}`);
    await owner.put(`/teams/${team.id}`, { name: 'Hogar' });

    const feed = (await owner.get(`/events?team_id=${team.id}&entity=team`)).body;
    expect(feed.map((e) => e.action)).toEqual([
      'updated', 'member_removed', 'role_changed', 'member_added', 'member_added',
    ]);
    expect(feed[0].summary).toEqual({ name: 'Hogar' });
    expect(feed[1].summary).toEqual({ user_id: memberId });
    expect(feed[2].summary).toEqual({ user_id: memberId, role: 'owner' });
    expect(feed.every((e) => e.actor_email === 'owner@test.local')).toBe(true);
  });

  it('books a shared-list checkout event into the LIST team feed with the member as actor', async () => {
    await owner.post(`/transactions?team_id=${team.id}`, { type: 'income', amount: 100 });
    const list = (await member.post(`/shopping-lists?team_id=${team.id}`, { name: 'Semana' })).body;
    const item = (await member.post(`/shopping-list-items?team_id=${team.id}`, { list_id: list.id, name: 'Pan' })).body;
    await member.put(`/shopping-list-items/${item.id}?team_id=${team.id}`, { checked: true });
    // member checks out from their PERSONAL active context; event still lands in the team
    await member.post(`/shopping-lists/${list.id}/checkout?team_id=${team.id}`, { amount: 20 });

    const checkout = (await owner.get(`/events?team_id=${team.id}&action=checked_out`)).body;
    expect(checkout).toHaveLength(1);
    expect(checkout[0]).toMatchObject({
      actor_email: 'member@test.local', team_id: team.id, entity_id: list.id,
      summary: { name: 'Semana', amount: 20 },
    });
    expect((await member.get('/events?action=checked_out')).body).toHaveLength(0);
  });
});

describe('admin', () => {
  it("reads another user's personal feed via ?user_id= and acts as themselves", async () => {
    seedUser('admin@test.local', 'secret123', 'admin');
    const admin = api(await login('admin@test.local', 'secret123'));
    await me.post('/transactions', { type: 'income', amount: 5 });

    const feed = (await admin.get(`/events?user_id=${meId}`)).body;
    expect(feed).toHaveLength(1);
    expect(feed[0].actor_email).toBe('actor@test.local');
    expect((await admin.get('/events')).body).toHaveLength(0); // admin's own personal feed
  });
});
