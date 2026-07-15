'use strict';
const { Router } = require('express');
const { EventModel } = require('../db/model');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const positiveInt = (raw, name) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${name} must be a positive integer`, 400);
  return n;
};

// Read-only feed, newest first, scoped by the request context like /transactions.
// No restGenerator — events are immutable history, and reads are open to all roles
// (resolveContext already rejects non-members).
const router = Router();

router.get('/', (req, res, next) => {
  try {
    const { entity, action } = req.query;
    const since_id = positiveInt(req.query.since_id, 'since_id');
    const limit = Math.min(positiveInt(req.query.limit, 'limit') ?? 50, 200);
    res.json(EventModel.listFeed(req.context, { entity, action, since_id, limit }));
  } catch (e) { next(e); }
});

module.exports = router;
