'use strict';
const { CardModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: CardModel, routes };
module.exports = { Entity };
