'use strict';
const { Router } = require('express');
const ctrl = require('./controller');

// Own row only: there is no :id — the caller is always req.userId (ADR-019).
const router = Router();
router.get('/me', ctrl.getMe);
router.patch('/me', ctrl.updateMe);

module.exports = router;
