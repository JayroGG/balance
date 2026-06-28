'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

// Teams I belong to (member or owner), not just the ones I created.
const listForMember = (userId) =>
  db.prepare(
    `SELECT t.*
       FROM teams t
       JOIN team_members tm ON tm.team_id = t.id
      WHERE tm.user_id = ? AND tm.deleted_at IS NULL AND t.deleted_at IS NULL
      ORDER BY t.name`
  ).all(userId);

// A team by id regardless of owner — callers must verify membership first.
const getById = (teamId) =>
  db.prepare(`SELECT * FROM teams WHERE id = ? AND deleted_at IS NULL`).get(teamId);

const TeamModel = { ...modelGenerator(ENTITY_NAME, fields), listForMember, getById };
module.exports = { TeamModel };
