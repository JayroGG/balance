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

// Gate flags + global role for the refresh path (JWT claims are re-read, not trusted from the old token).
const findById = (id) =>
  db.prepare(
    `SELECT id, email, role, active, verified FROM users WHERE id = ? AND deleted_at IS NULL`
  ).get(id);

const passwordHashById = (id) => {
  const row = db.prepare(`SELECT password_hash FROM users WHERE id = ? AND deleted_at IS NULL`).get(id);
  return row ? row.password_hash : undefined;
};

module.exports = { findByEmail, findById, roleById, passwordHashById };
