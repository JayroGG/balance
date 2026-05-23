'use strict';
const { BEFORE_DESTROY, DESTROY } = require('../../../constants/hooks');

const destroyHandler = (entity, hook) => (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const record = entity.findById(req.userId, id);
    if (!record) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (hook) hook({ type: BEFORE_DESTROY, record, req });
    entity.softDelete(req.userId, id);
    if (hook) hook({ type: DESTROY, record, req });
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { destroyHandler };
