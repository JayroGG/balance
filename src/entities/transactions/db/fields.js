'use strict';
const fields = {
  create:       ['type', 'amount', 'category_id', 'description', 'occurred_at'],
  update:       ['type', 'amount', 'category_id', 'description', 'occurred_at'],
  moneyFields:  ['amount'],
  filterFields: ['type', 'category_id'],
  teamScoped:   true,
};
module.exports = { fields };
