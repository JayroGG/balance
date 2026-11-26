# ADR-011 — Transactions search, date range and keyset pagination

- **Status:** Accepted
- **Date:** 2026-11-25
- **Related:** ADR-004/010 (balance math excludes journal rows), ADR-009 (events feed shares the pagination helper).

## Context
`GET /transactions` used the generic `restGenerator` list: exact-match filters only, no order, no limit.
The app filtered dates and summed totals on the device over the full list, which stops scaling and
blocks infinite scroll. Events already had ad-hoc `limit` parsing in its route.

## Decision
- A custom `GET /transactions` (registered before `restGenerator`) accepts `q`, `from`, `to`, `type`,
  `category_id`, `loans`, `sort`, `limit`, `cursor` and returns `{ items, next_cursor, totals }`.
- **Keyset** pagination on `(occurred_at, id)` with an opaque cursor — stable when rows are added mid-scroll;
  offset paging would duplicate/skip.
- `totals` are computed server-side over the whole filtered set, excluding loan journal rows (same rule as
  balance math, ADR-004/010).
- Pagination param parsing (limit clamp, positive ints, cursor codec) lives in one shared `src/lib/` helper,
  also used by `/events`.
- Hard switch of the response shape: single client, no compat flag.

## Consequences
- The generic list handler is untouched for other entities.
- New index on `(team_id, occurred_at, id)`.
- Clients must read `items` instead of the array.
- `q` uses SQLite `LIKE`, which is case-insensitive for ASCII only; non-ASCII letters match on exact case.
- Personal-scope queries (`team_id IS NULL`) use the same index and filter `user_id` after the seek; fine at POC volume.
