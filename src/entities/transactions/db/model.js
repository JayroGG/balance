'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const TransactionModel = {
  ...modelGenerator(ENTITY_NAME, fields),

  // Raw read (cents, no decimal conversion) — used internally by vaults controller
  findByIdRaw(userId, id) {
    return db.prepare(
      `SELECT * FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).get(id, userId);
  },

  setVaultId(userId, id, vaultId) {
    db.prepare(
      `UPDATE transactions SET vault_id = ?, updated_at = ${NOW} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
    ).run(vaultId, id, userId);
  },
};

module.exports = { TransactionModel };
