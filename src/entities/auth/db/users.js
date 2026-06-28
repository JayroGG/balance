'use strict';
const db = require('../../../config/db');

// Lookup for login; returns the gate flags + hash + global role, or undefined.
const findByEmail = (email) =>
  db.prepare(
    `SELECT id, email, password_hash, role, active, verified
       FROM users WHERE email = ? AND deleted_at IS NULL`
  ).get(email);

// Global role ('user' | 'admin') for an active user — used by the bypass path.
const roleById = (id) => {
  const row = db.prepare(`SELECT role FROM users WHERE id = ? AND deleted_at IS NULL`).get(id);
  return row ? row.role : 'user';
};

module.exports = { findByEmail, roleById };
