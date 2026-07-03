'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

// Resolve a capture's identity evidence to a source id (the ingest pipeline's
// alias-match step). last4 present -> card_last4 alias; absent -> channel_default.
const resolveSourceId = (userId, channel, last4) => {
  const row = last4
    ? db.prepare(
        `SELECT source_id FROM source_aliases
          WHERE user_id = ? AND channel = ? AND match_kind = 'card_last4' AND value = ?
            AND deleted_at IS NULL`
      ).get(userId, channel, last4)
    : db.prepare(
        `SELECT source_id FROM source_aliases
          WHERE user_id = ? AND channel = ? AND match_kind = 'channel_default'
            AND deleted_at IS NULL`
      ).get(userId, channel);
  return row ? row.source_id : null;
};

// Cascade for payment-sources DESTROY: a source's aliases go with it.
const softDeleteBySource = (sourceId) =>
  db.prepare(
    `UPDATE source_aliases SET deleted_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
      WHERE source_id = ? AND deleted_at IS NULL`
  ).run(sourceId);

const hasChannelDefault = (userId, channel, excludeId) =>
  !!db.prepare(
    `SELECT 1 FROM source_aliases
      WHERE user_id = ? AND channel = ? AND match_kind = 'channel_default'
        AND deleted_at IS NULL AND id != ?`
  ).get(userId, channel, excludeId ?? -1);

const SourceAliasModel = {
  ...modelGenerator(ENTITY_NAME, fields),
  resolveSourceId,
  hasChannelDefault,
};

module.exports = { SourceAliasModel, softDeleteBySource };
