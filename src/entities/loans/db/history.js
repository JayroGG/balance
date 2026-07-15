'use strict';
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');

const add = (userId, loanId, action, amountCents) =>
  db.prepare(
    `INSERT INTO loan_history (user_id, loan_id, action, amount) VALUES (?, ?, ?, ?)`
  ).run(userId, loanId, action, amountCents);

// Scoped by loan only — the loan is authorized via context upstream, and a
// loan's full movement history (across all member actors) is the ledger.
const findByLoan = (loanId) =>
  db.prepare(
    `SELECT * FROM loan_history WHERE loan_id = ? ORDER BY created_at DESC`
  ).all(loanId).map((h) => ({ ...h, amount: toDecimal(h.amount) }));

// amount = SUM(lend); pending = SUM(lend) - SUM(repay) — one grouped query, cents.
const figures = (loanId) => {
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN action = 'lend' THEN amount ELSE 0 END), 0)          AS amount,
           COALESCE(SUM(CASE WHEN action = 'lend' THEN amount ELSE -amount END), 0)    AS pending
    FROM loan_history
    WHERE loan_id = ?
  `).get(loanId);
  return { amountCents: row.amount, pendingCents: row.pending };
};

module.exports = { add, findByLoan, figures };
