'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";
const base = modelGenerator(ENTITY_NAME, fields);

// Checkout flips an open list to purchased history and links its transaction.
// status/transaction_id are server-owned, so this is the only path that sets them.
const markPurchased = (scope, id, transactionId) => {
  db.prepare(
    `UPDATE shopping_lists SET status = 'purchased', transaction_id = ?, updated_at = ${NOW}
     WHERE id = ? AND deleted_at IS NULL`
  ).run(transactionId, id);
  return base.findById(scope, id);
};

const ShoppingListModel = { ...base, markPurchased };
module.exports = { ShoppingListModel };
