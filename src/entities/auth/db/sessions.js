'use strict';
const db = require('../../../config/db');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

// Insert first (expires_at = issued_at placeholder) so the row id can become the
// token's jti; the controller then calls setExpiry with the token's real exp.
// name/scope are set only for automation tokens (scope 'ingest').
const create = (userId, ip, ua, name = null, scope = null) =>
  db.prepare(
    `INSERT INTO sessions (user_id, expires_at, ip, user_agent, name, scope)
     VALUES (?, ${NOW}, ?, ?, ?, ?)`
  ).run(userId, ip, ua, name, scope).lastInsertRowid;

// Automation tokens (long-lived ingest-scoped sessions), listed / revoked by owner.
const listTokens = (userId) =>
  db.prepare(
    `SELECT id, name, issued_at, expires_at FROM sessions
      WHERE user_id = ? AND scope = 'ingest' AND revoked_at IS NULL`
  ).all(userId);

const findToken = (userId, id) =>
  db.prepare(
    `SELECT * FROM sessions
      WHERE id = ? AND user_id = ? AND scope = 'ingest' AND revoked_at IS NULL`
  ).get(id, userId);

const setExpiry = (id, expiresAtISO) =>
  db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(expiresAtISO, id);

const findById = (id) =>
  db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);

const revoke = (id) =>
  db.prepare(`UPDATE sessions SET revoked_at = ${NOW} WHERE id = ? AND revoked_at IS NULL`).run(id);

module.exports = { create, setExpiry, findById, revoke, listTokens, findToken };
