'use strict';
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { jwtSecret, jwtExpiresIn, refreshExpiresMs } = require('../../../config/env');
const users = require('../db/users');
const sessions = require('../db/sessions');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// Single generic failure — never reveal which check failed (bad creds vs
// inactive vs unverified). The token's existence already means "trusted".
const INVALID = () => httpError('Invalid credentials', 401);
const INVALID_REFRESH = () => httpError('Invalid refresh token', 401);

// Opaque refresh token = 32 random bytes; only its SHA-256 is stored (ADR-015).
const newRefreshToken = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const refreshExpiry = () => new Date(Date.now() + refreshExpiresMs).toISOString();

const signAccess = (user, sessionId) =>
  jwt.sign(
    { sub: user.id, email: user.email, role: user.role, jti: String(sessionId) },
    jwtSecret,
    { expiresIn: jwtExpiresIn },
  );

const login = (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) throw httpError('Missing email or password', 400);

    const user = users.findByEmail(email);
    if (!user) throw INVALID();
    if (!bcrypt.compareSync(password, user.password_hash || '')) throw INVALID();
    if (!user.active || !user.verified) throw INVALID();

    // Insert session -> sign short access token with its id as jti -> the session lives as long
    // as its refresh token (the access JWT's own exp stays short and is enforced by jwt.verify).
    const sessionId = sessions.create(user.id, req.ip, req.get('user-agent'));
    const token = signAccess(user, sessionId);
    const refreshToken = newRefreshToken();
    sessions.setRefresh(sessionId, sha256(refreshToken), refreshExpiry());

    res.json({ token, refreshToken });
  } catch (e) { next(e); }
};

// Rotation: the presented token is exchanged for a new pair on the same session. Replaying the
// previous (already rotated) token means it leaked — revoke the whole session.
const refresh = (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) throw httpError('Missing refreshToken', 400);
    if (typeof refreshToken !== 'string') throw INVALID_REFRESH();

    const hash = sha256(refreshToken);
    const session = sessions.findByRefreshHash(hash);

    if (!session) {
      const reused = sessions.findByPrevRefreshHash(hash);
      if (reused) sessions.revoke(reused.id);
      throw INVALID_REFRESH();
    }
    if (session.revoked_at || session.refresh_expires_at <= new Date().toISOString()) throw INVALID_REFRESH();

    const user = users.findById(session.user_id);
    if (!user || !user.active || !user.verified) throw INVALID_REFRESH();

    const nextRefresh = newRefreshToken();
    sessions.setRefresh(session.id, sha256(nextRefresh), refreshExpiry(), hash);

    res.json({ token: signAccess(user, session.id), refreshToken: nextRefresh });
  } catch (e) { next(e); }
};

const logout = (req, res, next) => {
  try {
    sessions.revoke(req.sessionId); // set by the auth middleware that validated this request
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { login, refresh, logout };
