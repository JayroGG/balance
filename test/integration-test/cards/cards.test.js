'use strict';
/**
 * Integration — credit cards (ADR-014). A card charge is an expense with card_id: a spend (expense
 * totals, categories) that does NOT move cash; POST /cards/:id/pay books a card_payment that does,
 * and is not a spend. Statement figures are derived on read from a clock the tests pin.
 *
 * Scenario ("today" 2026-11-20): cash 10,000; card cut day 5, due day 25 -> last cut 2026-11-05,
 * due 2026-11-25. Charges 1,200 (11-02, before the cut) and 800 (11-10, open period).
 *   owed 2,000 | statement 1,200 due 11-25 | current 800 | available 10,000
 *   pay 500 -> available 9,500, owed 1,500, statement 700
 *   pay 700 -> available 8,800, owed 800,  statement 0
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const Database = require('better-sqlite3');
const { wipeAll, seedUser } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

// Pin only Date: timers/ticks stay real so supertest keeps working.
const setToday = (iso) => jest.useFakeTimers({
  now: new Date(`${iso}T12:00:00Z`),
  doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'requestAnimationFrame',
    'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback', 'setImmediate',
    'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
});

// Move the clock mid-test; tokens are clock-bound, so sign in again.
const travel = async (iso) => { setToday(iso); me = api(await login('holder@test.local', 'secret123')); };

let me;
let food;
let home;

const mkCard = async (over = {}) =>
  (await me.post('/cards', { name: 'Visa', cut_day: 5, due_day: 25, ...over })).body;
const charge = (cardId, amount, occurred_at, extra = {}) =>
  me.post('/transactions', { type: 'expense', amount, occurred_at, card_id: cardId, ...extra });
const balance = async () => (await me.get('/balance')).body;
const card = async (id) => (await me.get(`/cards/${id}`)).body;
const list = async (qs = '') => (await me.get(`/transactions${qs}`)).body;

beforeEach(async () => {
  setToday('2026-11-20');
  wipeAll();
  seedUser('holder@test.local', 'secret123');
  me = api(await login('holder@test.local', 'secret123'));
  food = (await me.post('/categories', { name: 'Food', kind: 'expense' })).body;
  home = (await me.post('/categories', { name: 'Home', kind: 'expense' })).body;
  await me.post('/transactions', { type: 'income', amount: 10000, occurred_at: '2026-11-01' });
});

afterEach(() => jest.useRealTimers());
afterAll(wipeAll);

describe('statement scenario', () => {
  it('tracks charges without touching cash, then payments move cash and shrink the statement', async () => {
    const c = await mkCard({ credit_limit: 5000 });
    expect(c).toMatchObject({ name: 'Visa', cut_day: 5, due_day: 25, credit_limit: 5000, owed: 0 });

    const a = await charge(c.id, 1200, '2026-11-02', { category_ids: [food.id], description: 'Groceries' });
    const b = await charge(c.id, 800, '2026-11-10', { category_ids: [home.id, food.id] });
    expect(a.status).toBe(201);
    expect(a.body).toMatchObject({ type: 'expense', amount: 1200, card_id: c.id });

    // Cash untouched; the card carries the debt.
    expect(await card(c.id)).toMatchObject({
      owed: 2000, statement_balance: 1200, current_period: 800,
      last_cut: '2026-11-05', due_date: '2026-11-25',
    });
    expect(await balance()).toMatchObject({
      total: 10000, available: 10000, cards_owed: 2000,
      cards: [{ id: c.id, name: 'Visa', owed: 2000, statement_balance: 1200, due_date: '2026-11-25' }],
    });

    // Pay 500 from the balance.
    const pay1 = await me.post(`/cards/${c.id}/pay`, { amount: 500, occurred_at: '2026-11-12' });
    expect(pay1.status).toBe(201);
    expect(pay1.body).toMatchObject({ owed: 1500, statement_balance: 700, current_period: 800 });
    expect(await balance()).toMatchObject({ total: 9500, available: 9500, cards_owed: 1500 });

    // Pay the remaining statement.
    await me.post(`/cards/${c.id}/pay`, { amount: 700 });
    expect(await card(c.id)).toMatchObject({ owed: 800, statement_balance: 0, current_period: 800 });
    expect(await balance()).toMatchObject({ total: 8800, available: 8800, cards_owed: 800 });

    // Rows add up to totals: charges are spends, payments are reported apart and are not spends.
    const all = await list();
    expect(all.items.map((t) => t.type).sort()).toEqual(['card_payment', 'card_payment', 'expense', 'expense', 'income']);
    const sum = (type) => all.items.filter((t) => t.type === type).reduce((s, t) => s + t.amount, 0);
    expect(all.totals).toMatchObject({
      income: sum('income'), expense: sum('expense'), card_payments: sum('card_payment'), count: 5,
    });
    expect(all.totals).toMatchObject({ income: 10000, expense: 2000, card_payments: 1200 });
    // Net worth = income - payments (cash), independent of the charges.
    expect((await balance()).total).toBe(all.totals.income - all.totals.card_payments);

    // The month's expense total counts the charges once, not the payments.
    expect((await list('?from=2026-11-01&to=2026-11-30&type=expense')).totals.expense).toBe(2000);
    // Tags: a charge shows under each of its categories; the full amount counts under each.
    expect((await list(`?category_id=${food.id}`)).totals.expense).toBe(2000);
    expect((await list(`?category_id=${home.id}`)).totals.expense).toBe(800);
    expect(a.body.categories).toEqual([{ id: food.id, name: 'Food' }]);
    expect(b.body.categories.map((x) => x.name)).toEqual(['Food', 'Home']);
  });

  it('filters by card and by payment type', async () => {
    const c1 = await mkCard();
    const c2 = await mkCard({ name: 'Amex' });
    await charge(c1.id, 100, '2026-11-02');
    await charge(c2.id, 40, '2026-11-03');
    await me.post(`/cards/${c1.id}/pay`, { amount: 30 });

    const onC1 = await list(`?card_id=${c1.id}`);
    expect(onC1.items.map((t) => t.type).sort()).toEqual(['card_payment', 'expense']);
    expect(onC1.totals).toMatchObject({ expense: 100, card_payments: 30, income: 0, count: 2 });
    const pays = await list('?type=card_payment');
    expect(pays.items).toHaveLength(1);
    expect(pays.items[0]).toMatchObject({ card_id: c1.id, amount: 30, type: 'card_payment' });
    expect((await me.get('/transactions?card_id=abc')).status).toBe(400);
  });

  it('keeps an unpaid statement\'s due date (now overdue) until the next cut', async () => {
    const c = await mkCard();
    await charge(c.id, 1200, '2026-11-02');
    await travel('2026-11-26');
    expect(await card(c.id)).toMatchObject({ last_cut: '2026-11-05', due_date: '2026-11-25', statement_balance: 1200 });
    await travel('2026-12-06'); // new cut on 12-05: the Nov charges are still the statement; due moves on
    expect(await card(c.id)).toMatchObject({ last_cut: '2026-12-05', due_date: '2026-12-25', statement_balance: 1200 });
  });

  it('clamps cut day 31 in February', async () => {
    await travel('2026-03-02');
    const c = await mkCard({ cut_day: 31, due_day: 10 });
    await charge(c.id, 300, '2026-02-28');
    await charge(c.id, 50, '2026-03-01');
    expect(await card(c.id)).toMatchObject({
      last_cut: '2026-02-28', due_date: '2026-03-10', statement_balance: 300, current_period: 50, owed: 350,
    });
  });
});

describe('payments', () => {
  it('rejects bad amounts and over-paying, books nothing', async () => {
    const c = await mkCard();
    await charge(c.id, 800, '2026-11-10');
    for (const amount of [0, -5, 'x', null, 800.01]) {
      expect((await me.post(`/cards/${c.id}/pay`, { amount })).status).toBe(400);
    }
    expect((await me.post(`/cards/${c.id}/pay`, {})).status).toBe(400);
    expect((await me.post(`/cards/${c.id}/pay`, { amount: 10, occurred_at: '2026-13-40' })).status).toBe(400);
    expect((await me.post('/cards/99999/pay', { amount: 10 })).status).toBe(404);
    expect((await list('?type=card_payment')).items).toHaveLength(0);
    expect((await me.post(`/cards/${c.id}/pay`, { amount: 800 })).status).toBe(201); // exactly owed is fine
    expect((await card(c.id)).owed).toBe(0);
  });

  it('may push available below zero (ADR-012)', async () => {
    const c = await mkCard();
    await charge(c.id, 15000, '2026-11-02');
    expect((await me.post(`/cards/${c.id}/pay`, { amount: 15000 })).status).toBe(201);
    expect(await balance()).toMatchObject({ total: -5000, available: -5000, cards_owed: 0 });
  });

  it('are read-only rows that can only be deleted, which restores the debt', async () => {
    const c = await mkCard();
    await charge(c.id, 800, '2026-11-10');
    await me.post(`/cards/${c.id}/pay`, { amount: 300 });
    const pay = (await list('?type=card_payment')).items[0];
    expect((await me.put(`/transactions/${pay.id}`, { amount: 1 })).status).toBe(400);
    expect((await me.del(`/transactions/${pay.id}`)).status).toBe(204);
    expect(await card(c.id)).toMatchObject({ owed: 800 });
    expect((await balance()).available).toBe(10000);
  });

  it('cannot be created through POST /transactions', async () => {
    const c = await mkCard();
    const res = await me.post('/transactions', { type: 'card_payment', amount: 5, card_id: c.id });
    expect(res.status).toBe(400);
    expect((await me.put(`/transactions/${(await charge(c.id, 5, '2026-11-02')).body.id}`, { type: 'card_payment' })).status).toBe(400);
  });
});

describe('charges', () => {
  it('moving a charge between cash and card is a plain edit', async () => {
    const c = await mkCard();
    const tx = (await charge(c.id, 1200, '2026-11-02')).body;
    expect((await balance()).available).toBe(10000);

    expect((await me.put(`/transactions/${tx.id}`, { card_id: null })).body.card_id).toBeNull();
    expect(await balance()).toMatchObject({ available: 8800, cards_owed: 0 });
    expect((await me.put(`/transactions/${tx.id}`, { card_id: c.id })).body.card_id).toBe(c.id);
    expect(await balance()).toMatchObject({ available: 10000, cards_owed: 1200 });
  });

  it('a cash expense moved to a card stops hitting cash', async () => {
    const c = await mkCard();
    const tx = (await me.post('/transactions', { type: 'expense', amount: 400 })).body;
    expect((await balance()).available).toBe(9600);
    await me.put(`/transactions/${tx.id}`, { card_id: c.id });
    expect(await balance()).toMatchObject({ available: 10000, cards_owed: 400 });
  });

  it('only expenses can be charged; card must be in the transaction\'s context', async () => {
    const c = await mkCard();
    expect((await me.post('/transactions', { type: 'income', amount: 5, card_id: c.id })).status).toBe(400);
    const tx = (await charge(c.id, 5, '2026-11-02')).body;
    expect((await me.put(`/transactions/${tx.id}`, { type: 'income' })).status).toBe(400);
    expect((await me.post('/transactions', { type: 'expense', amount: 5, card_id: 99999 })).status).toBe(400);
    expect((await me.post('/transactions', { type: 'expense', amount: 5, card_id: 'x' })).status).toBe(400);

    seedUser('other@test.local', 'secret123');
    const other = api(await login('other@test.local', 'secret123'));
    expect((await other.post('/transactions', { type: 'expense', amount: 5, card_id: c.id })).status).toBe(400);
    expect((await other.get(`/cards/${c.id}`)).status).toBe(404);
    expect((await other.post(`/cards/${c.id}/pay`, { amount: 1 })).status).toBe(404);
    expect((await other.get('/cards')).body).toEqual([]);
  });

  it('cannot shrink, move, retype or delete a charge below what was already paid', async () => {
    const c = await mkCard();
    const d = await mkCard({ name: 'Amex' });
    const tx = (await charge(c.id, 1000, '2026-11-02')).body;
    await me.post(`/cards/${c.id}/pay`, { amount: 600 });

    expect((await me.put(`/transactions/${tx.id}`, { amount: 500 })).status).toBe(400);
    expect((await me.put(`/transactions/${tx.id}`, { card_id: null })).status).toBe(400);
    expect((await me.put(`/transactions/${tx.id}`, { card_id: d.id })).status).toBe(400);
    expect((await me.del(`/transactions/${tx.id}`)).status).toBe(400);
    expect((await me.put(`/transactions/${tx.id}`, { amount: 600 })).status).toBe(200); // exactly the payments
    expect((await me.put(`/transactions/${tx.id}`, { amount: 2000 })).status).toBe(200); // growing is fine
    expect((await card(c.id)).owed).toBe(1400);
  });

  it('a deleted charge stops counting', async () => {
    const c = await mkCard();
    const tx = (await charge(c.id, 100, '2026-11-02')).body;
    await me.del(`/transactions/${tx.id}`);
    expect(await card(c.id)).toMatchObject({ owed: 0, statement_balance: 0 });
  });
});

describe('card CRUD', () => {
  it('validates the body', async () => {
    const bad = [
      {}, { name: 'X' }, { name: 'X', cut_day: 5 }, { name: '', cut_day: 5, due_day: 25 },
      { name: 'X', cut_day: 0, due_day: 25 }, { name: 'X', cut_day: 5, due_day: 32 },
      { name: 'X', cut_day: 5.5, due_day: 25 }, { name: 'X', cut_day: '5', due_day: 25 },
      { name: 'X', cut_day: 5, due_day: 25, credit_limit: -1 }, { name: 'X', cut_day: 5, due_day: 25, credit_limit: 'a' },
    ];
    for (const body of bad) expect((await me.post('/cards', body)).status).toBe(400);
    expect((await me.get('/cards')).body).toEqual([]);
    const c = await mkCard();
    expect((await me.put(`/cards/${c.id}`, { cut_day: 40 })).status).toBe(400);
    expect((await me.put(`/cards/${c.id}`, { name: ' ' })).status).toBe(400);
  });

  it('updates fields (limit clears with null) and recomputes the statement', async () => {
    const c = await mkCard({ credit_limit: 100 });
    await charge(c.id, 50, '2026-11-02');
    const res = await me.put(`/cards/${c.id}`, { name: 'Gold', cut_day: 1, credit_limit: null });
    expect(res.body).toMatchObject({ name: 'Gold', cut_day: 1, credit_limit: null, last_cut: '2026-11-01', statement_balance: 0, current_period: 50 });
    expect((await me.get('/cards')).body.map((x) => x.name)).toEqual(['Gold']);
  });

  it('deletes only at owed = 0; its history stays', async () => {
    const c = await mkCard();
    await charge(c.id, 80, '2026-11-02');
    const refused = await me.del(`/cards/${c.id}`);
    expect(refused.status).toBe(400);
    await me.post(`/cards/${c.id}/pay`, { amount: 80 });
    expect((await me.del(`/cards/${c.id}`)).status).toBe(204);
    expect((await me.get(`/cards/${c.id}`)).status).toBe(404);
    expect((await balance()).cards).toEqual([]);
    expect((await list(`?card_id=${c.id}`)).items).toHaveLength(2); // charge + payment survive
  });
});

describe('team scope & RBAC', () => {
  let owner;
  let member;
  let guest;
  let teamId;
  let ownerCard;
  const inTeam = (p) => `${p}?team_id=${teamId}`;

  beforeEach(async () => {
    seedUser('owner@test.local', 'secret123');
    seedUser('member@test.local', 'secret123');
    seedUser('guest@test.local', 'secret123');
    owner = api(await login('owner@test.local', 'secret123'));
    member = api(await login('member@test.local', 'secret123'));
    guest = api(await login('guest@test.local', 'secret123'));
    teamId = (await owner.post('/teams', { name: 'Home' })).body.id;
    await owner.post(`/teams/${teamId}/members`, { email: 'member@test.local', role: 'member' });
    await owner.post(`/teams/${teamId}/members`, { email: 'guest@test.local', role: 'guest' });
    await owner.post(inTeam('/transactions'), { type: 'income', amount: 1000 });
    ownerCard = (await owner.post(inTeam('/cards'), { name: 'Shared', cut_day: 5, due_day: 25 })).body;
  });

  it('guests read but cannot write or pay; members touch only their own cards', async () => {
    expect((await guest.get(inTeam('/cards'))).body.map((c) => c.name)).toEqual(['Shared']);
    expect((await guest.post(inTeam('/cards'), { name: 'G', cut_day: 1, due_day: 2 })).status).toBe(403);
    expect((await guest.post(inTeam(`/cards/${ownerCard.id}/pay`), { amount: 1 })).status).toBe(403);
    expect((await guest.get(inTeam('/balance'))).body.cards).toHaveLength(1);

    const mine = (await member.post(inTeam('/cards'), { name: 'Mine', cut_day: 1, due_day: 2 })).body;
    expect(mine.team_id).toBe(teamId);
    expect((await member.put(inTeam(`/cards/${ownerCard.id}`), { name: 'Hijack' })).status).toBe(403);
    expect((await member.del(inTeam(`/cards/${ownerCard.id}`))).status).toBe(403);
    expect((await member.post(inTeam(`/cards/${ownerCard.id}/pay`), { amount: 1 })).status).toBe(403);
    expect((await owner.put(inTeam(`/cards/${mine.id}`), { name: 'Renamed' })).status).toBe(200); // owner bypass
  });

  it('team charges use team cards only, and team payments hit the team balance', async () => {
    const tx = await member.post(inTeam('/transactions'), { type: 'expense', amount: 300, card_id: ownerCard.id, occurred_at: '2026-11-02' });
    expect(tx.status).toBe(201);
    // personal card in a team transaction, and a team card in a personal one, are both refused
    const personal = await mkCard({ name: 'Personal' });
    expect((await member.post(inTeam('/transactions'), { type: 'expense', amount: 1, card_id: personal.id })).status).toBe(400);
    expect((await me.post('/transactions', { type: 'expense', amount: 1, card_id: ownerCard.id })).status).toBe(400);

    expect((await owner.get(inTeam('/balance'))).body).toMatchObject({ total: 1000, available: 1000, cards_owed: 300 });
    const pay = await owner.post(inTeam(`/cards/${ownerCard.id}/pay`), { amount: 100 });
    expect(pay.status).toBe(201);
    expect((await owner.get(inTeam('/balance'))).body).toMatchObject({ total: 900, available: 900, cards_owed: 200 });
    expect((await balance()).cards_owed).toBe(0); // personal context unaffected
  });

  it('logs created/paid events and no transaction event for the payment', async () => {
    await owner.post(inTeam('/transactions'), { type: 'expense', amount: 300, card_id: ownerCard.id });
    await owner.post(inTeam(`/cards/${ownerCard.id}/pay`), { amount: 100 });
    const feed = (await owner.get(inTeam('/events'))).body;
    expect(feed.filter((e) => e.entity === 'card').map((e) => e.action).sort()).toEqual(['created', 'paid']);
    const paid = feed.find((e) => e.action === 'paid');
    expect(paid).toMatchObject({ entity_id: ownerCard.id, summary: { name: 'Shared', amount: 100 } });
    expect(feed.filter((e) => e.entity === 'transaction')).toHaveLength(2); // income + charge, not the payment
  });
});

describe('migration of pre-ADR-014 transactions', () => {
  const dbFile = path.join(__dirname, '..', '..', '..', 'data', 'balance.cards-migrate.test.db');
  const clean = () => ['', '-wal', '-shm'].forEach((s) => fs.rmSync(dbFile + s, { force: true }));
  const migrate = () => execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'src', 'db', 'migrate.js')],
    { env: { ...process.env, NODE_ENV: 'test', DB_PATH: dbFile }, stdio: 'pipe' });

  afterAll(clean);

  it('rebuilds the table to accept card_payment/card_id, keeping rows and their references', () => {
    clean();
    const legacy = new Database(dbFile);
    legacy.exec(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'src', 'db', 'schema.sql'), 'utf8'));
    // Recreate the pre-ADR-014 shape: no card_id, CHECK without card_payment, no cards table.
    legacy.pragma('foreign_keys = OFF');
    legacy.exec(`
      DROP TABLE transactions;
      DROP TABLE cards;
      CREATE TABLE transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id),
        team_id INTEGER REFERENCES teams(id),
        type TEXT NOT NULL CHECK (type IN ('income', 'expense')),
        amount INTEGER NOT NULL CHECK (amount > 0),
        loan_id INTEGER REFERENCES loans(id),
        description TEXT,
        occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
        deleted_at TEXT
      );
      INSERT INTO users (id, email) VALUES (1, 'legacy@test.local');
      INSERT INTO categories (id, user_id, name, kind) VALUES (1, 1, 'Food', 'expense');
      INSERT INTO transactions (id, user_id, type, amount, description, occurred_at) VALUES (7, 1, 'expense', 1234, 'Old', '2026-01-02');
      INSERT INTO transaction_categories (transaction_id, category_id) VALUES (7, 1);
      INSERT INTO shopping_lists (id, user_id, name, status, transaction_id) VALUES (1, 1, 'L', 'purchased', 7);
    `);
    legacy.pragma('foreign_keys = ON');
    legacy.close();

    migrate();
    migrate(); // idempotent

    const db = new Database(dbFile);
    expect(db.prepare(`SELECT id, type, amount, description, occurred_at, card_id FROM transactions`).all())
      .toEqual([{ id: 7, type: 'expense', amount: 1234, description: 'Old', occurred_at: '2026-01-02', card_id: null }]);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM transaction_categories WHERE transaction_id = 7`).get().n).toBe(1);
    expect(db.prepare(`SELECT transaction_id FROM shopping_lists`).get().transaction_id).toBe(7);
    db.pragma('foreign_keys = ON');
    expect(db.pragma('foreign_key_check')).toEqual([]);
    db.prepare(`INSERT INTO cards (id, user_id, name, cut_day, due_day) VALUES (1, 1, 'C', 5, 25)`).run();
    db.prepare(`INSERT INTO transactions (user_id, type, amount, card_id) VALUES (1, 'card_payment', 100, 1)`).run();
    const names = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'transactions'`).all().map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(['idx_transactions_user', 'idx_transactions_team', 'idx_transactions_occurred', 'idx_transactions_card']));
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'transactions_new'`).get()).toBeUndefined();
    db.close();
  });
});

describe('audit hardening', () => {
  it('freezes the rows of a deleted card so debt cannot be hidden', async () => {
    const c = await mkCard();
    const tx = (await charge(c.id, 100, '2026-11-02')).body;
    await me.post(`/cards/${c.id}/pay`, { amount: 100 });
    expect((await me.del(`/cards/${c.id}`)).status).toBe(204);
    const pay = (await list('?type=card_payment')).items[0];
    expect((await me.del(`/transactions/${pay.id}`)).status).toBe(400);
    expect((await me.put(`/transactions/${tx.id}`, { amount: 5000 })).status).toBe(400);
    expect((await me.put(`/transactions/${tx.id}`, { card_id: null })).status).toBe(400);
    expect((await me.del(`/transactions/${tx.id}`)).status).toBe(400);
    expect((await balance()).total).toBe(9900);
  });

  it('validates occurred_at and amount on transactions', async () => {
    const c = await mkCard();
    for (const occurred_at of ['junk', '2026-02-30', null, 20261105]) {
      expect((await charge(c.id, 10, occurred_at)).status).toBe(400);
    }
    for (const amount of ['x', 1e20, -1, 0.001, true]) {
      expect((await me.post('/transactions', { type: 'expense', amount })).status).toBe(400);
    }
    const tx = (await charge(c.id, 10, '2026-11-05')).body;
    expect((await me.put(`/transactions/${tx.id}`, { amount: 'x' })).status).toBe(400);
    expect((await me.put(`/transactions/${tx.id}`, { occurred_at: 'junk' })).status).toBe(400);
    // A cut-day charge stamped with a time still falls in the statement, not the open period.
    expect((await charge(c.id, 5, '2026-11-05T09:00')).status).toBe(201);
    expect((await card(c.id))).toMatchObject({ statement_balance: 15, owed: 15, current_period: 0 });
  });
});
