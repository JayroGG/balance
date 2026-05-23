'use strict';
const { CategoryModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: CategoryModel, routes };
module.exports = { Entity };
