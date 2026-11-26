'use strict';
const db = require('../../../config/db');
const { BEFORE_CREATE } = require('../../../constants/hooks');
const { ShoppingListModel } = require('../db/model');
// Cross-entity models/hooks imported directly to avoid circular index deps.
const { ShoppingListItemModel } = require('../../shopping-list-items/db/model');
const { TransactionModel } = require('../../transactions/db/model');
const { transactionHooks } = require('../../transactions/http/hooks');
const { assertCanMutate } = require('../../../lib/access');
const { EventModel } = require('../../events/db/model');

const httpError = (message, status) => Object.assign(new Error(message), { status });

// Atomic: post the expense, link it, freeze the list as purchased, and log the
// checked_out event. Either all land or none do (better-sqlite3 rolls the
// transaction back on throw). The event goes to the LIST's context; actor is the caller.
const commit = db.transaction((txScope, txBody, listScope, list, actorId) => {
  const tx = TransactionModel.create(txScope, txBody);
  const purchased = ShoppingListModel.markPurchased(listScope, list.id, tx.id);
  EventModel.log({ userId: actorId, teamId: list.team_id ?? null,
    entity: 'shopping_list', entityId: list.id, action: 'checked_out',
    summary: { name: list.name, amount: tx.amount, transaction_id: tx.id } });
  return purchased;
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

    const { amount, category_id, category_ids, occurred_at } = req.body;
    if (amount === undefined || amount === null || !(Number(amount) > 0)) {
      throw httpError('amount must be a positive number', 400);
    }

    // Book into the LIST's own context, not the caller's active one, so a shared
    // list always posts against its own ledger.
    const txScope = { userId: list.user_id, teamId: list.team_id ?? null, isAdmin: req.context.isAdmin };
    // Tags (ADR-013): explicit category_ids, else a single category_id override, else the list default.
    const single = category_id ?? list.category_id;
    const categoryIds = category_ids !== undefined ? category_ids : (single != null ? [single] : undefined);
    const txBody = {
      type:        'expense',
      amount,
      description: list.name,
      category_ids: categoryIds,
      occurred_at: occurred_at ?? undefined,
    };

    // Reuse the transactions validation (type, category scope). Throws 400 before any
    // write, so an invalid checkout books nothing. Available may go negative (ADR-012).
    transactionHooks({ type: BEFORE_CREATE, body: txBody, req: { context: txScope } });

    res.json(commit(txScope, txBody, req.context, list, req.userId));
  } catch (e) { next(e); }
};

module.exports = { checkout };
