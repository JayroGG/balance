'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { LoanModel } = require('../db/model');
const { loanHooks } = require('./hooks');
const ctrl = require('./controller');

const router = Router();

// Custom routes registered BEFORE restGenerator so /:id/history, /:id/lend,
// and /:id/repay are not swallowed by /:id. POST / also shadows the generated
// createHandler — the loan creation semantics (plain / with amount /
// pre_existing) need the controller, so restGenerator's POST / never runs.
router.get('/:id/history', ctrl.getHistory);
router.post('/:id/lend',   ctrl.lend);
router.post('/:id/repay',  ctrl.repay);
router.post('/',           ctrl.create);

restGenerator(LoanModel, router, loanHooks);
module.exports = router;
