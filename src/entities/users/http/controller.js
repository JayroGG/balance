'use strict';
const db = require('../../../config/db');
// Direct import (never via entity index) to avoid circular deps.
const { normalizeColor } = require('../../teams/http/hooks');

const readMe = (userId) =>
  db.prepare(`SELECT id, email, color FROM users WHERE id = ? AND deleted_at IS NULL`).get(userId);

const getMe = (req, res, next) => {
  try {
    const me = readMe(req.userId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    res.json(me);
  } catch (e) { next(e); }
};

const updateMe = (req, res, next) => {
  try {
    const { color } = req.body || {};
    if (color === undefined) {
      const e = new Error('Missing required field: color'); e.status = 400; throw e;
    }
    const value = normalizeColor(color); // null clears; invalid → 400
    db.prepare(`UPDATE users SET color = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND deleted_at IS NULL`)
      .run(value, req.userId);
    const me = readMe(req.userId);
    if (!me) return res.status(404).json({ error: 'User not found' });
    res.json(me);
  } catch (e) { next(e); }
};

module.exports = { getMe, updateMe };
