'use strict';
// Test DB bootstrap + row-level helpers. Requiring this applies the schema
// (idempotent, same as server boot) against the .env.test DB file.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../src/config/db');

db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), 'utf8'));

// Child → parent order (foreign_keys is ON). transactions <-> captures reference
// each other, so FKs are suspended for the wipe — no order satisfies a cycle.
const TABLES = ['vault_history', 'captures', 'transactions', 'source_aliases',
  'payment_sources', 'vaults', 'categories', 'team_members', 'teams', 'sessions', 'users'];

const wipeAll = () => {
  db.pragma('foreign_keys = OFF');
  TABLES.forEach((t) => db.prepare(`DELETE FROM ${t}`).run());
  db.pragma('foreign_keys = ON');
};

// Active + verified user ready to log in; returns its id. Low bcrypt cost — test speed.
const seedUser = (email, password, role = 'user') =>
  db.prepare(
    `INSERT INTO users (email, password_hash, role, active, verified) VALUES (?, ?, ?, 1, 1)`
  ).run(email, bcrypt.hashSync(password, 4), role).lastInsertRowid;

module.exports = { db, wipeAll, seedUser };
