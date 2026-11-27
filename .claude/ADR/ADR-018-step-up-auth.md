# ADR-018 — Step-up authentication for sensitive actions

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Jayro Gómez
- **Related:** ADR-001 (auth), ADR-015 (refresh tokens), ADR-017 (transfers); FE ADR-024 (biometric unlock)

## Context
Transfers move money across contexts. A valid session alone is not enough; the owner wants identity
re-proven before each transfer, enforced by the server (not only the app).

## Decision
- `POST /auth/step-up { password }` verifies the caller's own password and returns
  `{ permit, expires_at }`: random token, stored hashed, bound to the user, valid 5 minutes, single use.
- Sensitive endpoints (now: `POST /transfers` and `POST /transfers/:id/reverse`) require `X-Step-Up: <permit>`. Missing,
  expired, used or foreign permit -> 403 `{ code: 'STEP_UP_REQUIRED' }`. The permit is consumed inside
  the same DB transaction as the action.
- Wrong password -> 401. No attempt cap exists yet (login has none either); rate-limiting both is a follow-up. No admin bypass.
- Biometrics stay a device feature: the app uses Face ID / fingerprint to release the stored credentials
  (FE ADR-024) and calls step-up with them; without biometrics the user types email + password.

## Consequences
- Positive: the API can't be driven around the identity check; reusable for future sensitive actions.
- Negative: one extra round trip per transfer; a new small table with expired rows (prune on use).
