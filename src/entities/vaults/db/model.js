'use strict';
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');
const { sortForUser } = require('./order');

const base = modelGenerator(ENTITY_NAME, fields);

// The list is returned in the caller's own order (ADR-016).
const findAll = (scope, filters) => sortForUser(scope.userId, base.findAll(scope, filters));

const VaultModel = { ...base, findAll };
module.exports = { VaultModel };
