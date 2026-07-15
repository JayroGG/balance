'use strict';
const { BEFORE_CREATE, CREATE, BEFORE_UPDATE, UPDATE, BEFORE_DESTROY, DESTROY, GET_ONE, LIST_ALL } = require('../../../constants/hooks');
const { assertCanMutate } = require('../../../lib/access');
// Direct import (never via entity index) to avoid circular deps.
const { ShoppingListModel } = require('../../shopping-lists/db/model');
const { EventModel } = require('../../events/db/model');

const httpError = (message, status) => Object.assign(new Error(message), { status });

const EVENT_ACTIONS = { [CREATE]: 'created', [UPDATE]: 'updated', [DESTROY]: 'deleted' };

// Resolve the parent list within the caller's context (team membership + admin
// handled by the model). Throws 404 if the list isn't visible in this context —
// this is what stops an item leaking across teams.
const requireList = (req, listId) => {
  if (listId === undefined || listId === null || listId === '') {
    throw httpError('Missing required field: list_id', 400);
  }
  const list = ShoppingListModel.findById(req.context, Number(listId));
  if (!list) throw httpError('Shopping list not found', 404);
  return list;
};

const assertOpen = (list) => {
  if (list.status !== 'open') throw httpError('Cannot modify items of a purchased list', 400);
};

const assertItemFields = (body) => {
  if (body.name !== undefined && (typeof body.name !== 'string' || body.name.trim() === '')) {
    throw httpError('name must be a non-empty string', 400);
  }
  if (body.qty !== undefined && !(Number(body.qty) > 0)) {
    throw httpError('qty must be greater than 0', 400);
  }
  if (body.price !== undefined && body.price !== null && Number(body.price) < 0) {
    throw httpError('price must be zero or greater', 400);
  }
};

const shoppingListItemHooks = ({ type, body, previous, record, req }) => {
  switch (type) {
    case LIST_ALL:
      // Authorize the parent list before any rows are returned.
      requireList(req, req.query.list_id);
      return;

    case GET_ONE:
      requireList(req, record.list_id);
      return;

    case BEFORE_CREATE: {
      if (!body.name) throw httpError('Missing required field: name', 400);
      const list = requireList(req, body.list_id);
      assertCanMutate(req.context, list); // member may add only to their own lists
      assertOpen(list);
      assertItemFields(body);
      return;
    }

    case BEFORE_UPDATE: {
      const list = requireList(req, previous.list_id);
      assertCanMutate(req.context, list);
      assertOpen(list);
      assertItemFields(body);
      return;
    }

    case BEFORE_DESTROY: {
      const list = requireList(req, record.list_id);
      assertCanMutate(req.context, list);
      assertOpen(list);
      return;
    }

    // Items carry no team_id — the parent list's context owns the event.
    case CREATE:
    case UPDATE:
    case DESTROY: {
      const list = ShoppingListModel.findById(req.context, record.list_id);
      EventModel.log({ userId: req.userId, teamId: list.team_id ?? null,
        entity: 'shopping_list_item', entityId: record.id, action: EVENT_ACTIONS[type],
        summary: { list_id: record.list_id, name: record.name, checked: !!record.checked } });
      return;
    }

    default:
      return;
  }
};

module.exports = { shoppingListItemHooks };
