'use strict';
const { PaymentSourceModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: PaymentSourceModel, routes };
module.exports = { Entity };
