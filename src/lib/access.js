'use strict';
// Centralized RBAC gates for team-scoped writes (ADR-005). Personal context has
// role null and is already self-scoped, so both gates are no-ops there.
const httpError = (message, status) => Object.assign(new Error(message), { status });

// Gate 1 — method capability: guests are read-only; owner/member (and personal) may write.
const assertCanWrite = ({ role }) => {
  if (role === 'guest') throw httpError('Guests have read-only access', 403);
};

// Gate 2 — row ownership: a team member may mutate only rows they created; owner bypasses.
const assertOwns = ({ userId, role }, record) => {
  if (role === 'member' && record.user_id !== userId) {
    throw httpError('Members can only modify records they created', 403);
  }
};

const assertCanMutate = (context, record) => {
  assertCanWrite(context);
  assertOwns(context, record);
};

module.exports = { assertCanWrite, assertOwns, assertCanMutate };
