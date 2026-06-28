'use strict';
const { Router } = require('express');
const ctrl = require('./controller');

// Login is public (mounted before the auth middleware); logout is protected
// (needs a validated token so the middleware can set req.sessionId).
const publicRoutes = Router();
publicRoutes.post('/login', ctrl.login);

const protectedRoutes = Router();
protectedRoutes.post('/logout', ctrl.logout);

module.exports = { publicRoutes, protectedRoutes };
