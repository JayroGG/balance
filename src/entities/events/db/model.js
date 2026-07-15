'use strict';
// Append-only activity ledger (ADR-009). Hand-written like shopping-list-items:
// the feed needs DESC ordering, LIMIT, since_id, and a users join — none of which
// modelGenerator.findAll supports. Immutable: log() is the only write path.
const db = require('../../../config/db');
const { fields } = require('./fields');

// userId is the ACTOR (req.userId, admin included); teamId comes from the AFFECTED
// record's context, not the caller's active one. summary amounts are decimals.
const log = ({ userId, teamId, entity, entityId, action, summary }) =>
  db.prepare(
    `INSERT INTO events (user_id, team_id, entity, entity_id, action, summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, teamId ?? null, entity, entityId, action, summary ? JSON.stringify(summary) : null);

// Same scope semantics as modelGenerator's scopeClause: team feed for members,
// personal = own actions only, admin may target any team or (via ?user_id=) any
// user's personal feed.
const scopeClause = ({ userId, teamId, isAdmin, targetUserId }) => {
  if (teamId != null) return { sql: 'e.team_id = ?', values: [teamId] };
  const uid = isAdmin && targetUserId != null ? targetUserId : userId;
  return { sql: 'e.user_id = ? AND e.team_id IS NULL', values: [uid] };
};

const listFeed = (scope, { entity, action, since_id, limit }) => {
  const { sql, values } = scopeClause(scope);
  const conditions = [sql];
  const params = [...values];
  if (entity)   { conditions.push('e.entity = ?'); params.push(entity); }
  if (action)   { conditions.push('e.action = ?'); params.push(action); }
  if (since_id) { conditions.push('e.id > ?');     params.push(since_id); }
  return db.prepare(
    `SELECT e.*, u.email AS actor_email
       FROM events e
       JOIN users u ON u.id = e.user_id
      WHERE ${conditions.join(' AND ')}
      ORDER BY e.id DESC
      LIMIT ?`
  ).all(...params, limit)
    .map((e) => ({ ...e, summary: e.summary ? JSON.parse(e.summary) : null }));
};

const EventModel = { log, listFeed, filterFields: fields.filterFields };
module.exports = { EventModel };
