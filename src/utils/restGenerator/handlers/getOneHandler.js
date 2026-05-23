'use strict';
const { GET_ONE } = require('../../../constants/hooks');

const getOneHandler = (entity, hook) => (req, res, next) => {
  try {
    const record = entity.findById(req.userId, Number(req.params.id));
    if (!record) { const e = new Error('Not found'); e.status = 404; throw e; }
    if (hook) hook({ type: GET_ONE, record, req });
    res.json(record);
  } catch (e) { next(e); }
};

module.exports = { getOneHandler };
