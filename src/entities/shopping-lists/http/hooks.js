'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE, DESTROY } = require('../../../constants/hooks');
// Import the items model directly to avoid circular entity-index deps.
const { ShoppingListItemModel } = require('../../shopping-list-items/db/model');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const shoppingListHooks = ({ type, body, previous, record }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.name) throw httpError('Missing required field: name', 400);
      return;

    case BEFORE_UPDATE:
      // Purchased lists are frozen history — no rename/category edits.
      if (previous.status !== 'open') throw httpError('Cannot edit a purchased list', 400);
      if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
        throw httpError('name must be a non-empty string', 400);
      }
      return;

    case DESTROY:
      // Soft-deleting a list cascades to its items; the linked transaction is untouched.
      ShoppingListItemModel.softDeleteByList(record.id);
      return;

    default:
      return;
  }
};

module.exports = { shoppingListHooks };
