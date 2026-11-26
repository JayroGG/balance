'use strict';
/**
 * Integration — ledger rules (ADR-012, ADR-013).
 * Validates: negative available scenario, allocate/lend caps stay, multi-category tags
 * (full amount under each, totals count once), category scope checks (400), reads carry
 * categories, replace/clear on update, deleted categories hidden, and the migration of the
 * legacy transactions.category_id column into transaction_categories.
 */
const path = require('path');
const { execFileSync } = require('child_process');
const { wipeAll, seedUser, db } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let me;
let other;

const cat = async (name, client = me, qs = '') => (await client.post(`/categories${qs}`, { name, kind: 'expense' })).body;
const balance = async () => (await me.get('/balance')).body;

beforeEach(async () => {
  wipeAll();
  seedUser('me@test.local', 'secret123');
  seedUser('other@test.local', 'secret123');
  me = api(await login('me@test.local', 'secret123'));
  other = api(await login('other@test.local', 'secret123'));
});

afterAll(wipeAll);

describe('negative available (ADR-012)', () => {
  it('owner scenario: overspend → negative, caps stay, checkout may overspend', async () => {
    await me.post('/transactions', { type: 'income', amount: 1000 });
    expect(await balance()).toMatchObject({ total: 1000, available: 1000 });

    const spend = await me.post('/transactions', { type: 'expense', amount: 1500 });
    expect(spend.status).toBe(201);
    expect(await balance()).toMatchObject({ total: -500, available: -500 });

    const vault = (await me.post('/vaults', { name: 'V' })).body;
    expect((await me.post(`/vaults/${vault.id}/allocate`, { amount: 100 })).status).toBe(400);

    const list = (await me.post('/shopping-lists', { name: 'Big' })).body;
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'TV' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });
    expect((await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 200 })).status).toBe(200);
    expect(await balance()).toMatchObject({ total: -700, available: -700 });
  });
});

describe('multiple categories (ADR-013)', () => {
  let food;
  let home;
  beforeEach(async () => {
    food = await cat('Food');
    home = await cat('Home');
  });

  it('full amount counts under each tag; filters find it; totals count it once', async () => {
    const tx = (await me.post('/transactions', {
      type: 'expense', amount: 500, description: 'Costco', category_ids: [home.id, food.id, food.id],
    })).body;
    expect(tx.categories).toEqual([{ id: food.id, name: 'Food' }, { id: home.id, name: 'Home' }]);
    expect(tx).not.toHaveProperty('category_id');

    for (const c of [food, home]) {
      const res = (await me.get(`/transactions?category_id=${c.id}`)).body;
      expect(res.items.map((i) => i.id)).toEqual([tx.id]);
      expect(res.totals).toMatchObject({ expense: 500, count: 1 });
    }
    expect((await me.get('/transactions')).body.totals).toMatchObject({ expense: 500, net: -500, count: 1 });
    expect((await me.get('/transactions?q=home')).body.items).toHaveLength(1); // q matches any tag name
    expect((await me.get(`/transactions/${tx.id}`)).body.categories).toHaveLength(2);
    expect((await me.get('/transactions')).body.items[0].categories).toHaveLength(2);
  });

  it('update replaces the tag set; [] clears; omitted leaves it untouched', async () => {
    const tx = (await me.post('/transactions', { type: 'expense', amount: 10, category_ids: [food.id] })).body;
    const both = (await me.put(`/transactions/${tx.id}`, { category_ids: [food.id, home.id] })).body;
    expect(both.categories.map((c) => c.name)).toEqual(['Food', 'Home']);
    const kept = (await me.put(`/transactions/${tx.id}`, { description: 'x' })).body;
    expect(kept.categories).toHaveLength(2);
    const swapped = (await me.put(`/transactions/${tx.id}`, { category_ids: [home.id] })).body;
    expect(swapped.categories).toEqual([{ id: home.id, name: 'Home' }]);
    expect((await me.get(`/transactions?category_id=${food.id}`)).body.items).toHaveLength(0);
    const cleared = (await me.put(`/transactions/${tx.id}`, { category_ids: [] })).body;
    expect(cleared.categories).toEqual([]);
  });

  it('no categories is fine and reads as []', async () => {
    const tx = (await me.post('/transactions', { type: 'income', amount: 5 })).body;
    expect(tx.categories).toEqual([]);
  });

  it('deleted categories are hidden from reads', async () => {
    const tx = (await me.post('/transactions', { type: 'expense', amount: 5, category_ids: [food.id, home.id] })).body;
    await me.del(`/categories/${food.id}`);
    expect((await me.get(`/transactions/${tx.id}`)).body.categories).toEqual([{ id: home.id, name: 'Home' }]);
    expect((await me.get('/transactions')).body.items[0].categories).toEqual([{ id: home.id, name: 'Home' }]);
  });

  it('rejects malformed category_ids and the legacy category_id', async () => {
    for (const bad of [food.id, 'a', [0], [-1], [1.5], ['1'], [null], Array.from({ length: 51 }, (_, i) => i + 1)]) {
      expect((await me.post('/transactions', { type: 'expense', amount: 5, category_ids: bad })).status).toBe(400);
    }
    expect((await me.post('/transactions', { type: 'expense', amount: 5, category_id: food.id })).status).toBe(400);
    const tx = (await me.post('/transactions', { type: 'expense', amount: 5 })).body;
    expect((await me.put(`/transactions/${tx.id}`, { category_id: food.id })).status).toBe(400);
    expect((await me.put(`/transactions/${tx.id}`, { category_ids: 'x' })).status).toBe(400);
  });

  it('category scope: unknown, deleted, foreign-user and cross-context ids → 400, nothing written', async () => {
    const foreign = await cat('Theirs', other);
    const gone = await cat('Gone');
    await me.del(`/categories/${gone.id}`);
    const team = (await me.post('/teams', { name: 'Crew' })).body;
    const teamCat = await cat('Team', me, `?team_id=${team.id}`);

    for (const id of [999999, foreign.id, gone.id, teamCat.id]) {
      const res = await me.post('/transactions', { type: 'expense', amount: 5, category_ids: [food.id, id] });
      expect(res.status).toBe(400);
    }
    expect((await me.get('/transactions')).body.items).toHaveLength(0);
    expect(db.prepare('SELECT COUNT(*) AS n FROM transaction_categories').get().n).toBe(0);

    // personal category into a team transaction, and team category into personal update
    expect((await me.post(`/transactions?team_id=${team.id}`, { type: 'expense', amount: 5, category_ids: [food.id] })).status).toBe(400);
    const ok = await me.post(`/transactions?team_id=${team.id}`, { type: 'expense', amount: 5, category_ids: [teamCat.id] });
    expect(ok.status).toBe(201);
    const mine = (await me.post('/transactions', { type: 'expense', amount: 5, category_ids: [food.id] })).body;
    expect((await me.put(`/transactions/${mine.id}`, { category_ids: [teamCat.id] })).status).toBe(400);
    expect((await me.get(`/transactions/${mine.id}`)).body.categories).toEqual([{ id: food.id, name: 'Food' }]);
  });

  it('a team member may tag with a category another member created', async () => {
    const team = (await me.post('/teams', { name: 'Crew' })).body;
    const teamCat = await cat('Shared', me, `?team_id=${team.id}`);
    const res = await me.post(`/transactions?team_id=${team.id}`, { type: 'expense', amount: 5, category_ids: [teamCat.id] });
    expect(res.status).toBe(201);
    expect(res.body.categories).toEqual([{ id: teamCat.id, name: 'Shared' }]);
  });

  it('checkout accepts an explicit category_ids tag set', async () => {
    await me.post('/transactions', { type: 'income', amount: 100 });
    const list = (await me.post('/shopping-lists', { name: 'Weekly', category_id: food.id })).body;
    const item = (await me.post('/shopping-list-items', { list_id: list.id, name: 'Eggs' })).body;
    await me.put(`/shopping-list-items/${item.id}`, { checked: true });
    const done = (await me.post(`/shopping-lists/${list.id}/checkout`, { amount: 10, category_ids: [food.id, home.id] })).body;
    const tx = (await me.get(`/transactions/${done.transaction_id}`)).body;
    expect(tx.categories.map((c) => c.name)).toEqual(['Food', 'Home']);
  });
});

describe('foreign-context tags never surface', () => {
  it('a migrated row pointing at another user\'s category reads without it', async () => {
    const secret = await cat('Secret', other);
    const mine = await cat('Mine');
    const tx = (await me.post('/transactions', { type: 'expense', amount: 5, category_ids: [mine.id] })).body;
    db.prepare('INSERT INTO transaction_categories (transaction_id, category_id) VALUES (?, ?)').run(tx.id, secret.id);
    expect((await me.get(`/transactions/${tx.id}`)).body.categories).toEqual([{ id: mine.id, name: 'Mine' }]);
    expect((await me.get('/transactions')).body.items[0].categories).toEqual([{ id: mine.id, name: 'Mine' }]);
  });
});

describe('migration of legacy transactions.category_id (ADR-013)', () => {
  it('copies existing category_id values into the join table and drops the column', async () => {
    const food = await cat('Food');
    const tx = (await me.post('/transactions', { type: 'expense', amount: 12.34, description: 'Legacy' })).body;
    const none = (await me.post('/transactions', { type: 'expense', amount: 1, description: 'Untagged' })).body;

    // Recreate the pre-ADR-013 shape: column + index, value set on the row.
    db.exec(`ALTER TABLE transactions ADD COLUMN category_id INTEGER REFERENCES categories(id)`);
    db.exec(`CREATE INDEX idx_transactions_category ON transactions(category_id)`);
    db.prepare(`UPDATE transactions SET category_id = ? WHERE id = ?`).run(food.id, tx.id);

    const run = () => execFileSync(process.execPath, [path.join(__dirname, '..', '..', '..', 'src', 'db', 'migrate.js')],
      { env: { ...process.env, NODE_ENV: 'test' }, stdio: 'pipe' });
    run();
    run(); // idempotent once the column is gone

    expect(db.prepare(`PRAGMA table_info(transactions)`).all().some((c) => c.name === 'category_id')).toBe(false);
    expect((await me.get(`/transactions/${tx.id}`)).body.categories).toEqual([{ id: food.id, name: 'Food' }]);
    expect((await me.get(`/transactions/${none.id}`)).body.categories).toEqual([]);
    expect((await me.get(`/transactions?category_id=${food.id}`)).body.items.map((i) => i.id)).toEqual([tx.id]);
  });
});
