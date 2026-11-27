'use strict';
const db = require('../../../config/db');
const { toCents, toDecimal } = require('../../../lib/money');
const { currency } = require('../../../config/env');
const { figures } = require('../../cards/db/figures');

// --- Context scoping (single source of truth, derived from the ledgers) ---
// A scope is { userId, teamId }. teamId null -> personal (the user's own,
// untagged rows); teamId set -> that team's rows (membership verified upstream).

// SQL fragment + value to scope a table's rows to the context. An admin's chosen
// team flows through teamId; an admin targeting a user's personal data sets targetUserId.
const where = ({ userId, teamId, targetUserId }) =>
  teamId != null
    ? { sql: 'team_id = ?', value: teamId }
    : { sql: 'user_id = ? AND team_id IS NULL', value: targetUserId != null ? targetUserId : userId };

// net worth = SUM(income + transfers in) - SUM(expense + card payments + transfers out). Skips loan journal rows (display-only)
// and card charges (ADR-014: cash hasn't moved until the card is paid).
const netWorthCents = (scope) => {
  const { sql, value } = where(scope);
  return db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN type IN ('income', 'transfer_in') THEN amount ELSE -amount END), 0) AS net
    FROM transactions
    WHERE ${sql} AND deleted_at IS NULL AND loan_id IS NULL
      AND (card_id IS NULL OR type = 'card_payment')
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

// loan[L] pending = SUM(lend) - SUM(repay). The loan belongs to exactly one
// context, and is authorized upstream, so we sum purely by loan_id.
const loanPendingCents = (scope, loanId) =>
  db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN action = 'lend' THEN amount ELSE -amount END), 0) AS pending
    FROM loan_history
    WHERE loan_id = ?
  `).get(loanId).pending;

// lent = SUM of pending across the context's active loans
const lentCents = (scope) => {
  const { sql, value } = where(scope);
  return db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN lh.action = 'lend' THEN lh.amount ELSE -lh.amount END), 0) AS lent
    FROM loan_history lh
    JOIN loans l ON l.id = lh.loan_id
    WHERE l.${sql} AND l.deleted_at IS NULL
  `).get(value).lent;
};

// available = net worth - locked - lent. Signed: may be negative (ADR-012); only allocate/lend are capped by it.
const availableCents = (scope) => netWorthCents(scope) - lockedCents(scope) - lentCents(scope);

// --- API view ---

const get = (scope) => {
  const net = netWorthCents(scope);
  const locked = lockedCents(scope);
  const lent = lentCents(scope);
  const { sql, value } = where(scope);

  const vaults = db.prepare(`
    SELECT v.id, v.name, v.target_amount,
           COALESCE(SUM(CASE WHEN vh.action = 'allocate' THEN vh.amount ELSE -vh.amount END), 0) AS balance
    FROM vaults v
    LEFT JOIN vault_history vh ON vh.vault_id = v.id
    LEFT JOIN vault_order vo ON vo.vault_id = v.id AND vo.user_id = ?
    WHERE v.${sql} AND v.deleted_at IS NULL
    GROUP BY v.id ORDER BY vo.position IS NULL, vo.position, v.created_at, v.id
  `).all(scope.userId, value);

  const loans = db.prepare(`
    SELECT l.id, l.name,
           COALESCE(SUM(CASE WHEN lh.action = 'lend' THEN lh.amount ELSE 0 END), 0)          AS amount,
           COALESCE(SUM(CASE WHEN lh.action = 'lend' THEN lh.amount ELSE -lh.amount END), 0) AS pending
    FROM loans l
    LEFT JOIN loan_history lh ON lh.loan_id = l.id
    WHERE l.${sql} AND l.deleted_at IS NULL
    GROUP BY l.id ORDER BY l.name
  `).all(value);

  const cards = db.prepare(
    `SELECT * FROM cards WHERE ${sql} AND deleted_at IS NULL ORDER BY name`
  ).all(value).map((c) => ({ id: c.id, name: c.name, ...figures(c) }));

  return {
    total:     toDecimal(net),
    available: toDecimal(net - locked - lent),
    lent:      toDecimal(lent),
    vaults:    vaults.map((v) => ({
      id:      v.id,
      name:    v.name,
      balance: toDecimal(v.balance),
      target:  v.target_amount != null ? toDecimal(v.target_amount) : null,
    })),
    loans:     loans.map((l) => ({
      id:      l.id,
      name:    l.name,
      amount:  toDecimal(l.amount),
      pending: toDecimal(l.pending),
    })),
    cards_owed: toDecimal(cards.reduce((sum, c) => sum + toCents(c.owed), 0)),
    cards:     cards.map((c) => ({
      id: c.id, name: c.name, owed: c.owed, statement_balance: c.statement_balance, due_date: c.due_date,
    })),
    currency,
  };
};

module.exports = {
  get, netWorthCents, vaultBalanceCents, lockedCents, availableCents, lentCents, loanPendingCents,
};
