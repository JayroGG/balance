'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { CaptureModel } = require('../db/model');
const ctrl = require('./controller');

const router = Router();

// The ingest pipeline replaces the generated POST; registered BEFORE
// restGenerator so it wins the route match.
router.post('/', ctrl.ingest);

restGenerator(CaptureModel, router);
module.exports = router;
