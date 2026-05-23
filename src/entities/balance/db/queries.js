'use strict';
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');
const { currency } = require('../../../config/env');

const get = (userId) => {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
    FROM transactions
    WHERE user_id = ? AND deleted_at IS NULL
  `).get(userId);

  const vaults = db.prepare(`
    SELECT v.id, v.name, v.target_amount, COALESCE(SUM(t.amount), 0) AS balance
    FROM vaults v
    LEFT JOIN transactions t ON t.vault_id = v.id AND t.deleted_at IS NULL
    WHERE v.user_id = ? AND v.deleted_at IS NULL
    GROUP BY v.id ORDER BY v.name
  `).all(userId);

  const total = totals.total_income - totals.total_expense;
  const vaultTotal = vaults.reduce((sum, v) => sum + v.balance, 0);

  return {
    total:     toDecimal(total),
    available: toDecimal(total - vaultTotal),
    vaults:    vaults.map((v) => ({
      id:      v.id,
      name:    v.name,
      balance: toDecimal(v.balance),
      target:  v.target_amount !== null ? toDecimal(v.target_amount) : null,
    })),
    currency,
  };
};

module.exports = { get };
