'use strict';
const { LIST_ALL } = require('../../../constants/hooks');

const listAllHandler = (entity, hook) => (req, res, next) => {
  try {
    const filters = {};
    for (const k of entity.filterFields) {
      if (req.query[k] !== undefined) filters[k] = req.query[k];
    }
    const records = entity.findAll(req.userId, filters);
    if (hook) hook({ type: LIST_ALL, records, req });
    res.json(records);
  } catch (e) { next(e); }
};

module.exports = { listAllHandler };
