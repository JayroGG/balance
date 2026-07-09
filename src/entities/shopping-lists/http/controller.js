'use strict';
const db = require('../../../config/db');
const { BEFORE_CREATE } = require('../../../constants/hooks');
const { ShoppingListModel } = require('../db/model');
// Cross-entity models/hooks imported directly to avoid circular index deps.
const { ShoppingListItemModel } = require('../../shopping-list-items/db/model');
const { TransactionModel } = require('../../transactions/db/model');
const { transactionHooks } = require('../../transactions/http/hooks');
const { assertCanMutate } = require('../../../lib/access');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// Atomic: post the expense, link it, and freeze the list as purchased. Either all
// three land or none do (better-sqlite3 rolls the transaction back on throw).
const commit = db.transaction((txScope, txBody, listScope, listId) => {
  const tx = TransactionModel.create(txScope, txBody);
  return ShoppingListModel.markPurchased(listScope, listId, tx.id);
});

const checkout = (req, res, next) => {
  try {
    const listId = Number(req.params.id);
    const list = ShoppingListModel.findById(req.context, listId);
    if (!list) throw httpError('Shopping list not found', 404);
    assertCanMutate(req.context, list); // guest read-only; member owns; owner/admin bypass

    if (list.status !== 'open') throw httpError('List is already checked out', 400);
    if (ShoppingListItemModel.countChecked(listId) < 1) {
      throw httpError('Checkout requires at least one checked item', 400);
    }

    const { amount, category_id, occurred_at } = req.body;
    if (amount === undefined || amount === null || !(Number(amount) > 0)) {
      throw httpError('amount must be a positive number', 400);
    }

    // Book into the LIST's own context, not the caller's active one, so a shared
    // list always posts against its own ledger.
    const txScope = { userId: list.user_id, teamId: list.team_id ?? null, isAdmin: req.context.isAdmin };
    const txBody = {
      type:        'expense',
      amount,
      description: list.name,
      category_id: category_id ?? list.category_id ?? undefined,
      occurred_at: occurred_at ?? undefined,
    };

    // Reuse the transactions invariant (available >= 0). Throws 400 before any
    // write, so a violating checkout books nothing.
    transactionHooks({ type: BEFORE_CREATE, body: txBody, req: { context: txScope } });

    res.json(commit(txScope, txBody, req.context, listId));
  } catch (e) { next(e); }
};

module.exports = { checkout };
