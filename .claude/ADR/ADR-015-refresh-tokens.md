# ADR-015 — Refresh tokens with rotation

- **Status:** Accepted (BE `balance`)
- **Date:** 2026-11-26

## Context
Login issues one 7-day JWT bound to a `sessions` row. When it expires the app forces a password login.

## Decision
- Login returns a short access JWT (`JWT_EXPIRES_IN`, default 1h) and an opaque refresh token
  (32 random bytes, `REFRESH_EXPIRES_IN`, default 60d sliding).
- Only SHA-256 of the refresh token is stored, on the same `sessions` row (`jti` unchanged).
- `POST /auth/refresh` rotates: new refresh token every call; presenting the previous one again revokes
  the session (reuse detection).
- Logout / revocation of the session kills both tokens. Inactive/unverified users cannot refresh.

## Consequences
- Session lifetime = refresh lifetime; access tokens stay short, limiting a leaked JWT.
- Clients must handle refresh concurrency (one refresh in flight).
- Replay detection covers one generation (the previous token). A client that loses a refresh response and
  retries with the old token has its session revoked and must log in again — accepted for safety.
- `JWT_EXPIRES_IN` default drops from `7d` to `1h`; deployments that set it explicitly (e.g. `fly.toml`) must
  lower it to get the short-token benefit. Sessions created before the migration have no refresh token and
  end when their old access token expires.
