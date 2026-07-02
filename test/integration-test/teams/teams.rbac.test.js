'use strict';
/**
 * Integration — team RBAC (ADR-005): the two gates in src/lib/access.js plus
 * owner-only team management and the membership check in resolveContext.
 * Roles: guest read-only; member writes only own rows; owner full access.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let owner, member, guest, outsider, ownerId, teamId, inTeam;

beforeEach(async () => {
  wipeAll();
  // AUTOINCREMENT ids keep growing across wipes — capture them, never assume.
  ownerId = seedUser('owner@test.local', 'secret123');
  for (const name of ['member', 'guest', 'outsider']) {
    seedUser(`${name}@test.local`, 'secret123');
  }
  owner    = api(await login('owner@test.local', 'secret123'));
  member   = api(await login('member@test.local', 'secret123'));
  guest    = api(await login('guest@test.local', 'secret123'));
  outsider = api(await login('outsider@test.local', 'secret123'));

  teamId = (await owner.post('/teams', { name: 'Household' })).body.id;
  await owner.post(`/teams/${teamId}/members`, { email: 'member@test.local', role: 'member' });
  await owner.post(`/teams/${teamId}/members`, { email: 'guest@test.local', role: 'guest' });
  inTeam = (path) => `${path}?team_id=${teamId}`;
});

afterAll(wipeAll);

describe('context membership (resolveContext)', () => {
  it('rejects a non-member targeting the team', async () => {
    const res = await outsider.get(inTeam('/transactions'));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Not a member of this team' });
  });

  it('404s an unknown team', async () => {
    expect((await owner.get('/transactions?team_id=9999')).status).toBe(404);
  });
});

describe('gate 1 — capability', () => {
  it('lets every role read team rows', async () => {
    await member.post(inTeam('/transactions'), { type: 'income', amount: 10 });
    for (const who of [owner, member, guest]) {
      const res = await who.get(inTeam('/transactions'));
      expect(res.status).toBe(200);
      expect(res.body).toHaveLength(1);
    }
  });

  it('denies guest writes with 403', async () => {
    const res = await guest.post(inTeam('/transactions'), { type: 'income', amount: 10 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Guests have read-only access' });
  });
});

describe('gate 2 — row ownership', () => {
  let ownerRow, memberRow;
  beforeEach(async () => {
    ownerRow  = (await owner.post(inTeam('/transactions'),  { type: 'income', amount: 100 })).body;
    memberRow = (await member.post(inTeam('/transactions'), { type: 'income', amount: 50 })).body;
  });

  it('a member mutates only rows they created', async () => {
    expect((await member.put(inTeam(`/transactions/${memberRow.id}`), { amount: 60 })).status).toBe(200);
    const res = await member.put(inTeam(`/transactions/${ownerRow.id}`), { amount: 60 });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Members can only modify records they created' });
    expect((await member.del(inTeam(`/transactions/${ownerRow.id}`))).status).toBe(403);
  });

  it('an owner mutates any row', async () => {
    expect((await owner.put(inTeam(`/transactions/${memberRow.id}`), { amount: 70 })).status).toBe(200);
    expect((await owner.del(inTeam(`/transactions/${memberRow.id}`))).status).toBe(204);
  });
});

describe('team management is owner-only by role', () => {
  it('denies rename/member-management to non-owners', async () => {
    expect((await member.put(`/teams/${teamId}`, { name: 'Nope' })).status).toBe(403);
    expect((await guest.put(`/teams/${teamId}`, { color: '#DC2626' })).status).toBe(403);
    expect((await member.post(`/teams/${teamId}/members`,
      { email: 'outsider@test.local' })).status).toBe(403);
  });

  it('hides the team from complete strangers (404, not 403)', async () => {
    expect((await outsider.put(`/teams/${teamId}`, { name: 'Nope' })).status).toBe(404);
  });

  it('cannot demote or remove the last owner', async () => {
    const demote = await owner.put(`/teams/${teamId}/members/${ownerId}`, { role: 'member' });
    expect(demote.status).toBe(400);
    expect(demote.body).toEqual({ error: 'Cannot demote the last owner' });
    const remove = await owner.del(`/teams/${teamId}/members/${ownerId}`);
    expect(remove.status).toBe(400);
    expect(remove.body).toEqual({ error: 'Cannot remove the last owner' });
  });

  it('blocks deleting a team that still holds data', async () => {
    await member.post(inTeam('/transactions'), { type: 'income', amount: 10 });
    const res = await owner.del(`/teams/${teamId}`);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Cannot delete a team with active transactions or vaults' });
  });
});

describe('personal context stays isolated', () => {
  it('team rows never leak into personal listings and vice versa', async () => {
    await member.post(inTeam('/transactions'), { type: 'income', amount: 10 });
    await member.post('/transactions', { type: 'income', amount: 99 });

    const personal = await member.get('/transactions');
    expect(personal.body).toHaveLength(1);
    expect(personal.body[0].amount).toBe(99);

    const team = await member.get(inTeam('/transactions'));
    expect(team.body).toHaveLength(1);
    expect(team.body[0].amount).toBe(10);
  });
});
