'use strict';
const db = require('../../../config/db');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

// Insert first (expires_at = issued_at placeholder) so the row id can become the
// token's jti; the controller then calls setExpiry with the token's real exp.
const create = (userId, ip, ua) =>
  db.prepare(
    `INSERT INTO sessions (user_id, expires_at, ip, user_agent) VALUES (?, ${NOW}, ?, ?)`
  ).run(userId, ip, ua).lastInsertRowid;

const setExpiry = (id, expiresAtISO) =>
  db.prepare(`UPDATE sessions SET expires_at = ? WHERE id = ?`).run(expiresAtISO, id);

const findById = (id) =>
  db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id);

const revoke = (id) =>
  db.prepare(`UPDATE sessions SET revoked_at = ${NOW} WHERE id = ? AND revoked_at IS NULL`).run(id);

module.exports = { create, setExpiry, findById, revoke };
