'use strict';
// Centralized RBAC gates for team-scoped writes (ADR-005). Personal context has
// role null and is already self-scoped, so both gates are no-ops there.
const httpError = (message, status) => Object.assign(new Error(message), { status });

// Gate 1 — method capability: guests are read-only; owner/member (and personal) may write.
// A global admin (isAdmin) overrides all RBAC.
const assertCanWrite = ({ role, isAdmin }) => {
  if (isAdmin) return;
  if (role === 'guest') throw httpError('Guests have read-only access', 403);
};

// Gate 2 — row ownership: a team member may mutate only rows they created; owner bypasses.
// A global admin bypasses ownership entirely.
const assertOwns = ({ userId, role, isAdmin }, record) => {
  if (isAdmin) return;
  if (role === 'member' && record.user_id !== userId) {
    throw httpError('Members can only modify records they created', 403);
  }
};

const assertCanMutate = (context, record) => {
  assertCanWrite(context);
  assertOwns(context, record);
};

module.exports = { assertCanWrite, assertOwns, assertCanMutate };
