'use strict';
const { EventModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: EventModel, routes };
module.exports = { Entity };
