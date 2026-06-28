'use strict';
const { BEFORE_CREATE, CREATE } = require('../../../constants/hooks');
const { addMember } = require('../db/members');

const teamHooks = ({ type, body, record, req }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.name) { const e = new Error('Missing required field: name'); e.status = 400; throw e; }
      return;

    case CREATE:
      // The creator is the first owner.
      addMember(record.id, req.userId, 'owner');
      return;

    default:
      return;
  }
};

module.exports = { teamHooks };
