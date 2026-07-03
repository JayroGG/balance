'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE } = require('../../../constants/hooks');
const { SourceAliasModel } = require('../db/model');
// Import the model file directly to avoid circular entity-index deps.
const { PaymentSourceModel } = require('../../payment-sources/db/model');

const VALID_KINDS = ['card_last4', 'channel_default'];
const httpError = (message, status) => Object.assign(new Error(message), { status });

// Validate the alias as it will exist after the write (create: body only;
// update: body over previous). Returns the body merge for the handler.
const assertAlias = (req, { source_id, channel, match_kind, value }, excludeId) => {
  if (!PaymentSourceModel.findById(req.context, source_id)) {
    throw httpError('source_id must be one of your payment sources', 400);
  }
  if (!VALID_KINDS.includes(match_kind)) {
    throw httpError('match_kind must be card_last4 or channel_default', 400);
  }
  if (match_kind === 'card_last4') {
    if (!/^\d{4}$/.test(value ?? '')) throw httpError('value must be exactly 4 digits', 400);
    const dup = SourceAliasModel
      .findAll(req.context, { channel, match_kind: 'card_last4', value })
      .some((a) => a.id !== excludeId);
    if (dup) throw httpError('alias already exists for this channel and card', 400);
    return;
  }
  // channel_default: card-less pushes are only unambiguous while the channel
  // maps to a single pot — a second default on the same channel is rejected.
  if (value !== undefined && value !== null) {
    throw httpError('channel_default aliases must not carry a value', 400);
  }
  if (SourceAliasModel.hasChannelDefault(req.userId, channel, excludeId)) {
    throw httpError('channel already has a default alias', 400);
  }
  return { value: null };
};

const sourceAliasHooks = ({ type, body, previous, req }) => {
  switch (type) {
    case BEFORE_CREATE: {
      for (const f of ['source_id', 'channel', 'match_kind']) {
        if (!body[f]) throw httpError(`Missing required field: ${f}`, 400);
      }
      return assertAlias(req, body, undefined);
    }

    case BEFORE_UPDATE: {
      const effective = {
        source_id:  body.source_id  !== undefined ? body.source_id  : previous.source_id,
        channel:    body.channel    !== undefined ? body.channel    : previous.channel,
        match_kind: body.match_kind !== undefined ? body.match_kind : previous.match_kind,
        value:      body.value      !== undefined ? body.value      : previous.value,
      };
      return assertAlias(req, effective, previous.id);
    }

    default:
      return;
  }
};

module.exports = { sourceAliasHooks };
