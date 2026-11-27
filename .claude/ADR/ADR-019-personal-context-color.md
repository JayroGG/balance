# ADR-019 — Personal context color

- **Status:** Accepted (BE `balance`)
- **Date:** 2026-11-27

## Context
Teams carry a `color` the client uses as the accent of that context; the personal context (no team) has
none and always shows the client default. There is no endpoint for the caller's own user row.

## Decision
- `users.color TEXT NULL` (`#RRGGBB` or NULL = client default), added to `schema.sql` and by the idempotent
  PRAGMA-guarded ALTER in `server.js` / `migrate.js`, like `teams.color`.
- `GET /users/me` → `200 { id, email, color }`; `PATCH /users/me { color }` → same shape.
- Own row only: no id in the path, the row is always `req.userId`. Admins get no override here.
- Validation reuses the team `normalizeColor` (hex, optional `#`, normalized uppercase, `null` clears);
  invalid or missing `color` → `400`.
- Not context-scoped and emits no activity event (a personal display preference, like ADR-016).

## Consequences
- The same account shows the same personal accent on every device.
- Clients must fall back to the default when the endpoint is missing or errors (APK vs. unmerged BE).
