'use strict';
const { BEFORE_CREATE, CREATE, BEFORE_UPDATE, DESTROY } = require('../../../constants/hooks');
// Import the items model directly to avoid circular entity-index deps.
const { ShoppingListItemModel } = require('../../shopping-list-items/db/model');
const { EventModel } = require('../../events/db/model');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const shoppingListHooks = ({ type, body, previous, record, req }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.name) throw httpError('Missing required field: name', 400);
      return;

    case CREATE:
      EventModel.log({ userId: req.userId, teamId: record.team_id ?? null,
        entity: 'shopping_list', entityId: record.id, action: 'created', summary: { name: record.name } });
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
      EventModel.log({ userId: req.userId, teamId: record.team_id ?? null,
        entity: 'shopping_list', entityId: record.id, action: 'deleted', summary: { name: record.name } });
      return;

    default:
      return;
  }
};

module.exports = { shoppingListHooks };
