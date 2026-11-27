'use strict';
// Transfers (ADR-017) are append-only: insert + reads only. Hand-written (no modelGenerator): a transfer
// belongs to TWO contexts, so generic user/team scoping does not apply.
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');

const insert = ({ userId, fromTeamId, toTeamId, amountCents, description, occurredAt, reversalOf }) =>
  db.prepare(
    `INSERT INTO transfers (user_id, from_team_id, to_team_id, amount, description, occurred_at, reversal_of)
     VALUES (?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%d', 'now')), ?)`
  ).run(userId, fromTeamId, toTeamId, amountCents, description ?? null, occurredAt ?? null, reversalOf ?? null)
    .lastInsertRowid;

const raw = (id) => db.prepare(`SELECT * FROM transfers WHERE id = ?`).get(id);

// "<email local part> (personal)" for the actor's personal side, the team name otherwise.
const label = (teamId, actorId) => {
  if (teamId != null) return db.prepare(`SELECT name FROM teams WHERE id = ?`).get(teamId)?.name ?? null;
  const email = db.prepare(`SELECT email FROM users WHERE id = ?`).get(actorId)?.email ?? '';
  return `${email.split('@')[0]} (personal)`;
};

// Vault parts: withdraws that funded the transfer, or allocates written by a reversal.
const vaultParts = (id) => db.prepare(
  `SELECT vh.vault_id, v.name AS vault_name, vh.action, vh.amount
     FROM vault_history vh JOIN vaults v ON v.id = vh.vault_id
    WHERE vh.transfer_id = ? ORDER BY vh.id`
).all(id).map((p) => ({ ...p, amount: toDecimal(p.amount) }));

// Vault parts belong to the SOURCE context: destination-side viewers must not see its vault names/amounts.
const view = (t, withVaults = true) => ({
  id: t.id,
  user_id: t.user_id,
  from_team_id: t.from_team_id,
  to_team_id: t.to_team_id,
  from_label: label(t.from_team_id, t.user_id),
  to_label: label(t.to_team_id, t.user_id),
  amount: toDecimal(t.amount),
  description: t.description,
  occurred_at: t.occurred_at,
  created_at: t.created_at,
  reversal_of: t.reversal_of,
  reversed_by: db.prepare(`SELECT id FROM transfers WHERE reversal_of = ?`).get(t.id)?.id ?? null,
  vaults: withVaults ? vaultParts(t.id) : [],
});

// Transfers touching the context: a team on either side, or (personal) the user's own with a NULL side.
const touches = ({ userId, teamId, targetUserId }) => (teamId != null
  ? { sql: '(from_team_id = ? OR to_team_id = ?)', values: [teamId, teamId] }
  : { sql: '(user_id = ? AND (from_team_id IS NULL OR to_team_id IS NULL))', values: [targetUserId ?? userId] });

const isSource = ({ teamId }, t) => (teamId != null ? t.from_team_id === teamId : t.from_team_id == null);

const list = (scope) => {
  const { sql, values } = touches(scope);
  return db.prepare(`SELECT * FROM transfers WHERE ${sql} ORDER BY occurred_at DESC, id DESC`)
    .all(...values).map((t) => view(t, isSource(scope, t)));
};

const findVisible = (scope, id) => {
  const { sql, values } = touches(scope);
  const row = db.prepare(`SELECT * FROM transfers WHERE id = ? AND ${sql}`).get(id, ...values);
  return row ? view(row, isSource(scope, row)) : undefined;
};

const originalVaultWithdraws = (id) => db.prepare(
  `SELECT vh.vault_id, vh.amount, (v.deleted_at IS NULL) AS live
     FROM vault_history vh JOIN vaults v ON v.id = vh.vault_id
    WHERE vh.transfer_id = ? AND vh.action = 'withdraw' ORDER BY vh.id`
).all(id);

const TransferModel = { insert, raw, list, findVisible, label, view, originalVaultWithdraws };
module.exports = { TransferModel };
