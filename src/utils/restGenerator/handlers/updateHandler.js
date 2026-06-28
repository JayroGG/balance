'use strict';
const { BEFORE_UPDATE, UPDATE } = require('../../../constants/hooks');
const { assertCanMutate } = require('../../../lib/access');

const updateHandler = (entity, hook) => (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const scope = req.context;
    const previous = entity.findById(scope, id);
    if (!previous) { const e = new Error('Not found'); e.status = 404; throw e; }
    assertCanMutate(scope, previous);
    let body = { ...req.body };
    if (hook) {
      const modified = hook({ type: BEFORE_UPDATE, body, previous, req });
      if (modified) body = { ...body, ...modified };
    }
    const record = entity.update(scope, id, body);
    if (hook) hook({ type: UPDATE, record, previous, req });
    res.json(record);
  } catch (e) { next(e); }
};

module.exports = { updateHandler };
