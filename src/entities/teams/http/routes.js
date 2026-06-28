'use strict';
const { Router } = require('express');
const { restGenerator } = require('../../../utils/restGenerator');
const { TeamModel } = require('../db/model');
const { teamHooks } = require('./hooks');
const ctrl = require('./controller');

const router = Router();

// Custom routes registered BEFORE restGenerator so the membership-aware list/detail
// and the role-based mutate/delete shadow the generated creator-scoped handlers, and
// member routes aren't swallowed by /:id.
router.get('/',                       ctrl.listMine);
router.get('/:id',                    ctrl.getOne);
router.get('/:id/members',            ctrl.listMembers);
router.post('/:id/members',           ctrl.addMember);
router.put('/:id/members/:userId',    ctrl.changeRole);
router.delete('/:id/members/:userId', ctrl.removeMember);
router.put('/:id',                    ctrl.update);   // role-based (any owner), not creator-scoped
router.delete('/:id',                 ctrl.destroy);  // role-based + blocked unless empty

// Only the generated POST / remains live (creates a team; CREATE hook adds the creator
// as owner). GET /, GET /:id, PUT /:id, DELETE /:id are shadowed by the routes above.
restGenerator(TeamModel, router, teamHooks);
module.exports = router;
