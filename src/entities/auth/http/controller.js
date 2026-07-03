'use strict';
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { jwtSecret, jwtExpiresIn } = require('../../../config/env');
const users = require('../db/users');
const sessions = require('../db/sessions');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// Single generic failure — never reveal which check failed (bad creds vs
// inactive vs unverified). The token's existence already means "trusted".
const INVALID = () => httpError('Invalid credentials', 401);

const login = (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw httpError('Missing email or password', 400);

    const user = users.findByEmail(email);
    if (!user) throw INVALID();
    if (!bcrypt.compareSync(password, user.password_hash || '')) throw INVALID();
    if (!user.active || !user.verified) throw INVALID();

    // Insert session -> sign token with its id as jti -> pin expiry to the token's exp.
    const sessionId = sessions.create(user.id, req.ip, req.get('user-agent'));
    const token = jwt.sign(
      { sub: user.id, email: user.email, role: user.role, jti: String(sessionId) },
      jwtSecret,
      { expiresIn: jwtExpiresIn },
    );
    sessions.setExpiry(sessionId, new Date(jwt.decode(token).exp * 1000).toISOString());

    res.json({ token });
  } catch (e) { next(e); }
};

const logout = (req, res, next) => {
  try {
    sessions.revoke(req.sessionId); // set by the auth middleware that validated this request
    res.status(204).send();
  } catch (e) { next(e); }
};

// --- Automation tokens (ingest scope) ---
// Shortcuts/MacroDroid can't refresh a JWT, so they get a long-lived one whose
// session row carries scope 'ingest'; the app-level guard limits it to
// POST /captures. Revocation = the same session-revoke path as logout.
const INGEST_TOKEN_TTL = '365d';

const createToken = (req, res, next) => {
  try {
    const { name } = req.body;
    if (!name) throw httpError('Missing required field: name', 400);

    const sessionId = sessions.create(req.userId, req.ip, req.get('user-agent'), name, 'ingest');
    const token = jwt.sign(
      { sub: req.userId, role: users.roleById(req.userId), jti: String(sessionId), scope: 'ingest' },
      jwtSecret,
      { expiresIn: INGEST_TOKEN_TTL },
    );
    sessions.setExpiry(sessionId, new Date(jwt.decode(token).exp * 1000).toISOString());

    res.status(201).json({ id: sessionId, name, token }); // token shown once
  } catch (e) { next(e); }
};

const listTokens = (req, res, next) => {
  try {
    res.json(sessions.listTokens(req.userId));
  } catch (e) { next(e); }
};

const revokeToken = (req, res, next) => {
  try {
    const row = sessions.findToken(req.userId, Number(req.params.id));
    if (!row) throw httpError('Token not found', 404);
    sessions.revoke(row.id);
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { login, logout, createToken, listTokens, revokeToken };
