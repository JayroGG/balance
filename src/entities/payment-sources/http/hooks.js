'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE, DESTROY } = require('../../../constants/hooks');
// Import db files directly to avoid circular entity-index deps.
const { teamExists, roleOf } = require('../../teams/db/members');
const { softDeleteBySource } = require('../../source-aliases/db/model');

const VALID_TYPES = ['account', 'credit_card'];
const httpError = (message, status) => Object.assign(new Error(message), { status });

const assertType = (type) => {
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    throw httpError('type must be account or credit_card', 400);
  }
};

// The routing rule: a source may only target a team the user can write to
// (owner/member — guests and non-members cannot route money into a team).
// A global admin (ADR-006) may route to any existing team.
const assertRoutable = ({ userId, isAdmin }, targetTeamId) => {
  if (targetTeamId === undefined || targetTeamId === null) return;
  if (!teamExists(targetTeamId)) throw httpError('target team must be one you can write to', 400);
  if (isAdmin) return;
  const role = roleOf(userId, targetTeamId);
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
      assertRoutable(req.context, body.target_team_id);
      return coerceActive(body);
    }

    case BEFORE_UPDATE: {
      assertType(body.type);
      assertRoutable(req.context, body.target_team_id);
      return coerceActive(body);
    }

    case DESTROY: {
      // Aliases have no life of their own — cascade the soft delete.
      softDeleteBySource(record.id);
      return;
    }

    default:
      return;
  }
};

module.exports = { paymentSourceHooks };
