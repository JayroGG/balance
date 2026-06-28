'use strict';
const db = require('../../../config/db');

// Lookup for login; returns the gate flags + hash, or undefined.
const findByEmail = (email) =>
  db.prepare(
    `SELECT id, email, password_hash, active, verified
       FROM users WHERE email = ? AND deleted_at IS NULL`
  ).get(email);

module.exports = { findByEmail };
