'use strict';
// Shared list-pagination parsing (events feed, transactions search): positive
// ints, limit clamp, and an opaque keyset cursor. Failures are 400s.

const httpError = (message, status = 400) => Object.assign(new Error(message), { status });

const positiveInt = (raw, name) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw httpError(`${name} must be a positive integer`);
  return n;
};

const parseLimit = (raw, { def, max }) => Math.min(positiveInt(raw, 'limit') ?? def, max);

// Cursor = base64url(JSON array of key parts). Opaque to clients; the caller
// validates the decoded parts' shape.
const encodeCursor = (parts) => Buffer.from(JSON.stringify(parts)).toString('base64url');

const decodeCursor = (raw) => {
  if (raw === undefined) return undefined;
  try {
    const parts = JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'));
    if (Array.isArray(parts)) return parts;
  } catch { /* fall through */ }
  throw httpError('cursor is invalid');
};

module.exports = { httpError, positiveInt, parseLimit, encodeCursor, decodeCursor };
