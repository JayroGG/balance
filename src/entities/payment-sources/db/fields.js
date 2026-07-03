'use strict';
const fields = {
  create:       ['name', 'type', 'bank', 'target_team_id', 'default_category_id', 'active'],
  update:       ['name', 'type', 'bank', 'target_team_id', 'default_category_id', 'active'],
  filterFields: ['type', 'bank', 'active'],
};
module.exports = { fields };
