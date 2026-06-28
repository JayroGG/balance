'use strict';
const db = require('../../../config/db');

// A team exists if its row is present and not soft-deleted.
const teamExists = (teamId) =>
  !!db.prepare(
    `SELECT 1 FROM teams WHERE id = ? AND deleted_at IS NULL`
  ).get(teamId);

// Membership requires both the team and the membership row to be active.
const isMember = (userId, teamId) =>
  !!db.prepare(
    `SELECT 1
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = ? AND tm.team_id = ?
        AND tm.deleted_at IS NULL AND t.deleted_at IS NULL`
  ).get(userId, teamId);

// Active role of a user in a team, or undefined.
const roleOf = (userId, teamId) => {
  const row = db.prepare(
    `SELECT tm.role
       FROM team_members tm
       JOIN teams t ON t.id = tm.team_id
      WHERE tm.user_id = ? AND tm.team_id = ?
        AND tm.deleted_at IS NULL AND t.deleted_at IS NULL`
  ).get(userId, teamId);
  return row ? row.role : undefined;
};

// Upsert: adds a member, or revives a previously removed one and (re)sets the role.
// Plain INSERT OR IGNORE would silently fail on the UNIQUE(team_id, user_id) row left
// behind by a soft delete, making removed members un-re-addable. (Auth0 role-sync seam:
// future IdP role updates belong here, alongside setRole/removeMember.)
const addMember = (teamId, userId, role) =>
  db.prepare(
    `INSERT INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)
       ON CONFLICT(team_id, user_id) DO UPDATE SET role = excluded.role, deleted_at = NULL`
  ).run(teamId, userId, role);

const setRole = (teamId, userId, role) =>
  db.prepare(
    `UPDATE team_members SET role = ?
      WHERE team_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(role, teamId, userId);

const removeMember = (teamId, userId) =>
  db.prepare(
    `UPDATE team_members
        SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE team_id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(teamId, userId);

const countOwners = (teamId) =>
  db.prepare(
    `SELECT COUNT(*) AS n FROM team_members
      WHERE team_id = ? AND role = 'owner' AND deleted_at IS NULL`
  ).get(teamId).n;

const listMembers = (teamId) =>
  db.prepare(
    `SELECT tm.user_id, tm.role, u.email
       FROM team_members tm
       JOIN users u ON u.id = tm.user_id
      WHERE tm.team_id = ? AND tm.deleted_at IS NULL
      ORDER BY tm.role, u.email`
  ).all(teamId);

const findUserByEmail = (email) =>
  db.prepare(
    `SELECT id FROM users WHERE email = ? AND deleted_at IS NULL`
  ).get(email);

// A team is empty (deletable) when it holds no active transactions or vaults.
const isEmpty = (teamId) => {
  const txns = db.prepare(
    `SELECT COUNT(*) AS n FROM transactions WHERE team_id = ? AND deleted_at IS NULL`
  ).get(teamId).n;
  const vaults = db.prepare(
    `SELECT COUNT(*) AS n FROM vaults WHERE team_id = ? AND deleted_at IS NULL`
  ).get(teamId).n;
  return txns === 0 && vaults === 0;
};

module.exports = {
  teamExists, isMember, roleOf, addMember, setRole, removeMember,
  countOwners, listMembers, findUserByEmail, isEmpty,
};
