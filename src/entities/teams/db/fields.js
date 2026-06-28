'use strict';
// Teams are owner/user-scoped (NOT teamScoped). Access for non-owner members
// is handled by team_members via custom routes, not the generic CRUD scope.
const fields = {
  create:       ['name'],
  update:       ['name'],
  moneyFields:  [],
  filterFields: [],
};
module.exports = { fields };
