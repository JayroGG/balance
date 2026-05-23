'use strict';
const { BEFORE_CREATE, BEFORE_UPDATE } = require('../../../constants/hooks');

const VALID_KINDS = ['income', 'expense', 'both'];

const assertKind = (kind) => {
  if (kind !== undefined && !VALID_KINDS.includes(kind)) {
    const e = new Error(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    e.status = 400; throw e;
  }
};

const categoryHooks = ({ type, body }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.name) { const e = new Error('Missing required field: name'); e.status = 400; throw e; }
      if (!body.kind) { const e = new Error('Missing required field: kind'); e.status = 400; throw e; }
      assertKind(body.kind);
      return;
    case BEFORE_UPDATE:
      assertKind(body.kind);
      return;
    default:
      return;
  }
};

module.exports = { categoryHooks };
