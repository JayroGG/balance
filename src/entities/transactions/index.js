'use strict';
const { TransactionModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: TransactionModel, routes };
module.exports = { Entity };
