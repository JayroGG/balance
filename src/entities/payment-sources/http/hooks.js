'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE, DESTROY } = require('../../../constants/hooks');
const db = require('../../../config/db');
// Import the members file directly to avoid circular entity-index deps.
const { teamExists, roleOf } = require('../../teams/db/members');

const VALID_TYPES = ['account', 'credit_card'];
const httpError = (message, status) => Object.assign(new Error(message), { status });

const assertType = (type) => {
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    throw httpError('type must be account or credit_card', 400);
  }
};

// The routing rule: a source may only target a team the user can write to
// (owner/member — guests and non-members cannot route money into a team).
const assertRoutable = (userId, targetTeamId) => {
  if (targetTeamId === undefined || targetTeamId === null) return;
  const role = teamExists(targetTeamId) ? roleOf(userId, targetTeamId) : undefined;
  if (role !== 'owner' && role !== 'member') {
    throw httpError('target team must be one you can write to', 400);
  }
};

// active is an INTEGER column; better-sqlite3 refuses raw booleans.
const coerceActive = (body) =>
  body.active !== undefined ? { active: body.active ? 1 : 0 } : undefined;

const paymentSourceHooks = ({ type, body, record, req }) => {
  switch (type) {
    case BEFORE_CREATE: {
      if (!body.name) throw httpError('Missing required field: name', 400);
      if (!body.type) throw httpError('Missing required field: type', 400);
      assertType(body.type);
      assertRoutable(req.userId, body.target_team_id);
      return coerceActive(body);
    }

    case BEFORE_UPDATE: {
      assertType(body.type);
      assertRoutable(req.userId, body.target_team_id);
      return coerceActive(body);
    }

    case DESTROY: {
      // Aliases have no life of their own — cascade the soft delete.
      db.prepare(
        `UPDATE source_aliases SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
          WHERE source_id = ? AND deleted_at IS NULL`
      ).run(record.id);
      return;
    }

    default:
      return;
  }
};

module.exports = { paymentSourceHooks };
