'use strict';
const { BEFORE_CREATE, CREATE } = require('../../../constants/hooks');
const { assertCanWrite } = require('../../../lib/access');

const createHandler = (entity, hook) => (req, res, next) => {
  try {
    const scope = req.context;
    assertCanWrite(scope);
    let body = { ...req.body };
    if (hook) {
      const modified = hook({ type: BEFORE_CREATE, body, req });
      if (modified) body = { ...body, ...modified };
    }
    const record = entity.create(scope, body);
    if (hook) hook({ type: CREATE, record, req });
    res.status(201).json(record);
  } catch (e) { next(e); }
};

module.exports = { createHandler };
