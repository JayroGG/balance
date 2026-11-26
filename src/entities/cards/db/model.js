'use strict';
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');
const { figures } = require('./figures');

const base = modelGenerator(ENTITY_NAME, fields);

// Every read carries the derived figures (owed, statement, due date, open period).
const view = (card) => (card ? { ...card, ...figures(card) } : card);

const CardModel = {
  ...base,
  findAll:  (scope, filters) => base.findAll(scope, filters).map(view),
  findById: (scope, id) => view(base.findById(scope, id)),
  create:   (scope, data) => view(base.create(scope, data)),
  update:   (scope, id, data) => { base.update(scope, id, data); return view(base.findById(scope, id)); },
};

module.exports = { CardModel };
