'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { SourceAliasModel } = require('../db/model');
const { sourceAliasHooks } = require('./hooks');

const router = Router();
restGenerator(SourceAliasModel, router, sourceAliasHooks);
module.exports = router;
