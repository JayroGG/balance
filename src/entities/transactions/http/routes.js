'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { TransactionModel } = require('../db/model');
const { transactionHooks } = require('./hooks');

const router = Router();
restGenerator(TransactionModel, router, transactionHooks);
module.exports = router;
