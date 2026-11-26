'use strict';
const { BEFORE_CREATE, CREATE, BEFORE_UPDATE, UPDATE, BEFORE_DESTROY, DESTROY } = require('../../../constants/hooks');
const { TransactionModel } = require('../db/model');
const { EventModel } = require('../../events/db/model');

const EVENT_ACTIONS = { [CREATE]: 'created', [UPDATE]: 'updated', [DESTROY]: 'deleted' };

const VALID_TYPES = ['income', 'expense'];

const assertType = (type) => {
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

const transactionHooks = ({ type, body, previous, record, req }) => {
  switch (type) {
    case BEFORE_CREATE: {
      if (!body.type)   { const e = new Error('Missing required field: type');   e.status = 400; throw e; }
      if (!body.amount) { const e = new Error('Missing required field: amount'); e.status = 400; throw e; }
      assertType(body.type);
      assertNoLegacyCategory(body);
      TransactionModel.assertCategoriesInScope(req.context, body.category_ids);
      return;
    }

    case BEFORE_UPDATE: {
      if (previous.loan_id != null) {
        const e = new Error('Loan journal transactions are read-only; use the loan lend/repay endpoints');
        e.status = 400; throw e;
      }
      assertType(body.type);
      assertNoLegacyCategory(body);
      // Tags must live in the row's own context (an admin may edit rows outside the active one).
      TransactionModel.assertCategoriesInScope({ userId: previous.user_id, teamId: previous.team_id }, body.category_ids);
      return;
    }

    case BEFORE_DESTROY: {
      if (record.loan_id != null) {
        const e = new Error('Loan journal transactions are read-only; use the loan lend/repay endpoints');
        e.status = 400; throw e;
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
        summary: { type: record.type, amount: record.amount, description: record.description },
      });
      return;

    default:
      return;
  }
};

module.exports = { transactionHooks };
