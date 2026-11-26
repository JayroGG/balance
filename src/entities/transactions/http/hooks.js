'use strict';
const { BEFORE_CREATE, CREATE, BEFORE_UPDATE, UPDATE, BEFORE_DESTROY, DESTROY } = require('../../../constants/hooks');
const { TransactionModel } = require('../db/model');
const { EventModel } = require('../../events/db/model');
const { toCents } = require('../../../lib/money');
const { owedCents } = require('../../cards/db/figures');

const EVENT_ACTIONS = { [CREATE]: 'created', [UPDATE]: 'updated', [DESTROY]: 'deleted' };

const VALID_TYPES = ['income', 'expense'];

const bad = (message) => Object.assign(new Error(message), { status: 400 });

const assertType = (type) => {
  if (type === 'card_payment') throw bad('Card payments are created with POST /cards/:id/pay');
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    const e = new Error('type must be income or expense'); e.status = 400; throw e;
  }
};

// Net worth may go below zero (ADR-012): no balance guard on transaction writes.
// category_id was replaced by category_ids (ADR-013); reject the old key loudly instead of dropping it.
const assertNoLegacyCategory = (body) => {
  if (body.category_id !== undefined) {
    const e = new Error('category_id was replaced by category_ids (array)'); e.status = 400; throw e;
  }
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})(?:T.*)?$/; // a time suffix is tolerated (ADR-011); the date part must be real
const MAX_CENTS = 1e12; // amounts stay exactly summable (card owed guards compare sums)

// Boundary checks the card statement relies on: a real calendar date (the statement compares its first 10 chars) and a finite, bounded, positive amount.
const assertDateAndAmount = (body) => {
  if (body.occurred_at !== undefined) {
    const m = typeof body.occurred_at === 'string' && DATE.exec(body.occurred_at);
    const d = m && new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
    if (!d || d.toISOString().slice(0, 10) !== body.occurred_at.slice(0, 10)) throw bad('occurred_at must start with a valid YYYY-MM-DD date');
  }
  if (body.amount !== undefined) {
    const cents = toCents(body.amount);
    if (typeof body.amount === 'boolean' || !Number.isInteger(cents) || cents < 1 || cents > MAX_CENTS) {
      throw bad('amount must be a positive number');
    }
  }
};

// A deleted card freezes its history: otherwise editing/deleting its rows could hide debt (ADR-014).
const assertCardNotDeleted = (row) => {
  if (row.card_id != null && !TransactionModel.cardIsLive(row.card_id)) {
    throw bad('This transaction belongs to a deleted card and can no longer be changed');
  }
};

// Card rules (ADR-014). A charge is an expense with card_id; a payment is its own read-only type.
// A write may never leave a card owing less than zero (payments already exceed what's left of the charges).
const assertCardOwedStays = (cardId, deltaCents) => {
  if (deltaCents < 0 && owedCents(cardId) + deltaCents < 0) {
    throw bad('Change would make the card owe less than zero; delete or reduce its payments first');
  }
};

const transactionHooks = ({ type, body, previous, record, req }) => {
  switch (type) {
    case BEFORE_CREATE: {
      if (!body.type)   { const e = new Error('Missing required field: type');   e.status = 400; throw e; }
      if (!body.amount) { const e = new Error('Missing required field: amount'); e.status = 400; throw e; }
      assertType(body.type);
      assertDateAndAmount(body);
      assertNoLegacyCategory(body);
      TransactionModel.assertCategoriesInScope(req.context, body.category_ids);
      if (body.card_id != null && body.type !== 'expense') throw bad('Only expenses can be charged to a card');
      TransactionModel.assertCardInScope(req.context, body.card_id);
      return;
    }

    case BEFORE_UPDATE: {
      if (previous.loan_id != null) {
        const e = new Error('Loan journal transactions are read-only; use the loan lend/repay endpoints');
        e.status = 400; throw e;
      }
      if (previous.type === 'card_payment') throw bad('Card payments are read-only; delete it and pay again');
      assertCardNotDeleted(previous);
      assertType(body.type);
      assertDateAndAmount(body);
      assertNoLegacyCategory(body);
      // Tags must live in the row's own context (an admin may edit rows outside the active one).
      TransactionModel.assertCategoriesInScope({ userId: previous.user_id, teamId: previous.team_id }, body.category_ids);

      const nextType = body.type ?? previous.type;
      const nextCard = body.card_id !== undefined ? body.card_id : previous.card_id;
      if (nextCard != null && nextType !== 'expense') throw bad('Only expenses can be charged to a card');
      if (body.card_id != null && body.card_id !== previous.card_id) {
        TransactionModel.assertCardInScope({ userId: previous.user_id, teamId: previous.team_id }, body.card_id);
      } else if (body.card_id !== undefined && body.card_id !== null && !Number.isInteger(body.card_id)) {
        throw bad('card_id must be a positive integer or null');
      }
      if (previous.type === 'expense' && previous.card_id != null) {
        const prevCents = toCents(previous.amount);
        const stays = nextType === 'expense' && nextCard === previous.card_id;
        const nextCents = body.amount !== undefined ? toCents(body.amount) : prevCents;
        assertCardOwedStays(previous.card_id, stays ? nextCents - prevCents : -prevCents);
      }
      return;
    }

    case BEFORE_DESTROY: {
      if (record.loan_id != null) {
        const e = new Error('Loan journal transactions are read-only; use the loan lend/repay endpoints');
        e.status = 400; throw e;
      }
      assertCardNotDeleted(record);
      // Deleting a payment only raises what's owed; deleting a charge must not push owed below zero.
      if (record.type === 'expense' && record.card_id != null) {
        assertCardOwedStays(record.card_id, -toCents(record.amount));
      }
      return;
    }

    // After-hooks: log what actually landed (record is post-write, amounts decimal).
    // Checkout invokes this hook manually with BEFORE_CREATE only and logs its own
    // checked_out event, so nothing doubles up here.
    case CREATE:
    case UPDATE:
    case DESTROY:
      EventModel.log({
        userId: req.userId, teamId: record.team_id ?? null,
        entity: 'transaction', entityId: record.id, action: EVENT_ACTIONS[type],
        summary: { type: record.type, amount: record.amount, description: record.description,
                   ...(record.card_id != null && { card_id: record.card_id }) },
      });
      return;

    default:
      return;
  }
};

module.exports = { transactionHooks };
