'use strict';
/**
 * Integration — auto-capture ingest pipeline (docs/react-native-auto-capture-request.md):
 * exact hash dedup -> alias match -> ±5 min cross-channel dedup -> auto-post into
 * the source's routed context; unresolved evidence stays pending for the review
 * inbox; ingest-scoped automation tokens may only POST /captures.
 */
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let u; // primary user, funded with 1000 personal income

const nuSetup = async () => {
  const src = (await u.post('/payment-sources', { name: 'Nu account', type: 'account', bank: 'nu' })).body;
  await u.post('/source-aliases', { source_id: src.id, channel: 'google_wallet', match_kind: 'card_last4', value: '0347' });
  await u.post('/source-aliases', { source_id: src.id, channel: 'nu_app', match_kind: 'card_last4', value: '0347' });
  await u.post('/source-aliases', { source_id: src.id, channel: 'nu_app', match_kind: 'channel_default' });
  return src;
};

const capture = (over = {}) => ({
  channel: 'google_wallet', kind: 'purchase', direction: 'out', amount: 129.5,
  merchant_raw: 'OXXO', last4: '0347', captured_at: '2026-07-02T18:03:00Z',
  notification_hash: 'h1', ...over,
});

beforeEach(async () => {
  wipeAll();
  seedUser('u@test.local', 'secret123');
  u = api(await login('u@test.local', 'secret123'));
  await u.post('/transactions', { type: 'income', amount: 1000 });
});

afterAll(wipeAll);

describe('alias invariants', () => {
  it('rejects a foreign source, a bad last4, and a second channel_default', async () => {
    const src = await nuSetup();
    expect((await u.post('/source-aliases',
      { source_id: 9999, channel: 'x', match_kind: 'card_last4', value: '1234' })).status).toBe(400);
    expect((await u.post('/source-aliases',
      { source_id: src.id, channel: 'x', match_kind: 'card_last4', value: '12a4' })).status).toBe(400);

    const res = await u.post('/source-aliases', { source_id: src.id, channel: 'nu_app', match_kind: 'channel_default' });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'channel already has a default alias' });
  });

  it('soft-deleting a source cascades to its aliases', async () => {
    const src = await nuSetup();
    await u.del(`/payment-sources/${src.id}`);
    expect((await u.get('/source-aliases')).body).toHaveLength(0);
  });
});

describe('ingest pipeline', () => {
  it('auto-posts a wallet purchase as a personal expense and moves the balance', async () => {
    await nuSetup();
    const res = await u.post('/captures', capture());
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('posted');
    expect(res.body.transaction_id).not.toBeNull();

    const tx = (await u.get(`/transactions/${res.body.transaction_id}`)).body;
    expect(tx).toMatchObject({ type: 'expense', amount: 129.5, description: 'OXXO', occurred_at: '2026-07-02' });
    expect(tx.capture_id).toBe(res.body.id);
    expect((await u.get('/balance')).body.total).toBe(870.5);
  });

  it('folds a bank re-report within the window into the wallet capture (duplicate)', async () => {
    await nuSetup();
    const first = (await u.post('/captures', capture())).body;
    const res = await u.post('/captures', capture({
      channel: 'nu_app', merchant_raw: 'Compra OXXO',
      captured_at: '2026-07-02T18:04:10Z', notification_hash: 'h2',
    }));
    expect(res.body.status).toBe('duplicate');
    expect(res.body.duplicate_of).toBe(first.id);
    expect((await u.get('/transactions')).body).toHaveLength(2); // seed income + one expense
  });

  it('posts the same-looking purchase outside the window as its own transaction', async () => {
    await nuSetup();
    await u.post('/captures', capture());
    const res = await u.post('/captures', capture({
      channel: 'nu_app', captured_at: '2026-07-02T18:20:00Z', notification_hash: 'h5',
    }));
    expect(res.body.status).toBe('posted');
    expect((await u.get('/balance')).body.total).toBe(741);
  });

  it('resolves a card-less push via channel_default and posts an income', async () => {
    await nuSetup();
    const res = await u.post('/captures', capture({
      channel: 'nu_app', kind: 'transfer', direction: 'in', amount: 500,
      merchant_raw: 'Transferencia de Karla', last4: undefined,
      captured_at: '2026-07-02T19:00:00Z', notification_hash: 'h3',
    }));
    expect(res.body.status).toBe('posted');
    expect((await u.get(`/transactions/${res.body.transaction_id}`)).body.type).toBe('income');
    expect((await u.get('/balance')).body.total).toBe(1500);
  });

  it('re-sending a notification_hash is an idempotent 200, no second transaction', async () => {
    await nuSetup();
    const first = (await u.post('/captures', capture())).body;
    const res = await u.post('/captures', capture());
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(first.id);
    expect((await u.get('/transactions')).body).toHaveLength(2);
  });

  it('applies the source default category on auto-post', async () => {
    const cat = (await u.post('/categories', { name: 'Card food', kind: 'expense' })).body;
    const src = (await u.post('/payment-sources',
      { name: 'Nu account', type: 'account', default_category_id: cat.id })).body;
    await u.post('/source-aliases', { source_id: src.id, channel: 'google_wallet', match_kind: 'card_last4', value: '0347' });

    const res = await u.post('/captures', capture());
    expect((await u.get(`/transactions/${res.body.transaction_id}`)).body.category_id).toBe(cat.id);
  });
});

describe('review inbox', () => {
  it('unknown card -> pending -> confirm posts it; then it leaves the inbox', async () => {
    const src = await nuSetup();
    const cap = (await u.post('/captures', capture({
      channel: 'apple_pay', amount: 80, last4: '9999', notification_hash: 'h4',
    }))).body;
    expect(cap.status).toBe('pending');
    expect((await u.get('/captures?status=pending')).body).toHaveLength(1);

    const res = await u.post(`/captures/${cap.id}/confirm`, { source_id: src.id });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('posted');
    expect((await u.get('/captures?status=pending')).body).toHaveLength(0);
    // once linked -> re-confirm 404s (no longer pending)
    expect((await u.post(`/captures/${cap.id}/confirm`, { source_id: src.id })).status).toBe(404);
  });

  it('confirm validates the source and hides foreign captures', async () => {
    seedUser('other@test.local', 'secret123');
    const other = api(await login('other@test.local', 'secret123'));
    const src = await nuSetup();
    const cap = (await u.post('/captures', capture({ channel: 'apple_pay', last4: '9999' }))).body;

    expect((await u.post(`/captures/${cap.id}/confirm`, {})).status).toBe(400);
    expect((await u.post(`/captures/${cap.id}/confirm`, { source_id: 9999 })).status).toBe(400);
    expect((await other.post(`/captures/${cap.id}/confirm`, { source_id: src.id })).status).toBe(404);
  });

  it('discard parks the evidence without posting', async () => {
    await nuSetup();
    const cap = (await u.post('/captures', capture({ channel: 'apple_pay', last4: '9999' }))).body;
    const res = await u.post(`/captures/${cap.id}/discard`);
    expect(res.body.status).toBe('discarded');
    expect((await u.get('/transactions')).body).toHaveLength(1); // just the seed income
  });
});

describe('routing to a team context', () => {
  it('posts through the source target_team_id with the team_id set', async () => {
    const teamId = (await u.post('/teams', { name: 'Empresa' })).body.id;
    await u.post(`/transactions?team_id=${teamId}`, { type: 'income', amount: 500 });
    const src = (await u.post('/payment-sources',
      { name: 'BBVA credit', type: 'credit_card', target_team_id: teamId })).body;
    await u.post('/source-aliases', { source_id: src.id, channel: 'google_wallet', match_kind: 'card_last4', value: '9134' });

    const res = await u.post('/captures', capture({ amount: 200, last4: '9134', notification_hash: 'ht1' }));
    expect(res.body.status).toBe('posted');

    const teamTxs = (await u.get(`/transactions?team_id=${teamId}`)).body;
    expect(teamTxs.filter((t) => t.capture_id)).toHaveLength(1);
    expect((await u.get(`/balance?team_id=${teamId}`)).body.total).toBe(300);
    expect((await u.get('/balance')).body.total).toBe(1000); // personal untouched
  });

  it('rejects creating a source routed to a team without write access', async () => {
    seedUser('boss@test.local', 'secret123');
    const boss = api(await login('boss@test.local', 'secret123'));
    const teamId = (await boss.post('/teams', { name: 'Their company' })).body.id;
    await boss.post(`/teams/${teamId}/members`, { email: 'u@test.local', role: 'guest' });

    const res = await u.post('/payment-sources', { name: 'X', type: 'account', target_team_id: teamId });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'target team must be one you can write to' });
  });
});

describe('auto-post fallback (ingest never 400s a well-formed capture)', () => {
  it('leaves a capture pending when the expense exceeds available', async () => {
    await nuSetup();
    const res = await u.post('/captures', capture({ amount: 99999, notification_hash: 'hbig' }));
    expect(res.status).toBe(201);
    expect(res.body.status).toBe('pending');
    expect((await u.get('/balance')).body.total).toBe(1000);
  });
});

describe('automation tokens', () => {
  it('mints an ingest token that can only POST /captures, and revokes it', async () => {
    await nuSetup();
    const minted = (await u.post('/auth/tokens', { name: 'iphone-shortcut' })).body;
    expect(minted.token).toBeDefined();
    const ingest = api(minted.token);

    expect((await ingest.post('/captures', capture())).status).toBe(201);
    expect((await ingest.get('/captures')).status).toBe(403);
    expect((await ingest.get('/transactions')).status).toBe(403);
    expect((await ingest.post('/auth/tokens', { name: 'evil' })).status).toBe(403);

    expect((await u.get('/auth/tokens')).body).toHaveLength(1);
    expect((await u.del(`/auth/tokens/${minted.id}`)).status).toBe(204);
    expect((await ingest.post('/captures', capture({ notification_hash: 'h9' }))).status).toBe(401);
    expect((await u.get('/auth/tokens')).body).toHaveLength(0);
  });
});
