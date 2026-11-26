'use strict';
const db = require('../../../config/db');
const { CardModel } = require('../db/model');
const { owedCents } = require('../db/figures');
const { toCents, toDecimal } = require('../../../lib/money');
const { assertCanMutate } = require('../../../lib/access');
const { EventModel } = require('../../events/db/model');
// Cross-entity model imported directly to avoid circular index deps.
const { TransactionModel } = require('../../transactions/db/model');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const isoDate = (raw) => {
  const m = typeof raw === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  if (!d || d.toISOString().slice(0, 10) !== raw) throw httpError('occurred_at must be a valid YYYY-MM-DD date', 400);
  return raw;
};

// Atomic: the payment row and its event land together or not at all.
const commitPay = db.transaction((scope, actorId, card, cents, occurredAt) => {
  TransactionModel.createCardPayment(scope, { amountCents: cents, description: `Card payment: ${card.name}`, cardId: card.id, occurredAt });
  EventModel.log({ userId: actorId, teamId: card.team_id ?? null,
    entity: 'card', entityId: card.id, action: 'paid', summary: { name: card.name, amount: toDecimal(cents) } });
});

// POST /cards/:id/pay { amount, occurred_at? } — moves money from the balance to the card.
const pay = (req, res, next) => {
  try {
    const card = CardModel.findById(req.context, Number(req.params.id));
    if (!card) throw httpError('Card not found', 404);
    assertCanMutate(req.context, card);

    const { amount, occurred_at } = req.body;
    if (amount === undefined || amount === null) throw httpError('Missing required field: amount', 400);
    const cents = typeof amount === 'number' ? toCents(amount) : NaN;
    if (!Number.isInteger(cents) || cents <= 0) throw httpError('amount must be a positive number', 400);
    const occurredAt = occurred_at === undefined ? undefined : isoDate(occurred_at);
    if (cents > owedCents(card.id)) throw httpError('Cannot pay more than the card owes', 400);

    // Posts into the CARD's own context (loans precedent). Team payments are attributed to the actor,
    // so a member can still undo their own payment; personal ones to the card's owner.
    const scope = { userId: card.team_id != null ? req.userId : card.user_id, teamId: card.team_id ?? null };
    commitPay(scope, req.userId, card, cents, occurredAt);
    res.status(201).json(CardModel.findById(req.context, card.id));
  } catch (e) { next(e); }
};

module.exports = { pay };
