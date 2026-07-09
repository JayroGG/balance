'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { ShoppingListModel } = require('../db/model');
const { shoppingListHooks } = require('./hooks');
const ctrl = require('./controller');

const router = Router();

// Custom route registered BEFORE restGenerator so /:id/checkout is not swallowed by /:id.
router.post('/:id/checkout', ctrl.checkout);

restGenerator(ShoppingListModel, router, shoppingListHooks);
module.exports = router;
