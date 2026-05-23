'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { VaultModel } = require('../db/model');
const { vaultHooks } = require('./hooks');
const ctrl = require('./controller');

const router = Router();

// Custom routes registered BEFORE restGenerator so /:id/history
// and /:id/allocate are not swallowed by /:id.
router.get('/:id/history',   ctrl.getHistory);
router.post('/:id/allocate', ctrl.allocate);
router.post('/:id/withdraw', ctrl.withdraw);

restGenerator(VaultModel, router, vaultHooks);
module.exports = router;
