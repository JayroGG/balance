'use strict';
/**
 * Integration — GET /transactions search, date range, totals, keyset paging (ADR-011).
 * Validates: each filter + combinations, paging walk (no dupes/skips with shared dates,
 * both sorts), totals over the whole filtered set excluding journal rows, scope isolation
 * (personal/team/other user), soft-delete exclusion, LIKE wildcard escaping, 400s, limit clamp.
 */
const { wipeAll, seedUser, db } = require('../../helpers/db');
const { login, api } = require('../../helpers/api');

let me;
let other;
let meId;

const add = (body, client = me) => client.post('/transactions', body);
const list = async (qs = '', client = me) => (await client.get(`/transactions${qs}`)).body;

beforeEach(async () => {
  wipeAll();
  meId = seedUser('me@test.local', 'secret123');
  seedUser('other@test.local', 'secret123');
  me = api(await login('me@test.local', 'secret123'));
  other = api(await login('other@test.local', 'secret123'));
});

afterAll(wipeAll);

describe('response shape and filters', () => {
  beforeEach(async () => {
    const food = (await me.post('/categories', { name: 'Groceries', kind: 'expense' })).body;
    await add({ type: 'income', amount: 1000, description: 'Salary', occurred_at: '2026-01-10' });
    await add({ type: 'expense', amount: 20.5, description: 'Milk', category_ids: [food.id], occurred_at: '2026-01-15' });
    await add({ type: 'expense', amount: 10, description: 'Bus', occurred_at: '2026-02-01' });
  });

  it('returns items, next_cursor and totals with decimal amounts', async () => {
    const res = await list();
    expect(res.items).toHaveLength(3);
    expect(res.next_cursor).toBeNull();
    expect(res.totals).toEqual({ income: 1000, expense: 30.5, net: 969.5, card_payments: 0, count: 3 });
    expect(res.items.map((t) => t.occurred_at)).toEqual(['2026-02-01', '2026-01-15', '2026-01-10']);
  });

  it('q matches description or category name, case-insensitive', async () => {
    expect((await list('?q=SALA')).items).toHaveLength(1);
    expect((await list('?q=grocer')).items.map((t) => t.description)).toEqual(['Milk']);
    expect((await list('?q=%20%20bus%20')).items).toHaveLength(1); // trimmed
    expect((await list('?q=')).items).toHaveLength(3);              // empty ignored
    expect((await list('?q=zzz')).totals.count).toBe(0);
  });

  it('treats % _ and \\ in q literally', async () => {
    await add({ type: 'expense', amount: 1, description: '100% legit_deal \\ x' });
    expect((await list('?q=%25')).items).toHaveLength(1);
    expect((await list('?q=_')).items).toHaveLength(1);
    expect((await list('?q=%5C')).items).toHaveLength(1);
    expect((await list('?q=l_git')).items).toHaveLength(0); // _ is not a wildcard
  });

  it('matches accented text when the case is the same', async () => {
    await add({ type: 'expense', amount: 3, description: 'Café con leche' });
    expect((await list('?q=caf%C3%A9')).items).toHaveLength(1);
    expect((await list('?q=CAF%C3%A9')).items).toHaveLength(1); // ASCII part is case-insensitive
  });

  it('from/to are inclusive and either may be omitted', async () => {
    expect((await list('?from=2026-01-15&to=2026-02-01')).totals.count).toBe(2);
    expect((await list('?from=2026-01-16')).totals.count).toBe(1);
    expect((await list('?to=2026-01-10')).totals.count).toBe(1);
    expect((await list('?from=2026-01-15&to=2026-01-15')).items).toHaveLength(1);
  });

  it('type, category_id and combined filters AND together', async () => {
    expect((await list('?type=income')).items).toHaveLength(1);
    const catId = (await list('?q=milk')).items[0].categories[0].id;
    expect((await list(`?category_id=${catId}`)).items).toHaveLength(1);
    const combo = await list('?type=expense&q=bus&from=2026-02-01&sort=asc');
    expect(combo.items.map((t) => t.description)).toEqual(['Bus']);
    expect((await list('?type=income&q=bus')).totals.count).toBe(0);
  });

  it('sort=asc reverses the order', async () => {
    expect((await list('?sort=asc')).items.map((t) => t.occurred_at))
      .toEqual(['2026-01-10', '2026-01-15', '2026-02-01']);
  });
});

describe('keyset paging', () => {
  const walk = async (qs) => {
    const ids = [];
    let cursor;
    let guard = 0;
    do {
      const res = await list(`?limit=4${qs}${cursor ? `&cursor=${cursor}` : ''}`);
      ids.push(...res.items.map((t) => t.id));
      cursor = res.next_cursor;
    } while (cursor && ++guard < 20);
    return ids;
  };

  beforeEach(async () => {
    await add({ type: 'income', amount: 10000 });
    for (let i = 0; i < 10; i += 1) { // several rows share each date
      await add({ type: 'expense', amount: 1 + i, occurred_at: `2026-03-0${1 + (i % 3)}` });
    }
  });

  it('visits every row exactly once in both directions', async () => {
    for (const sort of ['desc', 'asc']) {
      const ids = await walk(`&sort=${sort}`);
      expect(ids).toHaveLength(11);
      expect(new Set(ids).size).toBe(11);
    }
    const all = (await list('?limit=100')).items.map((t) => t.id);
    expect(await walk('')).toEqual(all);
  });

  it('totals ignore limit and cursor', async () => {
    const first = await list('?limit=3');
    expect(first.items).toHaveLength(3);
    expect(first.next_cursor).toBeTruthy();
    const second = await list(`?limit=3&cursor=${first.next_cursor}`);
    expect(second.totals).toEqual(first.totals);
    expect(first.totals.count).toBe(11);
  });

  it('stays stable when a row is inserted mid-scroll', async () => {
    const first = await list('?limit=4');
    await add({ type: 'expense', amount: 1, occurred_at: '2099-01-01' }); // newer than the cursor
    const second = await list(`?limit=4&cursor=${first.next_cursor}`);
    const seen = new Set(first.items.map((t) => t.id));
    expect(second.items.some((t) => seen.has(t.id))).toBe(false);
  });

  it('clamps limit to 100 and defaults to 30', async () => {
    for (let i = 0; i < 110; i += 1) {
      db.prepare(`INSERT INTO transactions (user_id, type, amount) VALUES (?, 'income', 1)`).run(meId);
    }
    expect((await list()).items).toHaveLength(30);
    expect((await list('?limit=1000')).items).toHaveLength(100);
  });
});

describe('totals and journal rows', () => {
  it('exclude loan journal rows from income/expense/net but count them', async () => {
    await add({ type: 'income', amount: 100 });
    const loan = (await me.post('/loans', { name: 'Bob', amount: 30 })).body;
    expect(loan.id).toBeTruthy();
    const all = await list();
    expect(all.totals).toEqual({ income: 100, expense: 0, net: 100, card_payments: 0, count: 2 });
    expect((await list('?loans=only')).items).toHaveLength(1);
    expect((await list('?loans=exclude')).items).toHaveLength(1);
    expect((await list('?loans=only')).totals).toMatchObject({ expense: 0, count: 1 });
  });
});

describe('scope and soft delete', () => {
  it('q does not match foreign or deleted category names', async () => {
    await add({ type: 'income', amount: 100 });
    const foreign = (await other.post('/categories', { name: 'Zebra', kind: 'expense' })).body;
    await add({ type: 'expense', amount: 1, description: 'a', category_ids: [foreign.id] });
    expect((await list('?q=zebra')).totals.count).toBe(0);
    const mine = (await me.post('/categories', { name: 'Yak', kind: 'expense' })).body;
    await add({ type: 'expense', amount: 1, description: 'b', category_ids: [mine.id] });
    expect((await list('?q=yak')).totals.count).toBe(1);
    await me.del(`/categories/${mine.id}`);
    expect((await list('?q=yak')).totals.count).toBe(0);
  });

  it('never leaks other users or teams, and q cannot widen scope', async () => {
    await add({ type: 'income', amount: 1, description: 'mine secret' });
    await add({ type: 'income', amount: 2, description: 'theirs secret' }, other);
    const res = await list('?q=secret');
    expect(res.items.map((t) => t.description)).toEqual(['mine secret']);
    expect(res.totals.count).toBe(1);
  });

  it('keeps team and personal listings separate; non-members get 403', async () => {
    const team = (await me.post('/teams', { name: 'Home' })).body;
    await add({ type: 'income', amount: 5, description: 'team row' });
    await me.post(`/transactions?team_id=${team.id}`, { type: 'income', amount: 7, description: 'team row' });
    expect((await list(`?team_id=${team.id}&q=team`)).totals).toMatchObject({ income: 7, count: 1 });
    expect((await list('?q=team')).totals).toMatchObject({ income: 5, count: 1 });
    expect((await other.get(`/transactions?team_id=${team.id}&q=team`)).status).toBe(403);
  });

  it('team rows match categories created by another team member', async () => {
    const team = (await me.post('/teams', { name: 'Crew' })).body;
    const tid = `?team_id=${team.id}`;
    await me.post(`/transactions${tid}`, { type: 'income', amount: 50 });
    const cat = (await me.post(`/categories${tid}`, { name: 'Pizza', kind: 'expense' })).body;
    await me.post(`/transactions${tid}`, { type: 'expense', amount: 5, category_ids: [cat.id] });
    expect((await list(`${tid}&q=pizza`)).totals.count).toBe(1);
  });

  it('excludes soft-deleted rows from items and totals', async () => {
    const t = (await add({ type: 'income', amount: 9, description: 'gone' })).body;
    await add({ type: 'income', amount: 1, description: 'kept' });
    await me.del(`/transactions/${t.id}`);
    const res = await list();
    expect(res.items).toHaveLength(1);
    expect(res.totals).toMatchObject({ income: 1, count: 1 });
  });
});

describe('validation', () => {
  it.each([
    '?from=2026-13-01', '?to=2026-02-30', '?from=26-01-01', '?from=2026-02-01&to=2026-01-01',
    '?type=transfer', '?loans=maybe', '?sort=up', '?limit=0', '?limit=abc', '?category_id=x',
    '?q=a&q=b', '?cursor=not-a-cursor', `?cursor=${Buffer.from('{"a":1}').toString('base64url')}`,
    `?cursor=${Buffer.from('[1,1]').toString('base64url')}`,
    `?cursor=${Buffer.from('["2026-01-01","1; DROP TABLE transactions"]').toString('base64url')}`,
  ])('rejects %s with 400', async (qs) => {
    expect((await me.get(`/transactions${qs}`)).status).toBe(400);
  });

  it('pages past rows whose occurred_at is not a plain date', async () => {
    for (const d of ['2026-01-05T10:00', '2026-01-04']) await add({ type: 'income', amount: 1, occurred_at: d });
    const first = await list('?limit=1');
    expect((await me.get(`/transactions?limit=1&cursor=${first.next_cursor}`)).status).toBe(200);
  });

  it('keeps /transactions/:id working', async () => {
    const t = (await add({ type: 'income', amount: 4 })).body;
    expect((await me.get(`/transactions/${t.id}`)).body.amount).toBe(4);
  });
});
