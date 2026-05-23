'use strict';
const { BEFORE_CREATE, CREATE } = require('../../../constants/hooks');

const createHandler = (entity, hook) => (req, res, next) => {
  try {
    let body = { ...req.body };
    if (hook) {
      const modified = hook({ type: BEFORE_CREATE, body, req });
      if (modified) body = { ...body, ...modified };
    }
    const record = entity.create(req.userId, body);
    if (hook) hook({ type: CREATE, record, req });
    res.status(201).json(record);
  } catch (e) { next(e); }
};

module.exports = { createHandler };
