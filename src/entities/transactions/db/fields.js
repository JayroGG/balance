'use strict';
const fields = {
  create:       ['type', 'amount', 'category_id', 'vault_id', 'description', 'occurred_at'],
  update:       ['type', 'amount', 'category_id', 'vault_id', 'description', 'occurred_at'],
  moneyFields:  ['amount'],
  filterFields: ['type', 'vault_id', 'category_id'],
};
module.exports = { fields };
