'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

// Teams I belong to (any role), each tagged with my role so the client can group
// owned-vs-invited and vary screen affordances.
const listForMember = (userId) =>
  db.prepare(
    `SELECT t.*, tm.role
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ? AND tm.deleted_at IS NULL AND t.deleted_at IS NULL
      ORDER BY t.name`
  ).all(userId);

// A team by id regardless of owner — callers must verify membership first.
const getById = (teamId) =>
  db.prepare(`SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL`).get(teamId);

// Mutations authorized by team_members role (any owner), not creator scope, so they
// are by-id rather than user-scoped (unlike the generated update/softDelete).
const rename = (teamId, name) => {
  db.prepare(`UPDATE teams SET name = ?, updated_at = ${NOW} WHERE id = ? AND deleted_at IS NULL`)
    .run(name, teamId);
  return getById(teamId);
};

const softDeleteById = (teamId) =>
  db.prepare(`UPDATE teams SET deleted_at = ${NOW} WHERE id = ? AND deleted_at IS NULL`).run(teamId);

const TeamModel = {
  ...modelGenerator(ENTITY_NAME, fields),
  listForMember, getById, rename, softDeleteById,
};
module.exports = { TeamModel };
