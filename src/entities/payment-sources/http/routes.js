'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { PaymentSourceModel } = require('../db/model');
const { paymentSourceHooks } = require('./hooks');

const router = Router();
restGenerator(PaymentSourceModel, router, paymentSourceHooks);
module.exports = router;
