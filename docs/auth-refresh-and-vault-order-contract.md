# Contract note — refresh tokens and vault order (ADR-015, ADR-016)

For API clients (mobile app).

## Auth
- `POST /auth/login { email, password }` → `200 { token, refreshToken }`. `token` is a short-lived access JWT
  (default 1h); `refreshToken` is opaque (default 60d, sliding).
- `POST /auth/refresh { refreshToken }` (public) → `200 { token, refreshToken }`. Rotation: the old
  refresh token is dead afterwards; always store the new one.
  - Missing field → `400`. Invalid, expired, revoked, user inactive/unverified → `401 { error }`.
  - Re-sending an already-rotated token revokes the whole session → `401`; the user must log in again.
- `POST /auth/logout` revokes the session: access and refresh token both stop working.
- Send at most one refresh at a time per session; concurrent refreshes with the same token look like reuse.
- Refresh on `401` from any protected route, then retry the original request once.

## Vault order
- `PUT /vaults/order { ids: number[] }` → `204`. Optional `?team_id=` selects the context. Every id must be a
  live vault of that context (`404` otherwise); ids must be positive integers without repeats (`400`).
  The order is per user; any team role may set its own.
- `GET /vaults` and the `/balance` `vaults` array return the caller's order: ordered vaults by position,
  then the rest by creation time.

## Step-up and transfers (ADR-017, ADR-018)
- `POST /auth/step-up { password }` → `200 { permit, expires_at }` (5 min, single use). Wrong password → `401`.
- `POST /transfers` and `POST /transfers/:id/reverse` need header `X-Step-Up: <permit>`; missing/expired/used → `403 { code: 'STEP_UP_REQUIRED' }`.
- `POST /transfers { to_team_id|null, amount, description?, occurred_at?, vaults?: [{ vault_id, amount }] }`; source is `?team_id=` (omitted = personal). Caller must be a real owner of both contexts (admins get no bypass → `403`). `vaults` is required only when `available < amount` and must sum to exactly `amount − available`.
- `POST /transfers/:id/reverse` creates a new opposite transfer (`reversal_of`); once per transfer, `400` if the destination's `available < amount`.
- `GET /transfers`, `GET /transfers/:id` — any role of either side. Transaction rows of type `transfer_out`/`transfer_in` carry `transfer_id` + `counterpart_label` and are read-only via `/transactions`.
