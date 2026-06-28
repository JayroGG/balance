'use strict';
// Admin helper: create (or reset) a user directly in the DB — the manual
// active/verified provisioning path from ADR-003 (no signup flow yet).
//
//   NODE_ENV=stage node src/db/createUser.js <email> <password>
//
// Idempotent on email (UNIQUE): re-running updates the password and re-activates.
const bcrypt = require('bcryptjs');
const db = require('../config/db');

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node src/db/createUser.js <email> <password>');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
const info = db.prepare(
  `INSERT INTO users (email, password_hash, active, verified)
        VALUES (?, ?, 1, 1)
     ON CONFLICT(email) DO UPDATE
        SET password_hash = excluded.password_hash, active = 1, verified = 1, deleted_at = NULL`
).run(email, hash);

const user = db.prepare(`SELECT id, email, active, verified FROM users WHERE email = ?`).get(email);
console.log(info.changes ? 'User ready:' : 'No change:', user);
