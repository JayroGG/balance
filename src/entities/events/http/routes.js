'use strict';
const { Router } = require('express');
const { EventModel } = require('../db/model');
const { positiveInt, parseLimit } = require('../../../lib/pagination');

// Read-only feed, newest first, scoped by the request context like /transactions.
// No restGenerator — events are immutable history, and reads are open to all roles
// (resolveContext already rejects non-members).
const router = Router();

router.get('/', (req, res, next) => {
  try {
    const { entity, action } = req.query;
    const since_id = positiveInt(req.query.since_id, 'since_id');
    const limit = parseLimit(req.query.limit, { def: 50, max: 200 });
    res.json(EventModel.listFeed(req.context, { entity, action, since_id, limit }));
  } catch (e) { next(e); }
});

module.exports = router;
