'use strict';
// The events model is hand-written (the feed needs ordering, limit, since_id and a
// users join that modelGenerator doesn't do); this file documents the query surface.
const fields = {
  filterFields: ['entity', 'action'],
};
module.exports = { fields };
