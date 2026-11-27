'use strict';
const bcrypt = require('bcryptjs');
const users = require('../db/users');
const stepUp = require('../db/stepUp');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// POST /auth/step-up { password } — re-proves identity against the caller's OWN password (no admin bypass).
const issue = (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || typeof password !== 'string') throw httpError('Missing password', 400);
    const hash = users.passwordHashById(req.userId);
    if (!hash || !bcrypt.compareSync(password, hash)) throw httpError('Invalid credentials', 401);
    res.json(stepUp.issue(req.userId));
  } catch (e) { next(e); }
};

// Consume the X-Step-Up permit. Call INSIDE the action's db.transaction so a failed action rolls the
// consumption back (the user can retry with the same permit) and a successful one burns it.
const consumePermit = (req) => {
  if (!stepUp.consume(req.userId, req.get('x-step-up'))) {
    throw Object.assign(new Error('Step-up authentication required'), { status: 403, code: 'STEP_UP_REQUIRED' });
  }
};

// errorHandler only emits { error }; step-up failures also carry a machine-readable code the app reacts to.
const fail = (res, next, e) => (e.code === 'STEP_UP_REQUIRED'
  ? res.status(403).json({ error: e.message, code: e.code })
  : next(e));

module.exports = { issue, consumePermit, fail };
