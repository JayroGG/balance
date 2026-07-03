'use strict';
/**
 * Integration — cross-context transfers (auto-capture Slice 2): one atomic
 * two-legged operation (expense in `from`, income in `to`, shared
 * transfer_group_id), RBAC-gated on both ends; legs immutable individually.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let u, guest, teamId;

beforeEach(async () => {
  wipeAll();
  seedUser('u@test.local', 'secret123');
  seedUser('guest@test.local', 'secret123');
  u = api(await login('u@test.local', 'secret123'));
  guest = api(await login('guest@test.local', 'secret123'));
  await u.post('/transactions', { type: 'income', amount: 1000 });
  teamId = (await u.post('/teams', { name: 'Empresa' })).body.id;
  await u.post(`/teams/${teamId}/members`, { email: 'guest@test.local', role: 'guest' });
});

afterAll(wipeAll);

describe('POST /transfers', () => {
  it('creates both legs and moves both balances', async () => {
    const res = await u.post('/transfers', { amount: 300, to_team_id: teamId, description: 'capital' });
    expect(res.status).toBe(201);
    expect(res.body.transfer_group_id).toBeDefined();
    expect(res.body.from).toMatchObject({ type: 'expense', amount: 300, team_id: null, description: 'capital' });
    expect(res.body.to).toMatchObject({ type: 'income', amount: 300, team_id: teamId, description: 'capital' });
    expect(res.body.from.transfer_group_id).toBe(res.body.transfer_group_id);
    expect(res.body.to.transfer_group_id).toBe(res.body.transfer_group_id);

    expect((await u.get('/balance')).body.total).toBe(700);
    expect((await u.get(`/balance?team_id=${teamId}`)).body.total).toBe(300);
  });

  it('rejects from = to, non-positive amounts, and overspending the from context', async () => {
    expect((await u.post('/transfers', { amount: 10 })).status).toBe(400); // personal -> personal
    expect((await u.post('/transfers', { amount: 10, from_team_id: teamId, to_team_id: teamId })).status).toBe(400);
    expect((await u.post('/transfers', { amount: 0, to_team_id: teamId })).status).toBe(400);

    const res = await u.post('/transfers', { amount: 99999, to_team_id: teamId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient available balance/);
  });

  it('requires a write-capable role on the team end', async () => {
    await guest.post('/transactions', { type: 'income', amount: 50 });
    expect((await guest.post('/transfers', { amount: 10, to_team_id: teamId })).status).toBe(403);
    expect((await guest.post('/transfers', { amount: 10, from_team_id: teamId })).status).toBe(403);
    expect((await u.post('/transfers', { amount: 10, to_team_id: 9999 })).status).toBe(404);
  });
});

describe('leg immutability', () => {
  it('400s PUT/DELETE on either leg, pointing at the transfer', async () => {
    const t = (await u.post('/transfers', { amount: 100, to_team_id: teamId })).body;
    const res = await u.put(`/transactions/${t.from.id}`, { amount: 50 });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'part of a transfer — delete the transfer instead' });
    expect((await u.del(`/transactions/${t.to.id}?team_id=${teamId}`)).status).toBe(400);
  });
});

describe('DELETE /transfers/:group_id', () => {
  it('soft-deletes both legs atomically and restores both balances', async () => {
    const t = (await u.post('/transfers', { amount: 300, to_team_id: teamId })).body;
    expect((await u.del(`/transfers/${t.transfer_group_id}`)).status).toBe(204);
    expect((await u.get('/balance')).body.total).toBe(1000);
    expect((await u.get(`/balance?team_id=${teamId}`)).body.total).toBe(0);
    expect((await u.del(`/transfers/${t.transfer_group_id}`)).status).toBe(404); // gone
  });

  it('blocks the delete when the income leg is locked in a vault', async () => {
    const t = (await u.post('/transfers', { amount: 200, to_team_id: teamId })).body;
    const vault = (await u.post(`/vaults?team_id=${teamId}`, { name: 'Lock' })).body;
    await u.post(`/vaults/${vault.id}/allocate?team_id=${teamId}`, { amount: 150 });

    const res = await u.del(`/transfers/${t.transfer_group_id}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/Insufficient available balance/);
    // withdraw unlocks it
    await u.post(`/vaults/${vault.id}/withdraw?team_id=${teamId}`, { amount: 150 });
    expect((await u.del(`/transfers/${t.transfer_group_id}`)).status).toBe(204);
  });

  it('is invisible to users without rights on a leg (404, not 403)', async () => {
    const t = (await u.post('/transfers', { amount: 100, to_team_id: teamId })).body;
    expect((await guest.del(`/transfers/${t.transfer_group_id}`)).status).toBe(403); // guest on team leg
    seedUser('outsider@test.local', 'secret123');
    const outsider = api(await login('outsider@test.local', 'secret123'));
    expect((await outsider.del(`/transfers/${t.transfer_group_id}`)).status).toBe(404);
  });
});
