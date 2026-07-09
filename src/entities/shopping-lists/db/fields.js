'use strict';
// status and transaction_id are server-owned (set only by checkout), so they are
// deliberately absent from create/update — the model ignores them in request bodies.
const fields = {
  create:       ['name', 'category_id'],
  update:       ['name', 'category_id'],
  moneyFields:  [],
  filterFields: ['status'],
  teamScoped:   true,
};
module.exports = { fields };
