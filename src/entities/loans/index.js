'use strict';
const { LoanModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: LoanModel, routes };
module.exports = { Entity };
