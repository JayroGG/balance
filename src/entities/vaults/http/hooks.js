'use strict';
const { BEFORE_CREATE } = require('../../../constants/hooks');

const vaultHooks = ({ type, body }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.name) { const e = new Error('Missing required field: name'); e.status = 400; throw e; }
      return;
    default:
      return;
  }
};

module.exports = { vaultHooks };
