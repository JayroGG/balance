'use strict';
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');
const { currency } = require('../../../config/env');

// --- Context scoping (single source of truth, derived from the ledgers) ---
// A scope is { userId, teamId }. teamId null -> personal (the user's own,
// untagged rows); teamId set -> that team's rows (membership verified upstream).

// SQL fragment + value to scope a table's rows to the context.
const where = ({ userId, teamId }) =>
  teamId != null
    ? { sql: 'team_id = ?', value: teamId }
    : { sql: 'user_id = ? AND team_id IS NULL', value: userId };

// net worth = SUM(income) - SUM(expense)
const netWorthCents = (scope) => {
  const { sql, value } = where(scope);
  return db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type = 'income' THEN amount ELSE -amount END), 0) AS net
    FROM transactions
    WHERE ${sql} AND deleted_at IS NULL
  `).get(value).net;
};

// vault[V] = SUM(allocate) - SUM(withdraw). The vault belongs to exactly one
// context, and is authorized upstream, so we sum purely by vault_id.
const vaultBalanceCents = (scope, vaultId) =>
  db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN action = 'allocate' THEN amount ELSE -amount END), 0) AS bal
    FROM vault_history
    WHERE vault_id = ?
  `).get(vaultId).bal;

// locked = SUM of balances across the context's active vaults
const lockedCents = (scope) => {
  const { sql, value } = where(scope);
  return db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN vh.action = 'allocate' THEN vh.amount ELSE -vh.amount END), 0) AS locked
    FROM vault_history vh
    JOIN vaults v ON v.id = vh.vault_id
    WHERE v.${sql} AND v.deleted_at IS NULL
  `).get(value).locked;
};

// available = net worth - locked (invariant: >= 0)
const availableCents = (scope) => netWorthCents(scope) - lockedCents(scope);

// --- API view ---

const get = (scope) => {
  const net = netWorthCents(scope);
  const locked = lockedCents(scope);
  const { sql, value } = where(scope);

  const vaults = db.prepare(`
    SELECT v.id, v.name, v.target_amount,
           COALESCE(SUM(CASE WHEN vh.action = 'allocate' THEN vh.amount ELSE -vh.amount END), 0) AS balance
    FROM vaults v
    LEFT JOIN vault_history vh ON vh.vault_id = v.id
    WHERE v.${sql} AND v.deleted_at IS NULL
    GROUP BY v.id ORDER BY v.name
  `).all(value);

  return {
    total:     toDecimal(net),
    available: toDecimal(net - locked),
    vaults:    vaults.map((v) => ({
      id:      v.id,
      name:    v.name,
      balance: toDecimal(v.balance),
      target:  v.target_amount != null ? toDecimal(v.target_amount) : null,
    })),
    currency,
  };
};

module.exports = { get, netWorthCents, vaultBalanceCents, lockedCents, availableCents };
