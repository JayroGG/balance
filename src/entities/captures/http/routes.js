'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { CaptureModel } = require('../db/model');
const ctrl = require('./controller');

const router = Router();

// The ingest pipeline replaces the generated POST; custom routes registered
// BEFORE restGenerator so they win the route match.
router.post('/', ctrl.ingest);
router.post('/:id/confirm', ctrl.confirm);
router.post('/:id/discard', ctrl.discard);

restGenerator(CaptureModel, router);
module.exports = router;
