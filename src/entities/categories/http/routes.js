'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { CategoryModel } = require('../db/model');
const { categoryHooks } = require('./hooks');

const router = Router();
restGenerator(CategoryModel, router, categoryHooks);
module.exports = router;
