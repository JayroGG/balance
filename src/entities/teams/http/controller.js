'use strict';
const { TeamModel } = require('../db/model');
const members = require('../db/members');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const requireRole = (userId, teamId, role) => {
  const current = members.roleOf(userId, teamId);
  if (!current) throw httpError('Team not found', 404);
  if (role && current !== role) throw httpError(`Requires team ${role} role`, 403);
  return current;
};

// Teams I belong to (member or owner), not just the ones I created.
const listMine = (req, res, next) => {
  try { res.json(TeamModel.listForMember(req.userId)); } catch (e) { next(e); }
};

// Member-only detail (the generated GET /:id is owner-scoped and would hide member-only teams).
const getOne = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req.userId, teamId);
    res.json(TeamModel.getById(teamId));
  } catch (e) { next(e); }
};

const listMembers = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req.userId, teamId);
    res.json(members.listMembers(teamId));
  } catch (e) { next(e); }
};

const addMember = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req.userId, teamId, 'owner');

    const { email, user_id, role = 'member' } = req.body;
    if (!['owner', 'member'].includes(role)) throw httpError("role must be 'owner' or 'member'", 400);

    const targetId = user_id ?? members.findUserByEmail(email)?.id;
    if (!targetId) throw httpError('User not found', 404);

    members.addMember(teamId, targetId, role);
    res.status(201).json(members.listMembers(teamId));
  } catch (e) { next(e); }
};

const removeMember = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    requireRole(req.userId, teamId, 'owner');

    if (members.roleOf(targetId, teamId) === 'owner' && members.countOwners(teamId) <= 1) {
      throw httpError('Cannot remove the last owner', 400);
    }
    members.removeMember(teamId, targetId);
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { listMine, getOne, listMembers, addMember, removeMember };
