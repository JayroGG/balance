'use strict';
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');
const { today, lastCut, dueDate } = require('../../../lib/cardCycle');

// owed = SUM(charges) - SUM(payments) over live rows (ADR-014). Cents.
const owedCents = (cardId) =>
  db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE -amount END), 0) AS owed
    FROM transactions
    WHERE card_id = ? AND deleted_at IS NULL
  `).get(cardId).owed;

// Derived statement figures, computed on read and never stored. Decimal output.
const figures = (card, todayStr = today()) => {
  const cut = lastCut(todayStr, card.cut_day);
  const r = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'expense' AND substr(occurred_at, 1, 10) <= ? THEN amount ELSE 0 END), 0) AS upto_cut,
           COALESCE(SUM(CASE WHEN type = 'expense' AND substr(occurred_at, 1, 10) >  ? THEN amount ELSE 0 END), 0) AS open,
           COALESCE(SUM(CASE WHEN type = 'card_payment' THEN amount ELSE 0 END), 0)                 AS paid
    FROM transactions
    WHERE card_id = ? AND deleted_at IS NULL
  `).get(cut, cut, card.id);
  return {
    owed:              toDecimal(r.upto_cut + r.open - r.paid),
    statement_balance: toDecimal(Math.max(0, r.upto_cut - r.paid)),
    current_period:    toDecimal(r.open),
    last_cut:          cut,
    due_date:          dueDate(cut, card.due_day),
  };
};

module.exports = { owedCents, figures };
