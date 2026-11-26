'use strict';
const fields = {
  create:       ['name', 'cut_day', 'due_day', 'credit_limit'],
  update:       ['name', 'cut_day', 'due_day', 'credit_limit'],
  moneyFields:  ['credit_limit'],
  filterFields: [],
  teamScoped:   true,
};
module.exports = { fields };
