'use strict';
/**
 * Integration — inter-context transfers (ADR-017) + step-up auth (ADR-018).
 *
 * Start: Personal available 1,000; vaults Ahorro 500, Viaje 300 (net worth 1,800). Team Casa available 200.
 *  A. 1,500 Personal -> Casa, short 500, split Ahorro 300 + Viaje 200 -> Personal 0 / 200 / 100 / net 300;
 *     Casa available 1,700 net 1,700; income/expense totals unchanged.
 *  B. 2,000 from the start state -> blocked (1,000 + 800 < 2,000).
 *  C. After A, Casa spends 1,000 (700 left) -> reversal blocked.
 *  D. After A, reversal restores the start state; both rows listed on each side; reversing again rejected.
 *  E. Member/guest of Casa and a non-owner admin: 403.
 *  F. No / reused permit -> 403 STEP_UP_REQUIRED.
 */
const { wipeAll, seedUser, db } = require('../../helpers/db');
const { request, app, login, api } = require('../../helpers/api');

let me; let tokens; let casa; let ahorro; let viaje;

const bearer = (t) => ({ Authorization: `Bearer ${t}` });
const permit = async (token, password = 'secret123') =>
  (await request(app).post('/auth/step-up').set(bearer(token)).send({ password })).body.permit;
const post = (token, url, body, p) => {
  const r = request(app).post(url).set(bearer(token));
  return (p ? r.set('X-Step-Up', p) : r).send(body);
};
const transfer = async (body, { token = tokens.me, ctx = '', p } = {}) =>
  post(token, `/transfers${ctx}`, body, p === undefined ? await permit(token) : p);
const reverse = async (id, { token = tokens.me, p } = {}) =>
  post(token, `/transfers/${id}/reverse`, {}, p === undefined ? await permit(token) : p);
const bal = async (q = '') => (await me.get(`/balance${q}`)).body;
const vaultBal = (b, name) => b.vaults.find((v) => v.name === name).balance;
const txs = async (q = '') => (await me.get(`/transactions${q}`)).body;
const teamQ = () => `?team_id=${casa}`;
const events = async (q = '') => (await me.get(`/events${q}`)).body;

beforeEach(async () => {
  wipeAll();
  seedUser('jaxjayro@test.local', 'secret123');
  seedUser('member@test.local', 'secret123');
  seedUser('guest@test.local', 'secret123');
  seedUser('boss@test.local', 'secret123', 'admin');
  tokens = {
    me: await login('jaxjayro@test.local', 'secret123'),
    member: await login('member@test.local', 'secret123'),
    guest: await login('guest@test.local', 'secret123'),
    admin: await login('boss@test.local', 'secret123'),
  };
  me = api(tokens.me);
  casa = (await me.post('/teams', { name: 'Casa' })).body.id;
  const uid = (e) => db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;
  db.prepare(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'member'), (?, ?, 'guest')`)
    .run(casa, uid('member@test.local'), casa, uid('guest@test.local'));

  await me.post('/transactions', { type: 'income', amount: 1800 });
  ahorro = (await me.post('/vaults', { name: 'Ahorro' })).body.id;
  viaje = (await me.post('/vaults', { name: 'Viaje' })).body.id;
  await me.post(`/vaults/${ahorro}/allocate`, { amount: 500 });
  await me.post(`/vaults/${viaje}/allocate`, { amount: 300 });
  await me.post(`/transactions${teamQ()}`, { type: 'income', amount: 200 });
});

const scenarioA = () => transfer({ to_team_id: casa, amount: 1500, vaults: [
  { vault_id: ahorro, amount: 300 }, { vault_id: viaje, amount: 200 }] });

describe('A — transfer with a vault split', () => {
  it('moves 1,500 Personal -> Casa with exact figures', async () => {
    expect((await bal()).available).toBe(1000);
    expect((await bal()).total).toBe(1800);
    const before = (await txs()).totals;

    const res = await scenarioA();
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ amount: 1500, from_team_id: null, to_team_id: casa, reversal_of: null, reversed_by: null,
      from_label: 'jaxjayro (personal)', to_label: 'Casa' });
    expect(res.body.vaults.map((v) => [v.vault_name, v.action, v.amount])).toEqual([['Ahorro', 'withdraw', 300], ['Viaje', 'withdraw', 200]]);

    const p = await bal();
    expect([p.available, vaultBal(p, 'Ahorro'), vaultBal(p, 'Viaje'), p.total]).toEqual([0, 200, 100, 300]);
    const c = await bal(teamQ());
    expect([c.available, c.total]).toEqual([1700, 1700]);

    const pt = await txs();
    expect(pt.totals.income).toBe(before.income);
    expect(pt.totals.expense).toBe(before.expense);
    const out = pt.items.find((i) => i.type === 'transfer_out');
    expect(out).toMatchObject({ amount: 1500, counterpart_label: 'Casa', transfer_id: res.body.id, reversal_of: null });
    const ct = await txs(`?team_id=${casa}`);
    expect(ct.totals).toMatchObject({ income: 200, expense: 0 });
    expect(ct.items.find((i) => i.type === 'transfer_in'))
      .toMatchObject({ amount: 1500, counterpart_label: 'jaxjayro (personal)', transfer_id: res.body.id });
    expect((await txs('?type=transfer_in')).items).toHaveLength(0);
  });

  it('logs sent/received events in each context and vault withdrawals', async () => {
    await scenarioA();
    const pe = await events();
    const sent = pe.find((e) => e.entity === 'transfer' && e.action === 'sent');
    expect(sent.summary).toMatchObject({ amount: 1500, counterpart: 'Casa' });
    expect(pe.filter((e) => e.entity === 'vault' && e.action === 'withdrawn')).toHaveLength(2);
    const ce = await events(`?team_id=${casa}`);
    expect(ce.find((e) => e.entity === 'transfer' && e.action === 'received').summary)
      .toMatchObject({ amount: 1500, counterpart: 'jaxjayro (personal)' });
  });

  it('lists the transfer from both sides (GET /transfers, /transfers/:id)', async () => {
    const { body } = await scenarioA();
    expect((await me.get('/transfers')).body.map((t) => t.id)).toEqual([body.id]);
    expect((await me.get(`/transfers?team_id=${casa}`)).body.map((t) => t.id)).toEqual([body.id]);
    expect((await me.get(`/transfers/${body.id}`)).body.vaults).toHaveLength(2);
    expect((await me.get(`/transfers/${body.id}?team_id=${casa}`)).body.vaults).toEqual([]); // source vaults stay private
    // a member (any role) of the destination may read it
    expect((await api(tokens.member).get(`/transfers/${body.id}?team_id=${casa}`)).status).toBe(200);
    expect((await api(tokens.member).get(`/transfers/${body.id}`)).status).toBe(404);
  });

  it('rejects vaults when available already covers the amount, and wrong splits', async () => {
    expect((await transfer({ to_team_id: casa, amount: 400, vaults: [{ vault_id: ahorro, amount: 100 }] })).status).toBe(400);
    expect((await transfer({ to_team_id: casa, amount: 1500, vaults: [{ vault_id: ahorro, amount: 300 }] })).status).toBe(400); // sum short
    expect((await transfer({ to_team_id: casa, amount: 1500, vaults: [{ vault_id: ahorro, amount: 600 }] })).status).toBe(400); // > balance
    expect((await transfer({ to_team_id: casa, amount: 1500, vaults: [
      { vault_id: ahorro, amount: 250 }, { vault_id: ahorro, amount: 250 }] })).status).toBe(400); // repeat
    expect((await transfer({ to_team_id: casa, amount: 1500 })).status).toBe(400); // short, no vaults
    expect((await bal()).available).toBe(1000); // nothing moved
  });

  it('validates the body and rejects same-context / personal->personal', async () => {
    expect((await transfer({ amount: 5 })).status).toBe(400);
    expect((await transfer({ to_team_id: casa, amount: -5 })).status).toBe(400);
    expect((await transfer({ to_team_id: casa, amount: 5, occurred_at: '2026-13-40' })).status).toBe(400);
    expect((await transfer({ to_team_id: null, amount: 5 })).status).toBe(400);
    expect((await transfer({ to_team_id: casa, amount: 5 }, { ctx: teamQ() })).status).toBe(400);
  });

  it('backdates with occurred_at and moves team -> personal', async () => {
    const res = await transfer({ to_team_id: null, amount: 50, occurred_at: '2026-01-02' }, { ctx: teamQ() });
    expect(res.status).toBe(201);
    expect((await bal(teamQ())).available).toBe(150);
    expect((await bal()).available).toBe(1050);
    expect(res.body).toMatchObject({ occurred_at: '2026-01-02', from_label: 'Casa', to_label: 'jaxjayro (personal)' });
  });

  it('moves team -> team', async () => {
    const other = (await me.post('/teams', { name: 'Oficina' })).body.id;
    expect((await transfer({ to_team_id: other, amount: 80 }, { ctx: teamQ() })).status).toBe(201);
    expect((await bal(teamQ())).available).toBe(120);
    expect((await bal(`?team_id=${other}`)).available).toBe(80);
  });
});

describe('B — blocked when nothing can cover it', () => {
  it('2,000 > 1,000 available + 800 in vaults', async () => {
    const res = await transfer({ to_team_id: casa, amount: 2000, vaults: [
      { vault_id: ahorro, amount: 500 }, { vault_id: viaje, amount: 300 }] });
    expect(res.status).toBe(400);
    const p = await bal();
    expect([p.available, p.total]).toEqual([1000, 1800]);
    expect((await bal(teamQ())).available).toBe(200);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n).toBe(0);
  });
});

describe('C — reversal blocked once the destination spent the money', () => {
  it('700 < 1,500', async () => {
    const { body } = await scenarioA();
    await me.post(`/transactions${teamQ()}`, { type: 'expense', amount: 1000 });
    expect((await bal(teamQ())).available).toBe(700);
    const res = await reverse(body.id);
    expect(res.status).toBe(400);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n).toBe(1);
    expect((await bal(teamQ())).available).toBe(700);
  });
});

describe('D — reversal (devolución)', () => {
  it('restores the start state and lists both rows on each side', async () => {
    const { body } = await scenarioA();
    const res = await reverse(body.id);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ reversal_of: body.id, from_team_id: casa, to_team_id: null, amount: 1500 });

    const p = await bal();
    expect([p.available, vaultBal(p, 'Ahorro'), vaultBal(p, 'Viaje'), p.total]).toEqual([1000, 500, 300, 1800]);
    expect((await bal(teamQ())).available).toBe(200);

    const pi = (await txs()).items.filter((i) => i.transfer_id != null).map((i) => [i.type, i.amount, i.counterpart_label, i.reversal_of]);
    expect(pi).toEqual(expect.arrayContaining([
      ['transfer_out', 1500, 'Casa', null],
      ['transfer_in', 1500, 'Casa', body.id],
    ]));
    expect(pi).toHaveLength(2);
    const ci = (await txs(`?team_id=${casa}`)).items.filter((i) => i.transfer_id != null).map((i) => [i.type, i.amount, i.counterpart_label, i.reversal_of]);
    expect(ci).toEqual(expect.arrayContaining([
      ['transfer_in', 1500, 'jaxjayro (personal)', null],
      ['transfer_out', 1500, 'jaxjayro (personal)', body.id],
    ]));
    expect(ci).toHaveLength(2);

    expect((await me.get(`/transfers/${body.id}`)).body.reversed_by).toBe(res.body.id);
    const ev = (await events()).filter((e) => e.entity === 'transfer').map((e) => e.action);
    expect(ev).toEqual(expect.arrayContaining(['sent', 'reversed']));
    expect((await events(`?team_id=${casa}`)).filter((e) => e.action === 'reversed')).toHaveLength(1);
    // transfers are append-only: nothing was removed
    expect(db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n).toBe(2);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transactions WHERE deleted_at IS NOT NULL').get().n).toBe(0);
  });

  it('dates the reversal today and filters by transfer type', async () => {
    const { body } = await scenarioA();
    const rev = await reverse(body.id);
    expect(rev.body.occurred_at).toBe(new Date().toISOString().slice(0, 10));
    expect((await txs('?type=transfer_out')).items.map((i) => i.reversal_of)).toEqual([null]);
    expect((await txs('?type=transfer_in')).items.map((i) => i.reversal_of)).toEqual([body.id]);
  });

  it('rejects reversing twice and reversing a reversal', async () => {
    const { body } = await scenarioA();
    const rev = await reverse(body.id);
    expect((await reverse(body.id)).status).toBe(400);
    expect((await reverse(rev.body.id)).status).toBe(400);
    expect((await reverse(9999)).status).toBe(404);
  });

  it('a deleted vault keeps its share in available', async () => {
    const { body } = await scenarioA();
    await me.post(`/vaults/${viaje}/withdraw`, { amount: 100 });
    await me.del(`/vaults/${viaje}`);
    await reverse(body.id);
    const p = await bal();
    expect(p.vaults.map((v) => v.name)).toEqual(['Ahorro']);
    expect([p.available, vaultBal(p, 'Ahorro')]).toEqual([1300, 500]); // 100 + 1,500 back - Ahorro's 300 part; Viaje's share stays in available
  });

  it('a co-owner cannot reverse a transfer out of someone else\'s personal context', async () => {
    const uid = db.prepare('SELECT id FROM users WHERE email = ?').get('member@test.local').id;
    db.prepare(`UPDATE team_members SET role = 'owner' WHERE team_id = ? AND user_id = ?`).run(casa, uid);
    const { body } = await scenarioA();
    expect((await reverse(body.id, { token: tokens.member })).status).toBe(403); // owns Casa, not the personal side
    expect((await bal()).available).toBe(0);
  });
});

describe('E — authorization (no admin bypass)', () => {
  it('member and guest of Casa cannot transfer out of or into it', async () => {
    for (const t of [tokens.member, tokens.guest]) {
      expect((await transfer({ to_team_id: null, amount: 10 }, { token: t, ctx: teamQ() })).status).toBe(403);
      expect((await transfer({ to_team_id: casa, amount: 10 }, { token: t })).status).toBe(403);
    }
    expect((await bal(teamQ())).available).toBe(200);
  });

  it('members cannot reverse', async () => {
    const { body } = await scenarioA();
    expect((await reverse(body.id, { token: tokens.member })).status).toBe(403);
    expect((await reverse(body.id, { token: tokens.guest })).status).toBe(403);
  });

  it('a non-member cannot even see the team', async () => {
    const out = seedUser('out@test.local', 'secret123');
    expect(out).toBeTruthy();
    const t = await login('out@test.local', 'secret123');
    expect((await transfer({ to_team_id: null, amount: 10 }, { token: t, ctx: teamQ() })).status).toBe(403);
    expect((await transfer({ to_team_id: casa, amount: 10 }, { token: t })).status).toBe(403);
    expect((await transfer({ to_team_id: 99999, amount: 10 }, { token: t })).status).toBe(403);
  });

  it('a global admin who is not an owner gets 403, and ?user_id= is rejected', async () => {
    const a = tokens.admin;
    await api(a).post('/transactions', { type: 'income', amount: 500 });
    expect((await transfer({ to_team_id: casa, amount: 10 }, { token: a })).status).toBe(403);
    expect((await transfer({ to_team_id: null, amount: 10 }, { token: a, ctx: teamQ() })).status).toBe(403);
    const uid = db.prepare('SELECT id FROM users WHERE email = ?').get('jaxjayro@test.local').id;
    expect((await transfer({ to_team_id: casa, amount: 10 }, { token: a, ctx: `?user_id=${uid}` })).status).toBe(403);
    const { body } = await scenarioA();
    expect((await reverse(body.id, { token: a })).status).toBe(404); // no relation to either side: indistinguishable from a missing id
    expect(db.prepare('SELECT COUNT(*) AS n FROM transfers').get().n).toBe(1);
  });

  it('an admin who is a real owner may transfer, and /teams exposes the real role', async () => {
    const uid = db.prepare('SELECT id FROM users WHERE email = ?').get('boss@test.local').id;
    db.prepare(`INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, 'owner')`).run(casa, uid);
    const a = api(tokens.admin);
    await a.post('/transactions', { type: 'income', amount: 500 });
    expect((await transfer({ to_team_id: casa, amount: 10 }, { token: tokens.admin })).status).toBe(201);
    const teams = (await a.get('/teams')).body;
    expect(teams.find((t) => t.id === casa).role).toBe('owner');
  });

  it('admin listAll keeps role "admin" for teams without membership', async () => {
    const teams = (await api(tokens.admin).get('/teams')).body;
    expect(teams.find((t) => t.id === casa).role).toBe('admin');
  });

  it('transfer rows are read-only via /transactions', async () => {
    const { body } = await scenarioA();
    const rows = db.prepare('SELECT id FROM transactions WHERE transfer_id = ?').all(body.id);
    for (const { id } of rows) {
      const qs = db.prepare('SELECT team_id FROM transactions WHERE id = ?').get(id).team_id ? teamQ() : '';
      expect((await me.put(`/transactions/${id}${qs}`, { amount: 1 })).status).toBe(400);
      expect((await me.del(`/transactions/${id}${qs}`)).status).toBe(400);
    }
    expect((await me.post('/transactions', { type: 'transfer_in', amount: 5 })).status).toBe(400);
    expect((await bal()).total).toBe(300);
  });
});

describe('F — step-up permit', () => {
  it('rejects a missing, bogus, reused, expired or foreign permit with STEP_UP_REQUIRED', async () => {
    const body = { to_team_id: casa, amount: 10 };
    const none = await transfer(body, { p: null });
    expect(none.status).toBe(403);
    expect(none.body.code).toBe('STEP_UP_REQUIRED');
    expect((await transfer(body, { p: 'nope' })).body.code).toBe('STEP_UP_REQUIRED');

    const p = await permit(tokens.me);
    expect((await transfer(body, { p })).status).toBe(201);
    const reused = await transfer(body, { p });
    expect(reused.status).toBe(403);
    expect(reused.body.code).toBe('STEP_UP_REQUIRED');

    const old = await permit(tokens.me);
    db.prepare(`UPDATE step_up_permits SET expires_at = '2000-01-01T00:00:00.000Z'`).run();
    expect((await transfer(body, { p: old })).body.code).toBe('STEP_UP_REQUIRED');

    const other = await permit(tokens.member);
    expect((await transfer(body, { p: other })).body.code).toBe('STEP_UP_REQUIRED');
  });

  it('a permit survives a rejected action (rollback) but not a successful one', async () => {
    const p = await permit(tokens.me);
    expect((await transfer({ to_team_id: casa, amount: 99999 }, { p })).status).toBe(400);
    expect((await transfer({ to_team_id: casa, amount: 10 }, { p })).status).toBe(201);
    expect((await transfer({ to_team_id: casa, amount: 10 }, { p })).status).toBe(403);
  });

  it('the reverse endpoint requires a permit too', async () => {
    const { body } = await scenarioA();
    const res = await reverse(body.id, { p: null });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('STEP_UP_REQUIRED');
  });

  it('POST /auth/step-up: wrong password 401, missing 400, stores only a hash', async () => {
    expect((await request(app).post('/auth/step-up').set(bearer(tokens.me)).send({ password: 'bad' })).status).toBe(401);
    expect((await request(app).post('/auth/step-up').set(bearer(tokens.me)).send({})).status).toBe(400);
    expect((await request(app).post('/auth/step-up').send({ password: 'secret123' })).status).toBe(401);
    const res = await request(app).post('/auth/step-up').set(bearer(tokens.me)).send({ password: 'secret123' });
    expect(res.status).toBe(200);
    expect(new Date(res.body.expires_at) > new Date()).toBe(true);
    expect(db.prepare('SELECT token_hash FROM step_up_permits').get().token_hash).not.toBe(res.body.permit);
  });
});
