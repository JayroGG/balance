'use strict';
const { BEFORE_CREATE, BEFORE_DESTROY } = require('../../../constants/hooks');
// Import balance queries directly to avoid circular index deps
const { vaultBalanceCents } = require('../../balance/db/queries');

const vaultHooks = ({ type, body, record, req }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.name) { const e = new Error('Missing required field: name'); e.status = 400; throw e; }
      return;

    case BEFORE_DESTROY:
      if (vaultBalanceCents(req.userId, record.id) !== 0) {
        const e = new Error('Cannot delete a vault with a non-zero balance; withdraw it to zero first');
        e.status = 400; throw e;
      }
      return;

    default:
      return;
  }
};

module.exports = { vaultHooks };
