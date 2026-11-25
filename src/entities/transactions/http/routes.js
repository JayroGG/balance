'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { TransactionModel } = require('../db/model');
const { transactionHooks } = require('./hooks');
const { httpError, positiveInt, parseLimit, decodeCursor } = require('../../../lib/pagination');

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const isoDate = (raw, name) => {
  if (raw === undefined) return undefined;
  const m = DATE.exec(raw);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== raw) throw httpError(`${name} must be a valid YYYY-MM-DD date`);
  return raw;
};
const oneOf = (raw, name, allowed) => {
  if (raw === undefined) return undefined;
  if (!allowed.includes(raw)) throw httpError(`${name} must be one of: ${allowed.join(', ')}`);
  return raw;
};

const router = Router();

// Search list (ADR-011) — registered before restGenerator so it replaces the generic GET /.
router.get('/', (req, res, next) => {
  try {
    const { q: rawQ } = req.query;
    if (rawQ !== undefined && typeof rawQ !== 'string') throw httpError('q must be a string');
    const from = isoDate(req.query.from, 'from');
    const to = isoDate(req.query.to, 'to');
    if (from && to && from > to) throw httpError('from must not be after to');
    const cursor = decodeCursor(req.query.cursor);
    if (cursor && !(cursor.length === 2 && typeof cursor[0] === 'string' && Number.isInteger(cursor[1]))) {
      throw httpError('cursor is invalid');
    }
    res.json(TransactionModel.search(req.context, {
      q: rawQ?.trim() || undefined,
      from, to,
      type: oneOf(req.query.type, 'type', ['income', 'expense']),
      category_id: positiveInt(req.query.category_id, 'category_id'),
      loans: oneOf(req.query.loans, 'loans', ['only', 'exclude']),
      sort: oneOf(req.query.sort, 'sort', ['asc', 'desc']) ?? 'desc',
      limit: parseLimit(req.query.limit, { def: 30, max: 100 }),
      cursor,
    }));
  } catch (e) { next(e); }
});

restGenerator(TransactionModel, router, transactionHooks);
module.exports = router;
