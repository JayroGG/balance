'use strict';
/** Integration — GET/PATCH /users/me (ADR-019): own row only, color validation, null reset, 401. */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api, request, app } = require('../../helpers/api');

let alice; let bob;

beforeEach(async () => {
  wipeAll();
  seedUser('alice@test.local', 'secret123');
  seedUser('bob@test.local', 'secret123');
  alice = api(await login('alice@test.local', 'secret123'));
  bob = api(await login('bob@test.local', 'secret123'));
});

afterAll(wipeAll);

const patch = (token, body) =>
  request(app).patch('/users/me').set('Authorization', `Bearer ${token}`).send(body);

describe('GET /users/me', () => {
  it('returns id, email and null color by default', async () => {
    const res = await alice.get('/users/me');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ id: expect.any(Number), email: 'alice@test.local', color: null });
  });

  it('is 401 without a token', async () => {
    expect((await request(app).get('/users/me')).status).toBe(401);
  });
});

describe('PATCH /users/me', () => {
  const tokenOf = async (email) => (await login(email, 'secret123'));

  it('sets and normalizes color, persisted on GET', async () => {
    const res = await patch(await tokenOf('alice@test.local'), { color: '7c3aed' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('#7C3AED');
    expect((await alice.get('/users/me')).body.color).toBe('#7C3AED');
  });

  it('null resets the color', async () => {
    const t = await tokenOf('alice@test.local');
    await patch(t, { color: '#DC2626' });
    const res = await patch(t, { color: null });
    expect(res.status).toBe(200);
    expect(res.body.color).toBeNull();
  });

  it('rejects an invalid color with the team error shape', async () => {
    const res = await patch(await tokenOf('alice@test.local'), { color: 'purple' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'color must be a hex color like #RRGGBB' });
  });

  it('rejects a missing color key with 400', async () => {
    expect((await patch(await tokenOf('alice@test.local'), {})).status).toBe(400);
  });

  it('only touches the caller own row', async () => {
    await patch(await tokenOf('alice@test.local'), { color: '#00FF00' });
    expect((await bob.get('/users/me')).body.color).toBeNull();
  });

  it('ignores ?user_id= (even for an admin) and body id/email', async () => {
    seedUser('root@test.local', 'secret123', 'admin');
    const admin = await tokenOf('root@test.local');
    const bobId = (await bob.get('/users/me')).body.id;
    const res = await request(app).patch(`/users/me?user_id=${bobId}`)
      .set('Authorization', `Bearer ${admin}`).send({ color: '#112233', id: bobId, email: 'x@y.z' });
    expect(res.status).toBe(200);
    expect(res.body.email).toBe('root@test.local');
    expect((await bob.get('/users/me')).body.color).toBeNull();
  });

  it('rejects a non-string color with 400', async () => {
    expect((await patch(await tokenOf('alice@test.local'), { color: 123 })).status).toBe(400);
  });

  it('is 401 without a token', async () => {
    expect((await request(app).patch('/users/me').send({ color: '#00FF00' })).status).toBe(401);
  });
});
