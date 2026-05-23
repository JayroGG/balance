'use strict';
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

const CategoryModel = modelGenerator(ENTITY_NAME, fields);
module.exports = { CategoryModel };
