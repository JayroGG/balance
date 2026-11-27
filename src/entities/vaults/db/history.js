'use strict';
const db = require('../../../config/db');
const { toDecimal } = require('../../../lib/money');

const add = (userId, vaultId, action, amountCents, transferId = null) =>
  db.prepare(
    `INSERT INTO vault_history (user_id, vault_id, action, amount, transfer_id) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, vaultId, action, amountCents, transferId);

// Scoped by vault only — the vault is authorized via context upstream, and a
// vault's full movement history (across all member actors) is the ledger.
const findByVault = (vaultId) =>
  db.prepare(
    `SELECT * FROM vault_history WHERE vault_id = ? ORDER BY created_at DESC, id DESC`
  ).all(vaultId).map((h) => ({ ...h, amount: toDecimal(h.amount) }));

module.exports = { add, findByVault };
