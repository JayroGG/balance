'use strict';
const db = require('../../../config/db');
const { modelGenerator } = require('../../../utils/modelGenerator');
const { toDecimal } = require('../../../lib/money');
const { fields } = require('./fields');
const { ENTITY_NAME } = require('../constants');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const fmt = (row) => (row ? { ...row, amount: toDecimal(row.amount) } : row);

// Exact-dedup lookup: has this device-computed hash been ingested before?
const findByHash = (userId, channel, hash) =>
  fmt(db.prepare(
    `SELECT * FROM captures
      WHERE user_id = ? AND channel = ? AND notification_hash = ? AND deleted_at IS NULL`
  ).get(userId, channel, hash));

// Cross-channel dedup: a live capture of the same payment (same source, amount,
// direction) reported within ±windowMinutes of capturedAtISO. excludeId keeps a
// capture from matching itself once inserted.
const findRecentMatch = (userId, sourceId, amountCents, direction, capturedAtISO, windowMinutes, excludeId) =>
  fmt(db.prepare(
    `SELECT * FROM captures
      WHERE user_id = ? AND source_id = ? AND amount = ? AND direction = ? AND id != ?
        AND status NOT IN ('duplicate', 'discarded') AND deleted_at IS NULL
        AND ABS(julianday(captured_at) - julianday(?)) * 1440 <= ?
      ORDER BY id LIMIT 1`
  ).get(userId, sourceId, amountCents, direction, excludeId ?? -1, capturedAtISO, windowMinutes));

// Pipeline insert: unlike the public create, the pipeline controls status,
// source_id, duplicate_of and transaction_id. amount arrives already in cents.
const insert = (userId, data) => {
  const cols = Object.keys(data);
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO captures (user_id, ${cols.join(', ')})
     VALUES (?, ${cols.map(() => '?').join(', ')})`
  ).run(userId, ...Object.values(data));
  return fmt(db.prepare(`SELECT * FROM captures WHERE id = ?`).get(lastInsertRowid));
};

// Status transitions (review actions + auto-post).
const setStatus = (id, status) =>
  db.prepare(`UPDATE captures SET status = ?, updated_at = ${NOW} WHERE id = ?`).run(status, id);

const setSource = (id, sourceId) =>
  db.prepare(`UPDATE captures SET source_id = ?, updated_at = ${NOW} WHERE id = ?`).run(sourceId, id);

const setDuplicate = (id, ofId) =>
  db.prepare(
    `UPDATE captures SET status = 'duplicate', duplicate_of = ?, updated_at = ${NOW} WHERE id = ?`
  ).run(ofId, id);

const setPosted = (id, sourceId, transactionId) =>
  db.prepare(
    `UPDATE captures SET status = 'posted', source_id = ?, transaction_id = ?, updated_at = ${NOW}
      WHERE id = ?`
  ).run(sourceId, transactionId, id);

const CaptureModel = {
  ...modelGenerator(ENTITY_NAME, fields),
  findByHash,
  findRecentMatch,
  insert,
  setStatus,
  setSource,
  setDuplicate,
  setPosted,
};

module.exports = { CaptureModel };
