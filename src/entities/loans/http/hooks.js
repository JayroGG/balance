'use strict';
const { BEFORE_DESTROY, UPDATE, DESTROY } = require('../../../constants/hooks');
// Import balance queries directly to avoid circular index deps
const { loanPendingCents } = require('../../balance/db/queries');
const { EventModel } = require('../../events/db/model');

// No BEFORE_CREATE/CREATE cases: POST / is a custom route (see http/routes.js)
// that shadows the generated createHandler and logs its own `created` event.
const loanHooks = ({ type, record, req }) => {
  switch (type) {
    case BEFORE_DESTROY:
      if (loanPendingCents(req.context, record.id) !== 0) {
        const e = new Error('Cannot delete a loan with pending money; repay it to zero first');
        e.status = 400; throw e;
      }
      return;

    case UPDATE:
      EventModel.log({ userId: req.userId, teamId: record.team_id ?? null,
        entity: 'loan', entityId: record.id, action: 'updated', summary: { name: record.name } });
      return;

    case DESTROY:
      EventModel.log({ userId: req.userId, teamId: record.team_id ?? null,
        entity: 'loan', entityId: record.id, action: 'deleted', summary: { name: record.name } });
      return;

    default:
      return;
  }
};

module.exports = { loanHooks };
