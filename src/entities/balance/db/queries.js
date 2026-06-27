'use strict';
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');
const { currency } = require('../../../config/env');

// --- Cent-level helpers (single source of truth, derived from the ledgers) ---

// net worth = SUM(income) - SUM(expense)
const netWorthCents = (userId) =>
  db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) AS net
    FROM transactions
    WHERE user_id = ? AND deleted_at IS NULL
  `).get(userId).net;

// vault[V] = SUM(allocate) - SUM(withdraw)
const vaultBalanceCents = (userId, vaultId) =>
  db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN action = 'allocate' THEN amount ELSE -amount END), 0) AS bal
    FROM vault_history
    WHERE user_id = ? AND vault_id = ?
  `).get(userId, vaultId).bal;

// locked = SUM of balances across active vaults
const lockedCents = (userId) =>
  db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN vh.action = 'allocate' THEN vh.amount ELSE -vh.amount END), 0) AS locked
    FROM vault_history vh
    JOIN vaults v ON v.id = vh.vault_id
    WHERE vh.user_id = ? AND v.deleted_at IS NULL
  `).get(userId).locked;

// available = net worth - locked (invariant: >= 0)
const availableCents = (userId) => netWorthCents(userId) - lockedCents(userId);

// --- API view ---

const get = (userId) => {
  const net = netWorthCents(userId);
  const locked = lockedCents(userId);

  const vaults = db.prepare(`
    SELECT v.id, v.name, v.target_amount,
           COALESCE(SUM(CASE WHEN vh.action = 'allocate' THEN vh.amount ELSE -vh.amount END), 0) AS balance
    FROM vaults v
    LEFT JOIN vault_history vh ON vh.vault_id = v.id AND vh.user_id = v.user_id
    WHERE v.user_id = ? AND v.deleted_at IS NULL
    GROUP BY v.id ORDER BY v.name
  `).all(userId);

  return {
    total:     toDecimal(net),
    available: toDecimal(net - locked),
    vaults:    vaults.map((v) => ({
      id:      v.id,
      name:    v.name,
      balance: toDecimal(v.balance),
      target:  v.target_amount !== null ? toDecimal(v.target_amount) : null,
    })),
    currency,
  };
};

module.exports = { get, netWorthCents, vaultBalanceCents, lockedCents, availableCents };
