'use strict';
const { SourceAliasModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: SourceAliasModel, routes };
module.exports = { Entity };
