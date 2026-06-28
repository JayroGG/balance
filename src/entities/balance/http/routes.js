'use strict';
const { Router } = require('express');
const queries = require('../db/queries');

const router = Router();

router.get('/', (req, res, next) => {
  try { res.json(queries.get(req.context)); } catch (e) { next(e); }
});

module.exports = router;
