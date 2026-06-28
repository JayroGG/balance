'use strict';
// Admin helper: reset an existing user's password. Unlike createUser.js this only
// updates the password of a user that already exists (and isn't soft-deleted) — it
// never creates a user and never changes active/verified.
//
//   NODE_ENV=stage node src/db/resetPassword.js <email> <newPassword>
const bcrypt = require('bcryptjs');
const db = require('../config/db');

const [, , email, password] = process.argv;
if (!email || !password) {
  console.error('Usage: node src/db/resetPassword.js <email> <newPassword>');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
const info = db.prepare(
  `UPDATE users SET password_hash = ? WHERE email = ? AND deleted_at IS NULL`
).run(hash, email);

if (!info.changes) {
  console.error(`No active user with email: ${email}`);
  process.exit(1);
}

const user = db.prepare(`SELECT id, email, active, verified FROM users WHERE email = ?`).get(email);
console.log('Password reset for:', user);
