'use strict';
const { BEFORE_CREATE, CREATE } = require('../../../constants/hooks');
const { addMember } = require('../db/members');

// '#RRGGBB' normalized uppercase; leading '#' optional on input; null = no color.
const normalizeColor = (color) => {
  if (color === null) return null;
  if (typeof color === 'string' && /^#?[0-9A-Fa-f]{6}$/.test(color)) {
    return `#${color.replace('#', '').toUpperCase()}`;
  }
  const e = new Error('color must be a hex color like #RRGGBB'); e.status = 400; throw e;
};

const teamHooks = ({ type, body, record, req }) => {
  switch (type) {
    case BEFORE_CREATE:
      if (!body.name) { const e = new Error('Missing required field: name'); e.status = 400; throw e; }
      if (body.color !== undefined) return { color: normalizeColor(body.color) };
      return;

    case CREATE:
      // The creator is the first owner.
      addMember(record.id, req.userId, 'owner');
      return;

    default:
      return;
  }
};

module.exports = { teamHooks, normalizeColor };
