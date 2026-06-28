'use strict';
const { publicRoutes, protectedRoutes } = require('./http/routes');

const Entity = { publicRoutes, protectedRoutes };
module.exports = { Entity };
