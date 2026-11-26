'use strict';
/**
 * Integration — POST /auth/refresh (ADR-015): login shape, rotation, reuse detection,
 * expiry, revocation, inactive users, and logout killing the refresh token.
 */
const { db, wipeAll, seedUser } = require('../../helpers/db');
const { app, request, api } = require('../../helpers/api');

const loginFull = async () => {
  const res = await request(app).post('/auth/login').send({ email: 'ana@test.local', password: 'secret123' });
  return res.body;
};
const refresh = (refreshToken) => request(app).post('/auth/refresh').send({ refreshToken });

let userId;
beforeEach(() => {
  wipeAll();
  userId = seedUser('ana@test.local', 'secret123');
});
afterAll(wipeAll);

describe('login shape', () => {
  it('returns token + refreshToken and stores only a hash', async () => {
    const body = await loginFull();
    expect(typeof body.token).toBe('string');
    expect(typeof body.refreshToken).toBe('string');
    const row = db.prepare(`SELECT * FROM sessions WHERE user_id = ?`).get(userId);
    expect(row.refresh_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(Object.values(row)).not.toContain(body.refreshToken);
    expect(row.expires_at).toBe(row.refresh_expires_at);
  });
});

describe('POST /auth/refresh', () => {
  it('rotates: new pair works, old refresh token is dead', async () => {
    const first = await loginFull();
    const res = await refresh(first.refreshToken);
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).not.toBe(first.refreshToken);
    expect((await api(res.body.token).get('/teams')).status).toBe(200);
    // same session (jti) before and after
    const jti = (t) => JSON.parse(Buffer.from(t.split('.')[1], 'base64url')).jti;
    expect(jti(res.body.token)).toBe(jti(first.token));
    expect((await refresh(res.body.refreshToken)).status).toBe(200);
  });

  it('reuse of a rotated token revokes the session (both tokens dead)', async () => {
    const first = await loginFull();
    const second = (await refresh(first.refreshToken)).body;
    const replay = await refresh(first.refreshToken);
    expect(replay.status).toBe(401);
    expect((await refresh(second.refreshToken)).status).toBe(401);
    expect((await api(second.token).get('/teams')).status).toBe(401);
  });

  it('rejects an expired refresh token', async () => {
    const first = await loginFull();
    db.prepare(`UPDATE sessions SET refresh_expires_at = '2000-01-01T00:00:00Z'`).run();
    expect((await refresh(first.refreshToken)).status).toBe(401);
  });

  it('rejects a revoked session', async () => {
    const first = await loginFull();
    db.prepare(`UPDATE sessions SET revoked_at = '2020-01-01T00:00:00Z'`).run();
    expect((await refresh(first.refreshToken)).status).toBe(401);
  });

  it('rejects an inactive or unverified user', async () => {
    const first = await loginFull();
    db.prepare(`UPDATE users SET active = 0 WHERE id = ?`).run(userId);
    expect((await refresh(first.refreshToken)).status).toBe(401);
    db.prepare(`UPDATE users SET active = 1, verified = 0 WHERE id = ?`).run(userId);
    expect((await refresh(first.refreshToken)).status).toBe(401);
  });

  it('logout kills the refresh token', async () => {
    const first = await loginFull();
    await api(first.token).post('/auth/logout');
    expect((await refresh(first.refreshToken)).status).toBe(401);
  });

  it('400 when missing, 401 for garbage or non-string', async () => {
    expect((await request(app).post('/auth/refresh').send({})).status).toBe(400);
    expect((await refresh('nope')).status).toBe(401);
    expect((await refresh({ $ne: 1 })).status).toBe(401);
  });

  it('a refresh token never works as an access token', async () => {
    const first = await loginFull();
    expect((await api(first.refreshToken).get('/teams')).status).toBe(401);
  });
});
