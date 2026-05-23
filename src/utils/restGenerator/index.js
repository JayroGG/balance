'use strict';
const { listAllHandler } = require('./handlers/listAllHandler');
const { getOneHandler }  = require('./handlers/getOneHandler');
const { createHandler }  = require('./handlers/createHandler');
const { updateHandler }  = require('./handlers/updateHandler');
const { destroyHandler } = require('./handlers/destroyHandler');

const restGenerator = (entity, router, hook) => {
  router.get('/',       listAllHandler(entity, hook));
  router.get('/:id',    getOneHandler(entity, hook));
  router.post('/',      createHandler(entity, hook));
  router.put('/:id',    updateHandler(entity, hook));
  router.delete('/:id', destroyHandler(entity, hook));
  return router;
};

module.exports = { restGenerator };
