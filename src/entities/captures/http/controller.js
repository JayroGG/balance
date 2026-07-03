'use strict';
const { CaptureModel } = require('../db/model');
// Import db files directly to avoid circular entity-index deps.
const { SourceAliasModel } = require('../../source-aliases/db/model');
const { toCents } = require('../../../lib/money');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const VALID_DIRECTIONS = ['in', 'out'];
const VALID_KINDS = ['purchase', 'transfer', 'unknown'];

// Validate the device-parsed evidence. Malformed requests still 400; a
// well-formed capture that can't be resolved lands as pending, never an error.
const parseBody = (body) => {
  const { channel, kind, direction, amount, merchant_raw, last4, captured_at, notification_hash } = body;
  if (!channel) throw httpError('Missing required field: channel', 400);
  if (!captured_at) throw httpError('Missing required field: captured_at', 400);
  if (!VALID_DIRECTIONS.includes(direction)) throw httpError('direction must be in or out', 400);
  if (kind !== undefined && !VALID_KINDS.includes(kind)) {
    throw httpError('kind must be purchase, transfer or unknown', 400);
  }
  const amountCents = toCents(amount);
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw httpError('amount must be a positive number', 400);
  }
  return {
    channel,
    kind:              kind ?? 'unknown',
    direction,
    amount:            amountCents,
    merchant_raw:      merchant_raw ?? null,
    last4:             last4 ?? null,
    captured_at,
    notification_hash: notification_hash ?? null,
  };
};

// The one ingest endpoint every capture path posts to (Shortcuts, MacroDroid,
// future native listener). Pipeline: exact dedup -> alias match -> [A6: window
// dedup -> auto-post]; anything unresolved is saved pending for the review inbox.
const ingest = (req, res, next) => {
  try {
    const userId = req.userId;
    const data = parseBody(req.body);

    // Step 1 — exact dedup: a re-delivered notification is an idempotent no-op.
    if (data.notification_hash) {
      const existing = CaptureModel.findByHash(userId, data.channel, data.notification_hash);
      if (existing) return res.json(existing); // 200 with the original capture
    }

    // Step 2 — alias match: last4 -> card_last4 alias; card-less -> channel_default.
    const sourceId = SourceAliasModel.resolveSourceId(userId, data.channel, data.last4);
    if (!sourceId) {
      return res.status(201).json(CaptureModel.insert(userId, { ...data, status: 'pending' }));
    }

    return res.status(201).json(
      CaptureModel.insert(userId, { ...data, source_id: sourceId, status: 'pending' })
    );
  } catch (e) { next(e); }
};

module.exports = { ingest };
