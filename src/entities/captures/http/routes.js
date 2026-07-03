'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { CaptureModel } = require('../db/model');

const router = Router();
restGenerator(CaptureModel, router);
module.exports = router;
