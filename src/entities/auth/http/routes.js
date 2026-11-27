'use strict';
const { Router } = require('express');
const ctrl = require('./controller');
const stepUp = require('./stepUp');

// Login and refresh are public (mounted before the auth middleware; the refresh token is the credential);
// logout is protected
// (needs a validated token so the middleware can set req.sessionId).
const publicRoutes = Router();
publicRoutes.post('/login', ctrl.login);
publicRoutes.post('/refresh', ctrl.refresh);

const protectedRoutes = Router();
protectedRoutes.post('/logout', ctrl.logout);
protectedRoutes.post('/step-up', stepUp.issue);

module.exports = { publicRoutes, protectedRoutes };
