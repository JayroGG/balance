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
