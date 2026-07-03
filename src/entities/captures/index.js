'use strict';
const { CaptureModel } = require('./db/model');
const routes = require('./http/routes');

const Entity = { model: CaptureModel, routes };
module.exports = { Entity };
