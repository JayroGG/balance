'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { CardModel } = require('../db/model');
const { cardHooks } = require('./hooks');
const ctrl = require('./controller');

const router = Router();

// Custom route registered BEFORE restGenerator so /:id/pay is not swallowed by /:id.
router.post('/:id/pay', ctrl.pay);

restGenerator(CardModel, router, cardHooks);
module.exports = router;
