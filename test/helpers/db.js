'use strict';
// Test DB bootstrap + row-level helpers. Requiring this applies the schema
// (idempotent, same as server boot) against the .env.test DB file.
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const db = require('../../src/config/db');

db.exec(fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), 'utf8'));

// Child → parent order (foreign_keys is ON).
const TABLES = ['events', 'shopping_list_items', 'shopping_lists', 'vault_history', 'transactions',
  'vaults', 'categories', 'team_members', 'teams', 'sessions', 'users'];

const wipeAll = () => TABLES.forEach((t) => db.prepare(`DELETE FROM ${t}`).run());

// Active + verified user ready to log in; returns its id. Low bcrypt cost — test speed.
const seedUser = (email, password, role = 'user') =>
  db.prepare(
    `INSERT INTO users (email, password_hash, role, active, verified) VALUES (?, ?, ?, 1, 1)`
  ).run(email, bcrypt.hashSync(password, 4), role).lastInsertRowid;

module.exports = { db, wipeAll, seedUser };
