'use strict';
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

const VaultModel = modelGenerator(ENTITY_NAME, fields);
module.exports = { VaultModel };
