'use strict';
const { ShoppingListItemModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: ShoppingListItemModel, routes };
module.exports = { Entity };
