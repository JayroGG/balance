'use strict';
const crypto = require('crypto');
const db = require('../../../config/db');

const TTL_MS = 5 * 60 * 1000;
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

// Expired rows (used or not) are dead weight: prune on every issue/consume.
const prune = (nowIso) => db.prepare(`DELETE FROM step_up_permits WHERE expires_at <= ?`).run(nowIso);

// Random permit bound to the user; only its hash is stored (ADR-018).
const issue = (userId) => {
  const now = new Date();
  prune(now.toISOString());
  const permit = crypto.randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + TTL_MS).toISOString();
  db.prepare(`INSERT INTO step_up_permits (user_id, token_hash, expires_at) VALUES (?, ?, ?)`)
    .run(userId, sha256(permit), expiresAt);
  return { permit, expires_at: expiresAt };
};

// Atomic single-use: the conditional UPDATE only matches an unused, unexpired permit of this user.
const consume = (userId, permit) => {
  if (typeof permit !== 'string' || !permit) return false;
  const nowIso = new Date().toISOString();
  prune(nowIso);
  return db.prepare(
    `UPDATE step_up_permits SET used_at = ?
      WHERE token_hash = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?`
  ).run(nowIso, sha256(permit), userId, nowIso).changes === 1;
};

module.exports = { issue, consume };
