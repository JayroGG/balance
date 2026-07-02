'use strict';
/**
 * Integration — team `color` contract (docs/react-native-team-color-update.md).
 * Validates: create with/without color, normalization, invalid → 400,
 * color-only PUT, null-clears, at-least-one-field PUT, color on list/detail.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let owner;

beforeEach(async () => {
  wipeAll();
  seedUser('owner@test.local', 'secret123');
  owner = api(await login('owner@test.local', 'secret123'));
});

afterAll(wipeAll);

describe('POST /teams with color', () => {
  it('accepts and normalizes a hash-less lowercase color', async () => {
    const res = await owner.post('/teams', { name: 'Design', color: '7c3aed' });
    expect(res.status).toBe(201);
    expect(res.body.color).toBe('#7C3AED');
  });

  it('stores null when color is omitted', async () => {
    const res = await owner.post('/teams', { name: 'Plain' });
    expect(res.status).toBe(201);
    expect(res.body.color).toBeNull();
  });

  it('rejects an invalid color with 400 and the exact error', async () => {
    const res = await owner.post('/teams', { name: 'Bad', color: 'purple' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'color must be a hex color like #RRGGBB' });
  });
});

describe('PUT /teams/:id with color', () => {
  let teamId;
  beforeEach(async () => {
    teamId = (await owner.post('/teams', { name: 'Design', color: '#7C3AED' })).body.id;
  });

  it('updates color alone without requiring name', async () => {
    const res = await owner.put(`/teams/${teamId}`, { color: '#dc2626' });
    expect(res.status).toBe(200);
    expect(res.body.color).toBe('#DC2626');
    expect(res.body.name).toBe('Design'); // untouched
  });

  it('updates name and color together', async () => {
    const res = await owner.put(`/teams/${teamId}`, { name: 'Design+', color: '00ff00' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ name: 'Design+', color: '#00FF00' });
  });

  it('clears the color with null', async () => {
    const res = await owner.put(`/teams/${teamId}`, { color: null });
    expect(res.status).toBe(200);
    expect(res.body.color).toBeNull();
  });

  it('rejects an empty body with 400', async () => {
    const res = await owner.put(`/teams/${teamId}`, {});
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Provide at least one field: name, color' });
  });

  it('rejects an invalid color with 400', async () => {
    const res = await owner.put(`/teams/${teamId}`, { color: '#ABC' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'color must be a hex color like #RRGGBB' });
  });

  it('still rejects an empty name with 400', async () => {
    const res = await owner.put(`/teams/${teamId}`, { name: '' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Missing required field: name' });
  });
});

describe('color flows through reads', () => {
  it('GET /teams and GET /teams/:id carry color', async () => {
    const { body: colored } = await owner.post('/teams', { name: 'Design', color: '7c3aed' });
    await owner.post('/teams', { name: 'Plain' });

    const list = await owner.get('/teams');
    expect(list.status).toBe(200);
    const byName = Object.fromEntries(list.body.map((t) => [t.name, t.color]));
    expect(byName).toEqual({ Design: '#7C3AED', Plain: null });

    const detail = await owner.get(`/teams/${colored.id}`);
    expect(detail.status).toBe(200);
    expect(detail.body.color).toBe('#7C3AED');
  });
});
