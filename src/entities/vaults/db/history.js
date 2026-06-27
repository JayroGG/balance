'use strict';
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');

const add = (userId, vaultId, action, amountCents) =>
  db.prepare(
    `INSERT INTO vault_history (user_id, vault_id, action, amount) VALUES (?, ?, ?, ?)`
  ).run(userId, vaultId, action, amountCents);

const findByVault = (userId, vaultId) =>
  db.prepare(
    `SELECT * FROM vault_history WHERE user_id = ? AND vault_id = ? ORDER BY created_at DESC`
  ).all(userId, vaultId).map((h) => ({ ...h, amount: toDecimal(h.amount) }));

module.exports = { add, findByVault };
