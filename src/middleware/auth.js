'use strict';
// The single identity boundary (ADR-001). Resolves a request into req.userId
// (+ a default personal req.context). Everything downstream reads identity only
// from req.userId / req.context. Swapping mechanisms means editing only this file.
const jwt = require('jsonwebtoken');
const { authBypass, nodeEnv, jwtSecret } = require('../config/env');
const sessions = require('../entities/auth/db/sessions');
const users = require('../entities/auth/db/users');

// `role` here is the GLOBAL role ('user'|'admin'). context.role is the per-team
// role (set later by resolveContext); the two are independent. isAdmin overrides
// team RBAC, membership, and ownership everywhere downstream.
const setIdentity = (req, userId, sessionId, role) => {
  const isAdmin = role === 'admin';
  req.userId = userId;
  req.isAdmin = isAdmin;
  req.context = { userId, teamId: null, role: null, isAdmin };
  if (sessionId != null) req.sessionId = sessionId;
};

const unauthorized = () => Object.assign(new Error('Unauthorized'), { status: 401 });

module.exports = (req, res, next) => {
  // Bypass stub (ADR-001) — stage only; env.js already blocks it in prod.
  // Read the seeded user's role from the DB so admin can be exercised under bypass.
  if (authBypass && nodeEnv === 'stage') {
    setIdentity(req, 1, undefined, users.roleById(1));
    return next();
  }

  try {
    const header = req.get('authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) throw unauthorized();

    const { sub, jti, role } = jwt.verify(token, jwtSecret); // throws on bad sig / expiry
    const session = sessions.findById(Number(jti));

    // Token proves who; the session row proves still-allowed (real logout).
    if (!session || session.user_id !== sub || session.revoked_at || session.expires_at <= new Date().toISOString()) {
      throw unauthorized();
    }

    setIdentity(req, sub, session.id, role);
    next();
  } catch (e) {
    next(e.status ? e : unauthorized()); // jwt errors -> 401
  }
};
