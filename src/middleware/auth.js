'use strict';
// The single identity boundary (ADR-001). Resolves a request into req.userId
// (+ a default personal req.context). Everything downstream reads identity only
// from req.userId / req.context. Swapping mechanisms means editing only this file.
const jwt = require('jsonwebtoken');
const { authBypass, nodeEnv, jwtSecret } = require('../config/env');
const sessions = require('../entities/auth/db/sessions');

const setIdentity = (req, userId, sessionId) => {
  req.userId = userId;
  req.context = { userId, teamId: null };
  if (sessionId != null) req.sessionId = sessionId;
};

const unauthorized = () => Object.assign(new Error('Unauthorized'), { status: 401 });

module.exports = (req, res, next) => {
  // Bypass stub (ADR-001) — stage only; env.js already blocks it in prod.
  if (authBypass && nodeEnv === 'stage') {
    setIdentity(req, 1);
    return next();
  }

  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();

    const { sub, jti } = jwt.verify(token, jwtSecret); // throws on bad sig / expiry
    const session = sessions.findById(Number(jti));

    // Token proves who; the session row proves still-allowed (real logout).
    if (!session || session.user_id !== sub || session.revoked_at || session.expires_at <= new Date().toISOString()) {
      throw unauthorized();
    }

    setIdentity(req, sub, session.id);
    next();
  } catch (e) {
    next(e.status ? e : unauthorized()); // jwt errors -> 401
  }
};
