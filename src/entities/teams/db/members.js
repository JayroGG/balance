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

const addMember = (teamId, userId, role) =>
  db.prepare(
    `INSERT OR IGNORE INTO team_members (team_id, user_id, role) VALUES (?, ?, ?)`
  ).run(teamId, userId, role);

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

module.exports = {
  teamExists, isMember, roleOf, addMember, removeMember,
  countOwners, listMembers, findUserByEmail,
};
