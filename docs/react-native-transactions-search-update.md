# Frontend update — Transactions search, date range, totals, infinite scroll (`GET /transactions`)

Brief for the React Native agent (ADR-011). **Breaking change:** `GET /transactions` no longer returns
an array. Ship BE first, then switch the client. `GET /transactions/:id` and all writes are unchanged.
Auth, RBAC and `?team_id=` context behave exactly as before.

## Endpoint

### `GET /transactions?q=&from=&to=&type=&category_id=&loans=&sort=&limit=&cursor=&team_id=`

All params optional, combined with AND.

| Param | Meaning |
|---|---|
| `q` | Trimmed, case-insensitive (ASCII) substring on `description` OR category name. Empty = ignored. `%` `_` `\` are literal. |
| `from`, `to` | `YYYY-MM-DD`, inclusive on `occurred_at`; either may be omitted. Invalid date or `from > to` → `400`. |
| `type` | `income` \| `expense`; anything else → `400`. |
| `category_id` | positive integer. |
| `loans` | `only` (loan journal rows) \| `exclude` \| omitted = all. |
| `sort` | `desc` (default) \| `asc` on `(occurred_at, id)`. |
| `limit` | default **30**, max **100**. |
| `cursor` | the previous response's `next_cursor`. Opaque — never build or parse it. Malformed → `400`. |
| `team_id` | context switch, unchanged. |

Send the same filters on every page; only `cursor` changes.

### Response `200`

```json
{
  "items": [ { "id": 1, "type": "expense", "amount": 12.5, "category_id": 3, "description": "Milk",
               "occurred_at": "2026-01-15", "loan_id": null, "team_id": null, "...": "same row shape as before" } ],
  "next_cursor": "WyIyMDI2LTAxLTE1Iiw0Ml0" ,
  "totals": { "income": 1000, "expense": 30.5, "net": 969.5, "count": 3 }
}
```

- `next_cursor` is `null` on the last page — stop requesting.
- `totals` cover the **whole filtered set** (ignore `cursor`/`limit`) — show them from the first page.
  `income`/`expense`/`net` exclude loan journal rows (same rule as the balance); `count` includes them.
- Amounts are decimals, as everywhere else.

## Client notes

- Replace the client-side date/total logic with these params; use `loans=only|exclude` instead of
  filtering on `loan_id`.
- Keyset paging is stable when rows are added mid-scroll (no duplicates/skips), but refresh from page 1
  after any create/edit/delete.
- Non-ASCII letters in `q` match on exact case only (SQLite `LIKE`).
