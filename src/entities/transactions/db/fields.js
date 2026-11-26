'use strict';
const fields = {
  create:       ['type', 'amount', 'description', 'occurred_at', 'card_id'],
  update:       ['type', 'amount', 'description', 'occurred_at', 'card_id'],
  moneyFields:  ['amount'],
  filterFields: ['type'],
  teamScoped:   true,
};
module.exports = { fields };
