'use strict';
const { Router } = require('express');
const ctrl = require('./controller');

// No table, no restGenerator: a transfer IS two transactions rows sharing a
// transfer_group_id. Contexts come from the body (from/to), not ?team_id=.
const router = Router();
router.post('/', ctrl.create);
router.delete('/:group_id', ctrl.destroy);
module.exports = router;
