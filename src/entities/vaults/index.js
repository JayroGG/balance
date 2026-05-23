'use strict';
const { VaultModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: VaultModel, routes };
module.exports = { Entity };
