'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');
const { toDecimal } = require('../../../lib/money');
const { encodeCursor } = require('../../../lib/pagination');

const base = modelGenerator(ENTITY_NAME, fields);

// Journal row for a loan movement (ADR-010): loan_id set, cents in, no hooks.
// Excluded from balance math; read-only via /transactions.
const createJournal = ({ userId, teamId }, { type, amountCents, description, loanId }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO transactions (user_id, team_id, type, amount, description, loan_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, teamId ?? null, type, amountCents, description, loanId);
  return lastInsertRowid;
};

// Escape LIKE wildcards so user text is matched literally (ESCAPE '\').
const likePattern = (q) => `%${q.replace(/[\\%_]/g, '\\$&')}%`;

// Filtered, keyset-paged list + whole-set totals (ADR-011). params are already
// validated by the route: { q, from, to, type, category_id, loans, sort, limit, cursor:[date,id] }.
// Totals ignore cursor/limit and exclude journal rows (loan_id IS NOT NULL), like balance math;
// count includes them. Every value is bound — only fixed fragments are interpolated.
const search = (scope, { q, from, to, type, category_id, loans, sort, limit, cursor }) => {
  const { sql: scopeSql, values } = base.scopeClause(scope, 't');
  const where = [scopeSql, 't.deleted_at IS NULL'];
  const params = [...values];
  if (q)           { where.push("(t.description LIKE ? ESCAPE '\\' OR c.name LIKE ? ESCAPE '\\')"); params.push(likePattern(q), likePattern(q)); }
  if (from)        { where.push('t.occurred_at >= ?'); params.push(from); }
  if (to)          { where.push('t.occurred_at <= ?'); params.push(to); }
  if (type)        { where.push('t.type = ?'); params.push(type); }
  if (category_id) { where.push('t.category_id = ?'); params.push(category_id); }
  if (loans === 'only')    where.push('t.loan_id IS NOT NULL');
  if (loans === 'exclude') where.push('t.loan_id IS NULL');
  // The join is scoped to the row's own context so q can't probe other users'/teams' category names.
  const FROM = `FROM transactions t LEFT JOIN categories c ON c.id = t.category_id
    AND c.deleted_at IS NULL AND c.team_id IS t.team_id AND (t.team_id IS NOT NULL OR c.user_id = t.user_id)`;

  const t = db.prepare(
    `SELECT COUNT(*) AS count,
            COALESCE(SUM(CASE WHEN t.loan_id IS NULL AND t.type = 'income'  THEN t.amount END), 0) AS income,
            COALESCE(SUM(CASE WHEN t.loan_id IS NULL AND t.type = 'expense' THEN t.amount END), 0) AS expense
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
    items: page.map((r) => ({ ...r, amount: toDecimal(r.amount) })),
    next_cursor: hasMore ? encodeCursor([last.occurred_at, last.id]) : null,
    totals: {
      income: toDecimal(t.income),
      expense: toDecimal(t.expense),
      net: toDecimal(t.income - t.expense),
      count: t.count,
    },
  };
};

const TransactionModel = { ...base, createJournal, search };

module.exports = { TransactionModel };
