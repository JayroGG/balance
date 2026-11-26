'use strict';
const fields = {
  create:       ['type', 'amount', 'description', 'occurred_at'],
  update:       ['type', 'amount', 'description', 'occurred_at'],
  moneyFields:  ['amount'],
  filterFields: ['type'],
  teamScoped:   true,
};
module.exports = { fields };
