'use strict';
const { TeamModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: TeamModel, routes };
module.exports = { Entity };
