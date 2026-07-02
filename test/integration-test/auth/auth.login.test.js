'use strict';
/**
 * Integration — POST /auth/login, the auth middleware, and POST /auth/logout.
 * Validates: token issuance, generic 401 on bad credentials, 400 on missing
 * fields, 401 without a token, and real session revocation on logout.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { app, request, login, api } = require('../../helpers/api');

beforeEach(() => {
  wipeAll();
  seedUser('ana@test.local', 'secret123');
});

afterAll(wipeAll);

describe('POST /auth/login', () => {
  it('returns a token for valid credentials', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'ana@test.local', password: 'secret123' });
    expect(res.status).toBe(200);
    expect(typeof res.body.token).toBe('string');
  });

  it('rejects a wrong password with a generic 401', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'ana@test.local', password: 'nope' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('rejects an unknown email with the same generic 401', async () => {
    const res = await request(app).post('/auth/login')
      .send({ email: 'ghost@test.local', password: 'secret123' });
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('rejects missing fields with 400', async () => {
    const res = await request(app).post('/auth/login').send({ email: 'ana@test.local' });
    expect(res.status).toBe(400);
  });
});

describe('auth middleware + logout', () => {
  it('rejects protected routes without a token', async () => {
    expect((await request(app).get('/teams')).status).toBe(401);
    expect((await request(app).get('/balance')).status).toBe(401);
  });

  it('revokes the session on logout — the token stops working', async () => {
    const token = await login('ana@test.local', 'secret123');
    expect((await api(token).get('/teams')).status).toBe(200);
    expect((await api(token).post('/auth/logout')).status).toBe(204);
    expect((await api(token).get('/teams')).status).toBe(401);
  });
});
