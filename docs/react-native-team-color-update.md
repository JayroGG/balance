# Frontend update — Team `color` (work done)

Brief for the React Native agent. Backend shipped the `color` field on teams exactly as requested in
`balance-manager/docs/backend-team-color-request.md` (one addition: automatic migration, see §4).
Auth, RBAC, `?team_id=` context, and every other endpoint are unchanged.

**TL;DR**
- `teams.color` exists: `"#RRGGBB"` (uppercase, leading `#`) or `null` (= client default accent).
- `POST /teams` takes optional `color`; `PUT /teams/:id` takes `{ name?, color? }` (≥ 1 field;
  `color: null` clears). Invalid color → `400`.
- `GET /teams` and `GET /teams/:id` return `color` on every row. No manual DB migration needed.

---

## 1. Final request/response shapes

### `POST /teams`

Body: `{ name, color? }` — `name` required as before; `color` optional.

- `color` accepted as 6 hex digits, leading `#` optional, case-insensitive: `"7c3aed"`, `"#7C3AED"`,
  `"#7c3aed"` all valid → stored/returned normalized as `"#7C3AED"`.
- `color: null` or omitted → stored as `null`.
- Invalid (`"purple"`, `"#ABC"`, numbers, etc.) → `400 { "error": "color must be a hex color like #RRGGBB" }`.
- Missing name → `400 { "error": "Missing required field: name" }` (unchanged).

Response `201`:

```json
{ "id": 1, "user_id": 1, "name": "Design", "color": "#7C3AED",
  "created_at": "...", "updated_at": "...", "deleted_at": null }
```

### `PUT /teams/:id` (owner-only, unchanged gating)

Body: `{ name?, color? }` — **at least one** field required.

- `color`-only body is valid (no more missing-name `400`).
- `color: null` **clears** the color (returns to `null`).
- Omitted `color` = untouched; same for `name`. `name` present but empty → `400` as before.
- Neither field → `400 { "error": "Provide at least one field: name, color" }`.
- Invalid color → same `400` as POST. Response `200` with the full updated team row.

## 2. Confirmations

- `GET /teams` returns `color` per row (plus your `role`, as before):
  `[{ id, user_id, name, color, role, created_at, updated_at, deleted_at }]`.
- `GET /teams/:id` (member-gated detail) also carries `color`.
- `color: null` clear-on-update implemented **exactly as specified**.

## 3. Deviations from the request

None in the contract — validation regex (`/^#?[0-9A-Fa-f]{6}$/`), normalization (`#` + uppercase),
status codes, and error message are verbatim from the request doc. All acceptance curls from the
request pass. RBAC untouched: any owner can set/clear color; create is any user.

## 4. Migration note (nothing to run)

Beyond the request: the backend now **auto-adds the column** — on every boot (`npm start`) and on
`npm run migrate`, it checks `PRAGMA table_info(teams)` and runs
`ALTER TABLE teams ADD COLUMN color TEXT` if missing. So existing local/stage/prod DBs upgrade
themselves on the next start; the manual one-off `ALTER` from the request doc also still works but
is unnecessary. Existing rows stay `color: null` (no backfill), as requested.
