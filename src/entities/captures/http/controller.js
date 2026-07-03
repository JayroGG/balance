'use strict';
const db = require('../../../config/db');
const { CaptureModel } = require('../db/model');
// Import db files directly to avoid circular entity-index deps.
const { SourceAliasModel } = require('../../source-aliases/db/model');
const { PaymentSourceModel } = require('../../payment-sources/db/model');
const { TransactionModel } = require('../../transactions/db/model');
const { availableCents } = require('../../balance/db/queries');
const { teamExists, roleOf } = require('../../teams/db/members');
const { toCents } = require('../../../lib/money');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const DEDUP_WINDOW_MINUTES = 5;

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

// Steps 3–4 on an existing capture whose source is resolved. Shared by ingest
// and the confirm review action. Never throws for resolution failures — the
// capture just stays pending (automations can't handle a 400).
// overrides (confirm only): { team_id, category_id } beat the source's defaults.
const resolveAndPost = (userId, captureId, overrides = {}) => {
  const scope = { userId };
  const capture = CaptureModel.findById(scope, captureId);
  const source = PaymentSourceModel.findById(scope, capture.source_id);
  const amountCents = toCents(capture.amount);

  // Step 3 — cross-channel dedup: the same payment reported by another app
  // (wallet + bank) within the window folds into the earlier capture.
  const match = CaptureModel.findRecentMatch(
    userId, capture.source_id, amountCents, capture.direction,
    capture.captured_at, DEDUP_WINDOW_MINUTES, capture.id
  );
  if (match) {
    CaptureModel.setDuplicate(capture.id, match.id);
    return CaptureModel.findById(scope, capture.id);
  }

  // Step 4 — auto-post into the source's routed context (null = personal).
  const teamId = overrides.team_id !== undefined ? overrides.team_id : (source.target_team_id ?? null);
  const role = teamId != null ? roleOf(userId, teamId) : null;
  const postScope = { userId, teamId, role, isAdmin: false };
  try {
    if (teamId != null && (!teamExists(teamId) || (role !== 'owner' && role !== 'member'))) {
      throw new Error('routed team is not writable'); // stays pending, surfaces in the inbox
    }
    const type = capture.direction === 'in' ? 'income' : 'expense';
    if (type === 'expense' && amountCents > availableCents(postScope)) {
      throw new Error('insufficient available balance'); // stays pending
    }
    db.transaction(() => {
      const tx = TransactionModel.create(postScope, {
        type,
        amount:      capture.amount,
        description: capture.merchant_raw,
        occurred_at: capture.captured_at.slice(0, 10),
        category_id: overrides.category_id !== undefined ? overrides.category_id : source.default_category_id,
      });
      // Provenance is pipeline-owned — stamped directly, never accepted from a body.
      db.prepare(`UPDATE transactions SET source_id = ?, capture_id = ? WHERE id = ?`)
        .run(capture.source_id, capture.id, tx.id);
      CaptureModel.setPosted(capture.id, capture.source_id, tx.id);
    })();
  } catch (e) {
    // Any step-4 failure leaves the capture pending for manual review.
  }
  return CaptureModel.findById(scope, capture.id);
};

// The one ingest endpoint every capture path posts to (Shortcuts, MacroDroid,
// future native listener). Pipeline: exact dedup -> alias match -> window
// dedup -> auto-post; anything unresolved is saved pending for the review inbox.
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
    const capture = CaptureModel.insert(userId, {
      ...data, source_id: sourceId, status: 'pending',
    });
    if (!sourceId) return res.status(201).json(capture);

    return res.status(201).json(resolveAndPost(userId, capture.id));
  } catch (e) { next(e); }
};

module.exports = { ingest };
