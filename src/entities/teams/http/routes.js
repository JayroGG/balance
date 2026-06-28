'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { TeamModel } = require('../db/model');
const { teamHooks } = require('./hooks');
const ctrl = require('./controller');

const router = Router();

// Custom routes registered BEFORE restGenerator so the membership-aware
// list/detail shadow the owner-scoped generated handlers, and member
// routes aren't swallowed by /:id.
router.get('/',                 ctrl.listMine);
router.get('/:id',              ctrl.getOne);
router.get('/:id/members',      ctrl.listMembers);
router.post('/:id/members',     ctrl.addMember);
router.delete('/:id/members/:userId', ctrl.removeMember);

// Generated POST /, PUT /:id, DELETE /:id stay owner-scoped (correct for mutate/delete).
restGenerator(TeamModel, router, teamHooks);
module.exports = router;
