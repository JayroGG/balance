'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { ShoppingListItemModel } = require('../db/model');
const { shoppingListItemHooks } = require('./hooks');

const router = Router();
restGenerator(ShoppingListItemModel, router, shoppingListItemHooks);
module.exports = router;
