'use strict';
const { ShoppingListModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: ShoppingListModel, routes };
module.exports = { Entity };
