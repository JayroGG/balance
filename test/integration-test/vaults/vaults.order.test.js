'use strict';
/**
 * Integration — per-user vault order (ADR-016): PUT /vaults/order, scope checks,
 * and ordering in GET /vaults and the /balance summary.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let ana, ben, outsider, teamId;
const mk = async (client, name, q = '') => (await client.post(`/vaults${q}`, { name })).body.id;
const names = (res) => res.body.map((v) => v.name);

beforeEach(async () => {
  wipeAll();
  for (const n of ['ana', 'ben', 'out']) seedUser(`${n}@test.local`, 'secret123');
  ana = api(await login('ana@test.local', 'secret123'));
  ben = api(await login('ben@test.local', 'secret123'));
  outsider = api(await login('out@test.local', 'secret123'));
  teamId = (await ana.post('/teams', { name: 'Home' })).body.id;
  await ana.post(`/teams/${teamId}/members`, { email: 'ben@test.local', role: 'member' });
});
afterAll(wipeAll);

describe('PUT /vaults/order', () => {
  it('orders list and balance summary; unordered go last by creation', async () => {
    const a = await mk(ana, 'A'), c0 = await mk(ana, 'B'), c = await mk(ana, 'C');
    expect(names(await ana.get('/vaults'))).toEqual(['A', 'B', 'C']);
    expect((await ana.put('/vaults/order', { ids: [c, a] })).status).toBe(204);
    expect(names(await ana.get('/vaults'))).toEqual(['C', 'A', 'B']);
    expect((await ana.get('/balance')).body.vaults.map((v) => v.name)).toEqual(['C', 'A', 'B']);
    await mk(ana, 'D');
    expect(names(await ana.get('/vaults'))).toEqual(['C', 'A', 'B', 'D']);
    expect(c0).toBeDefined();
  });

  it('a partial reorder keeps the other ordered vaults after the given ones', async () => {
    const a = await mk(ana, 'A'), b = await mk(ana, 'B'), c = await mk(ana, 'C');
    await ana.put('/vaults/order', { ids: [c, b, a] });
    await ana.put('/vaults/order', { ids: [a] });
    expect(names(await ana.get('/vaults'))).toEqual(['A', 'C', 'B']);
  });

  it('team vaults keep a separate order per member', async () => {
    const x = await mk(ana, 'X', `?team_id=${teamId}`), y = await mk(ana, 'Y', `?team_id=${teamId}`);
    await ana.put(`/vaults/order?team_id=${teamId}`, { ids: [y, x] });
    expect(names(await ana.get(`/vaults?team_id=${teamId}`))).toEqual(['Y', 'X']);
    expect(names(await ben.get(`/vaults?team_id=${teamId}`))).toEqual(['X', 'Y']);
    expect((await ben.put(`/vaults/order?team_id=${teamId}`, { ids: [y, x] })).status).toBe(204);
    expect((await ben.get(`/balance?team_id=${teamId}`)).body.vaults.map((v) => v.name)).toEqual(['Y', 'X']);
  });

  it("rejects another user's vault", async () => {
    const mine = await mk(ana, 'Mine'), theirs = await mk(ben, 'Theirs');
    const res = await ana.put('/vaults/order', { ids: [mine, theirs] });
    expect(res.status).toBe(404);
    expect(names(await ana.get('/vaults'))).toEqual(['Mine']);
  });

  it('rejects a team vault from the personal context and from a non-member', async () => {
    const t = await mk(ana, 'T', `?team_id=${teamId}`);
    expect((await ana.put('/vaults/order', { ids: [t] })).status).toBe(404);
    expect((await outsider.put(`/vaults/order?team_id=${teamId}`, { ids: [t] })).status).toBe(403);
  });

  it('rejects a team vault id sent under a different team context', async () => {
    const other = (await ana.post('/teams', { name: 'Other' })).body.id;
    const t = await mk(ana, 'T', `?team_id=${teamId}`);
    expect((await ana.put(`/vaults/order?team_id=${other}`, { ids: [t] })).status).toBe(404);
  });

  it('validates the body and ignores deleted vaults', async () => {
    const a = await mk(ana, 'A');
    expect((await ana.put('/vaults/order', {})).status).toBe(400);
    expect((await ana.put('/vaults/order', { ids: ['1'] })).status).toBe(400);
    expect((await ana.put('/vaults/order', { ids: [a, a] })).status).toBe(400);
    expect((await ana.put('/vaults/order', { ids: [9999] })).status).toBe(404);
    await ana.del(`/vaults/${a}`);
    expect((await ana.put('/vaults/order', { ids: [a] })).status).toBe(404);
  });

  it('does not collide with GET /vaults/:id', async () => {
    expect((await ana.get('/vaults/order')).status).not.toBe(204);
  });
});
