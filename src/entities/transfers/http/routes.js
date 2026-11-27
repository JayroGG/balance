'use strict';
const { Router } = require('express');
const ctrl = require('./controller');

const router = Router();

router.post('/', ctrl.create);
router.post('/:id/reverse', ctrl.reverse);
router.get('/', ctrl.list);
router.get('/:id', ctrl.get);

module.exports = router;
