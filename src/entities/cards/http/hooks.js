'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE, BEFORE_DESTROY, CREATE, UPDATE, DESTROY } = require('../../../constants/hooks');
const { toCents } = require('../../../lib/money');
const { owedCents } = require('../db/figures');
const { EventModel } = require('../../events/db/model');

const EVENT_ACTIONS = { [CREATE]: 'created', [UPDATE]: 'updated', [DESTROY]: 'deleted' };

const bad = (message) => Object.assign(new Error(message), { status: 400 });

// Body validation at the boundary. `required` = create (all of name/cut_day/due_day must be present).
const validate = (body, required) => {
  if (required && !body.name)               throw bad('Missing required field: name');
  if (required && body.cut_day == null)     throw bad('Missing required field: cut_day');
  if (required && body.due_day == null)     throw bad('Missing required field: due_day');
  if (body.name !== undefined && (typeof body.name !== 'string' || !body.name.trim())) {
    throw bad('name must be a non-empty string');
  }
  for (const f of ['cut_day', 'due_day']) {
    if (body[f] !== undefined && !(Number.isInteger(body[f]) && body[f] >= 1 && body[f] <= 31)) {
      throw bad(`${f} must be an integer between 1 and 31`);
    }
  }
  if (body.credit_limit !== undefined && body.credit_limit !== null
      && !(typeof body.credit_limit === 'number' && toCents(body.credit_limit) > 0)) {
    throw bad('credit_limit must be a positive number or null');
  }
};

const cardHooks = ({ type, body, record, req }) => {
  switch (type) {
    case BEFORE_CREATE:
      validate(body, true);
      return;

    case BEFORE_UPDATE:
      validate(body, false);
      return;

    case BEFORE_DESTROY:
      if (owedCents(record.id) !== 0) throw bad('Cannot delete a card with an outstanding balance; pay it to zero first');
      return;

    case CREATE:
    case UPDATE:
    case DESTROY:
      EventModel.log({ userId: req.userId, teamId: record.team_id ?? null,
        entity: 'card', entityId: record.id, action: EVENT_ACTIONS[type], summary: { name: record.name } });
      return;

    default:
      return;
  }
};

module.exports = { cardHooks };
