'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE, BEFORE_DESTROY } = require('../../../constants/hooks');
const { toCents } = require('../../../lib/money');
// Import balance queries directly to avoid circular index deps
const { availableCents } = require('../../balance/db/queries');

const VALID_TYPES = ['income', 'expense'];

const assertType = (type) => {
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    const e = new Error('type must be income or expense'); e.status = 400; throw e;
  }
};

// How a transaction moves net worth: income adds, expense subtracts.
const contribution = (type, amountCents) => (type === 'income' ? amountCents : -amountCents);

// Reject any write whose effect on net worth would push available below zero
// (vaulted money is protected). deltaCents = change to net worth from this write.
const assertSpendable = (userId, deltaCents) => {
  if (deltaCents >= 0) return; // increases or neutral — always safe
  if (availableCents(userId) + deltaCents < 0) {
    const e = new Error('Insufficient available balance: the amount exceeds spendable money (funds are allocated to vaults)');
    e.status = 400; throw e;
  }
};

const transactionHooks = ({ type, body, previous, record, req }) => {
  switch (type) {
    case BEFORE_CREATE: {
      if (!body.type)   { const e = new Error('Missing required field: type');   e.status = 400; throw e; }
      if (!body.amount) { const e = new Error('Missing required field: amount'); e.status = 400; throw e; }
      assertType(body.type);
      assertSpendable(req.userId, contribution(body.type, toCents(body.amount)));
      return;
    }

    case BEFORE_UPDATE: {
      const resolvedType = body.type !== undefined ? body.type : previous.type;
      assertType(resolvedType);
      const oldContribution = contribution(previous.type, toCents(previous.amount));
      const newAmountCents  = body.amount !== undefined ? toCents(body.amount) : toCents(previous.amount);
      const newContribution = contribution(resolvedType, newAmountCents);
      assertSpendable(req.userId, newContribution - oldContribution);
      return;
    }

    case BEFORE_DESTROY: {
      assertSpendable(req.userId, -contribution(record.type, toCents(record.amount)));
      return;
    }

    default:
      return;
  }
};

module.exports = { transactionHooks };
