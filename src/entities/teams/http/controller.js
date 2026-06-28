'use strict';
const { TeamModel } = require('../db/model');
const members = require('../db/members');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const ROLES = ['owner', 'member', 'guest'];

// A global admin bypasses team-role requirements entirely (god-mode).
const requireRole = (req, teamId, role) => {
  if (req.isAdmin) return 'admin';
  const current = members.roleOf(req.userId, teamId);
  if (!current) throw httpError('Team not found', 404);
  if (role && current !== role) throw httpError(`Requires team ${role} role`, 403);
  return current;
};

// Teams I belong to (member or owner), not just the ones I created. Admin sees all teams.
const listMine = (req, res, next) => {
  try {
    res.json(req.isAdmin ? TeamModel.listAll() : TeamModel.listForMember(req.userId));
  } catch (e) { next(e); }
};

// Member-only detail (the generated GET /:id is owner-scoped and would hide member-only teams).
const getOne = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req, teamId);
    const team = TeamModel.getById(teamId);
    if (!team) throw httpError('Team not found', 404);
    res.json(team);
  } catch (e) { next(e); }
};

const listMembers = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req, teamId);
    res.json(members.listMembers(teamId));
  } catch (e) { next(e); }
};

const addMember = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req, teamId, 'owner');

    const { email, user_id, role = 'member' } = req.body;
    if (!ROLES.includes(role)) throw httpError(`role must be one of: ${ROLES.join(', ')}`, 400);

    const targetId = user_id ?? members.findUserByEmail(email)?.id;
    if (!targetId) throw httpError('User not found', 404);

    members.addMember(teamId, targetId, role);
    res.status(201).json(members.listMembers(teamId));
  } catch (e) { next(e); }
};

// Promote/demote a member. Owner-only; cannot demote the last owner.
const changeRole = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    requireRole(req, teamId, 'owner');

    const { role } = req.body;
    if (!ROLES.includes(role)) throw httpError(`role must be one of: ${ROLES.join(', ')}`, 400);

    const current = members.roleOf(targetId, teamId);
    if (!current) throw httpError('Not a member of this team', 404);
    if (current === 'owner' && role !== 'owner' && members.countOwners(teamId) <= 1) {
      throw httpError('Cannot demote the last owner', 400);
    }

    members.setRole(teamId, targetId, role);
    res.json(members.listMembers(teamId));
  } catch (e) { next(e); }
};

// Rename the team. Owner-only, by team_members role (any owner, not just the creator).
const update = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req, teamId, 'owner');
    if (!req.body.name) throw httpError('Missing required field: name', 400);
    res.json(TeamModel.rename(teamId, req.body.name));
  } catch (e) { next(e); }
};

// Soft-delete the team. Owner-only; blocked unless the team holds no active transactions/vaults.
const destroy = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    requireRole(req, teamId, 'owner');
    if (!members.isEmpty(teamId)) {
      throw httpError('Cannot delete a team with active transactions or vaults', 400);
    }
    TeamModel.softDeleteById(teamId);
    res.status(204).send();
  } catch (e) { next(e); }
};

const removeMember = (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    const targetId = Number(req.params.userId);
    requireRole(req, teamId, 'owner');

    if (members.roleOf(targetId, teamId) === 'owner' && members.countOwners(teamId) <= 1) {
      throw httpError('Cannot remove the last owner', 400);
    }
    members.removeMember(teamId, targetId);
    res.status(204).send();
  } catch (e) { next(e); }
};

module.exports = { listMine, getOne, listMembers, addMember, changeRole, removeMember, update, destroy };
