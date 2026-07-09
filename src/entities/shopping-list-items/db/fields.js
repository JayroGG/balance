'use strict';
// Flat rows, authorized through the parent list (never team-scoped directly).
// list_id is fixed at creation; user_id is inherited from the list (see model).
const fields = {
  create:       ['list_id', 'name', 'qty', 'price', 'checked'],
  update:       ['name', 'qty', 'price', 'checked'],
  moneyFields:  ['price'],
  filterFields: ['list_id'],
  teamScoped:   false,
};
module.exports = { fields };
