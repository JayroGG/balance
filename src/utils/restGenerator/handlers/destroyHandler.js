'use strict';
const { BEFORE_DESTROY, DESTROY } = require('../../../constants/hooks');

const destroyHandler = (entity, hook) => (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const scope = req.context;
    const record = entity.findById(scope, id);
    if (!record) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (hook) hook({ type: BEFORE_DESTROY, record, req });
    entity.softDelete(scope, id);
    if (hook) hook({ type: DESTROY, record, req });
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { destroyHandler };
