'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');
const { toDecimal } = require('../../../lib/money');
const { encodeCursor } = require('../../../lib/pagination');

const base = modelGenerator(ENTITY_NAME, fields);

const MAX_CATEGORIES = 50;

// Validate a category_ids payload (ADR-013) against the transaction's context:
// every id must be a live category of that same scope, else 400. undefined = not sent.
// scope: { userId, teamId } — team rows use team categories, personal rows the owner's own.
const assertCategoriesInScope = ({ userId, teamId }, ids) => {
  if (ids === undefined) return;
  if (!Array.isArray(ids) || ids.length > MAX_CATEGORIES
      || !ids.every((n) => Number.isInteger(n) && n > 0)) {
    const e = new Error(`category_ids must be an array of up to ${MAX_CATEGORIES} positive integers`);
    e.status = 400; throw e;
  }
  const unique = [...new Set(ids)];
  if (unique.length === 0) return;
  const owner = teamId != null ? 'team_id = ?' : 'team_id IS NULL AND user_id = ?';
  const { n } = db.prepare(
    `SELECT COUNT(*) AS n FROM categories
      WHERE id IN (${unique.map(() => '?').join(', ')}) AND deleted_at IS NULL AND ${owner}`
  ).get(...unique, teamId != null ? teamId : userId);
  if (n !== unique.length) {
    const e = new Error('category_ids must reference categories in the same context as the transaction');
    e.status = 400; throw e;
  }
};

// Attach categories: [{ id, name }] (live categories of the row's own context, name order) to each row.
// Context-scoped so legacy rows migrated with a foreign category never leak its name.
const attachCategories = (rows) => {
  if (rows.length === 0) return rows;
  const found = db.prepare(
    `SELECT tc.transaction_id, c.id, c.name
       FROM transaction_categories tc
       JOIN transactions t ON t.id = tc.transaction_id
       JOIN categories c ON c.id = tc.category_id
        AND c.team_id IS t.team_id AND (t.team_id IS NOT NULL OR c.user_id = t.user_id)
      WHERE c.deleted_at IS NULL AND tc.transaction_id IN (${rows.map(() => '?').join(', ')})
      ORDER BY c.name, c.id`
  ).all(...rows.map((r) => r.id));
  const byTx = new Map();
  for (const f of found) {
    if (!byTx.has(f.transaction_id)) byTx.set(f.transaction_id, []);
    byTx.get(f.transaction_id).push({ id: f.id, name: f.name });
  }
  return rows.map((r) => ({ ...r, categories: byTx.get(r.id) ?? [] }));
};

// Replace a transaction's tag set (deduped). Callers run inside a db.transaction.
const setCategories = (transactionId, ids) => {
  db.prepare(`DELETE FROM transaction_categories WHERE transaction_id = ?`).run(transactionId);
  const ins = db.prepare(`INSERT INTO transaction_categories (transaction_id, category_id) VALUES (?, ?)`);
  for (const id of new Set(ids)) ins.run(transactionId, id);
};

// Transfer rows (ADR-017) carry counterpart_label (the OTHER side: team name or "<email local> (personal)")
// and reversal_of (set on a devolución row). Other rows are left untouched.
const attachTransfer = (rows) => {
  const ids = [...new Set(rows.filter((r) => r.transfer_id != null).map((r) => r.transfer_id))];
  if (ids.length === 0) return rows;
  const found = db.prepare(
    `SELECT tr.id, tr.reversal_of, tr.user_id, tr.from_team_id, tr.to_team_id,
            substr(u.email, 1, instr(u.email, '@') - 1) AS local,
            (SELECT name FROM teams WHERE id = tr.from_team_id) AS from_name,
            (SELECT name FROM teams WHERE id = tr.to_team_id)   AS to_name
       FROM transfers tr JOIN users u ON u.id = tr.user_id
      WHERE tr.id IN (${ids.map(() => '?').join(', ')})`
  ).all(...ids);
  const byId = new Map(found.map((f) => [f.id, f]));
  return rows.map((r) => {
    const f = r.transfer_id != null && byId.get(r.transfer_id);
    if (!f) return r;
    const side = r.type === 'transfer_out' ? [f.to_team_id, f.to_name] : [f.from_team_id, f.from_name];
    const personal = side[0] == null;
    return { ...r, reversal_of: f.reversal_of, counterpart_label: personal ? `${f.local} (personal)` : side[1],
      counterpart_kind: personal ? 'personal' : 'team', counterpart_name: personal ? f.local : side[1] };
  });
};

const decorate = (rows) => attachTransfer(attachCategories(rows));

const findById = (scope, id) => {
  const row = base.findById(scope, id);
  return row ? decorate([row])[0] : row;
};

const findAll = (scope, filters) => decorate(base.findAll(scope, filters));

// category_ids is validated upstream (hooks / checkout); undefined leaves tags untouched.
const create = db.transaction((scope, data) => {
  const row = base.create(scope, data);
  if (data.category_ids !== undefined) setCategories(row.id, data.category_ids);
  return findById(scope, row.id);
});

const update = db.transaction((scope, id, data) => {
  base.update(scope, id, data);
  if (data.category_ids !== undefined) {
    setCategories(id, data.category_ids);
    db.prepare(`UPDATE transactions SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?`).run(id);
  }
  return findById(scope, id);
});

// Journal row for a loan movement (ADR-010): loan_id set, cents in, no hooks.
// Excluded from balance math; read-only via /transactions.
const createJournal = ({ userId, teamId }, { type, amountCents, description, loanId }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO transactions (user_id, team_id, type, amount, description, loan_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, teamId ?? null, type, amountCents, description, loanId);
  return lastInsertRowid;
};

// Card payment (ADR-014): type 'card_payment' + card_id, cents in, no hooks, no categories.
// Reduces net worth (cash left the balance) but is not a spend. Written by POST /cards/:id/pay.
const createCardPayment = ({ userId, teamId }, { amountCents, description, cardId, occurredAt }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO transactions (user_id, team_id, type, amount, description, card_id, occurred_at)
     VALUES (?, ?, 'card_payment', ?, ?, ?, COALESCE(?, strftime('%Y-%m-%d', 'now')))`
  ).run(userId, teamId ?? null, amountCents, description, cardId, occurredAt ?? null);
  return lastInsertRowid;
};

const cardIsLive = (cardId) =>
  !!db.prepare(`SELECT 1 FROM cards WHERE id = ? AND deleted_at IS NULL`).get(cardId);

// A card must be a live card of the transaction's own context (team rows team cards,
// personal rows the owner's), else 400. scope: { userId, teamId }.
const assertCardInScope = ({ userId, teamId }, cardId) => {
  if (cardId === undefined || cardId === null) return;
  if (!Number.isInteger(cardId) || cardId <= 0) {
    const e = new Error('card_id must be a positive integer or null'); e.status = 400; throw e;
  }
  const owner = teamId != null ? 'team_id = ?' : 'team_id IS NULL AND user_id = ?';
  const found = db.prepare(`SELECT 1 FROM cards WHERE id = ? AND deleted_at IS NULL AND ${owner}`)
    .get(cardId, teamId != null ? teamId : userId);
  if (!found) {
    const e = new Error('card_id must reference a card in the same context as the transaction');
    e.status = 400; throw e;
  }
};

// Transfer row (ADR-017): transfer_out / transfer_in + transfer_id, cents in, no hooks, no categories.
// Moves net worth but is neither income nor expense. Written only by the /transfers controller.
const createTransferRow = ({ userId, teamId }, { type, amountCents, description, transferId, occurredAt }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO transactions (user_id, team_id, type, amount, description, transfer_id, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(userId, teamId ?? null, type, amountCents, description ?? null, transferId, occurredAt);
  return lastInsertRowid;
};

// Escape LIKE wildcards so user text is matched literally (ESCAPE '\').
const likePattern = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

// Filtered, keyset-paged list + whole-set totals (ADR-011). params are already
// validated by the route: { q, from, to, type, category_id, card_id, loans, sort, limit, cursor:[date,id] }.
// category_id matches any of a transaction's tags (EXISTS), so each row is still counted once.
// Totals ignore cursor/limit and exclude journal rows (loan_id IS NOT NULL), like balance math;
// count includes them. expense includes card charges (a spend); card_payments is reported apart and is
// in neither income nor expense (ADR-014), so net = income - expense is spend-based, not cash-based. Every value is bound — only fixed fragments are interpolated.
const search = (scope, { q, from, to, type, category_id, card_id, loans, sort, limit, cursor }) => {
  const { sql: scopeSql, values } = base.scopeClause(scope, 't');
  const where = [scopeSql, 't.deleted_at IS NULL'];
  const params = [...values];
  // The category join is scoped to the row's own context so q can't probe other users'/teams' category names.
  if (q)           {
    where.push(`(t.description LIKE ? ESCAPE '\\' OR EXISTS (
      SELECT 1 FROM transaction_categories tc JOIN categories c ON c.id = tc.category_id
       WHERE tc.transaction_id = t.id AND c.name LIKE ? ESCAPE '\\'
         AND c.deleted_at IS NULL AND c.team_id IS t.team_id AND (t.team_id IS NOT NULL OR c.user_id = t.user_id)))`);
    params.push(likePattern(q), likePattern(q));
  }
  if (from)        { where.push('t.occurred_at >= ?'); params.push(from); }
  if (to)          { where.push('t.occurred_at <= ?'); params.push(to); }
  if (type)        { where.push('t.type = ?'); params.push(type); }
  if (category_id) { where.push('EXISTS (SELECT 1 FROM transaction_categories tc WHERE tc.transaction_id = t.id AND tc.category_id = ?)'); params.push(category_id); }
  if (card_id)     { where.push('t.card_id = ?'); params.push(card_id); }
  if (loans === 'only')    where.push('t.loan_id IS NOT NULL');
  if (loans === 'exclude') where.push('t.loan_id IS NULL');
  const FROM = 'FROM transactions t';

  const t = db.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN t.loan_id IS NULL AND t.type = 'income'  THEN t.amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.loan_id IS NULL AND t.type = 'expense' THEN t.amount END), 0) AS expense,
            COALESCE(SUM(CASE WHEN t.type = 'card_payment' THEN t.amount END), 0) AS card_payments
       ${FROM} WHERE ${where.join(' AND ')}`
  ).get(...params);

  const dir = sort === 'asc' ? 'ASC' : 'DESC';
  const pageWhere = [...where];
  const pageParams = [...params];
  if (cursor) {
    pageWhere.push(`(t.occurred_at, t.id) ${dir === 'ASC' ? '>' : '<'} (?, ?)`);
    pageParams.push(cursor[0], cursor[1]);
  }
  const rows = db.prepare(
    `SELECT t.* ${FROM} WHERE ${pageWhere.join(' AND ')}
      ORDER BY t.occurred_at ${dir}, t.id ${dir} LIMIT ?`
  ).all(...pageParams, limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    items: decorate(page).map((r) => ({ ...r, amount: toDecimal(r.amount) })),
    next_cursor: hasMore ? encodeCursor([last.occurred_at, last.id]) : null,
    totals: {
      income: toDecimal(t.income),
      expense: toDecimal(t.expense),
      card_payments: toDecimal(t.card_payments),
      net: toDecimal(t.income - t.expense),
      count: t.count,
    },
  };
};

const TransactionModel = { ...base, findById, findAll, create, update, createJournal, createCardPayment, createTransferRow, search, assertCategoriesInScope, assertCardInScope, cardIsLive };

module.exports = { TransactionModel };
