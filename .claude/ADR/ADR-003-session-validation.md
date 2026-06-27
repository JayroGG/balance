# ADR-003 — Stateful session validation over JWT (DB-backed sessions)

- **Status:** Proposed — *deferred*: recorded as the planned mid-point increment, **not scheduled for implementation yet**.
- **Date:** 2026-06-27
- **Deciders:** Jayro Gómez
- **Supersedes / Related:** Refines ADR-001 (auth as a modular layer). Specifies (deferred) PRD §9 Phase 2 (auth).

## Context

ADR-001 established authentication as a single modular boundary (`src/middleware/auth.js`),
shipping a bypass stub now with **DB-hashed passwords + token** as the sanctioned next increment
and **Auth0 JWT Bearer + RBAC** as the north star. This ADR specifies that next increment.

A plain stateless JWT has a known limitation: once issued, a token is valid until it expires.
There is **no real logout** — the server cannot invalidate a token mid-life without extra
machinery. For a mobile client where a user expects "log out" to actually end the session (and
to manage multiple devices independently), pure-stateless is not enough.

Constraints: single-user POC, `better-sqlite3` (synchronous, local file), lean dependencies, no
test runner yet. We want real logout and per-device sessions **without** adopting Auth0 yet, and
without scattering auth logic outside the middleware boundary ADR-001 mandates.

**Timing:** the mobile client is in early UI development on **Expo Go**, where frictionless,
login-free iteration is worth more than authentication. With a single seeded user, adding login
now buys nothing and slows UI work. So this increment is **designed now but deliberately deferred**
— the project stays on the ADR-001 `AUTH_BYPASS` stub until the app stabilizes. This ADR exists so
the transition is on the record (and ready to execute) rather than re-derived later.

## Decision

Adopt a **hybrid model: stateless JWT for identity + a DB `sessions` row for validity.** The token
proves *who*; the session row proves *still allowed*. The token is, in effect, a signed reference
to a server-side session.

- **Now (current state):** keep the ADR-001 `AUTH_BYPASS` stub — no real auth. Frictionless
  Expo Go development continues; nothing below is built until the trigger conditions are met.

- **Deferred mid-point increment (the subject of this ADR):**
  - **Login** (`POST /auth/login`): look up the user by email, compare the password with
    **bcryptjs** (`compareSync`). A token is issued **only if** the user is `active` **and**
    `verified` — both flags set **manually in the DB** for now (no signup/verification flow).
    Anything else (bad credentials, inactive, unverified) → no token (`401`).
  - **Gate at issuance, not in claims:** because no token is issued unless active && verified, the
    token's existence already means "trusted." Flags are **not** mirrored into the payload — no
    redundant re-check downstream. Payload: `{ sub: userId, email, jti: sessionId, iat, exp }`,
    signed **HS256** with a server secret, **7-day** expiry.
  - **Session record:** each successful login creates a `sessions` row
    (`id`, `user_id`, `issued_at`, `expires_at` = +7d, `revoked_at` NULL, `ip`, `user_agent`).
    The row id is embedded in the token as the **`jti`** claim, so the session id travels *inside*
    the token — the client never tracks or passes it separately.
  - **Validation (middleware):** verify signature + `exp`, read `sub` + `jti`, then look up the
    session by `jti` and require: row exists, `user_id` matches `sub`, `revoked_at IS NULL`,
    `expires_at > now`. Only then set `req.userId`. This adds **one indexed query per
    authenticated request** — accepted as negligible on local synchronous SQLite.
  - **Logout** (`POST /auth/logout`): read `jti` from the caller's token, set `revoked_at = now`
    on that session row → `204`. This is **real** revocation: the token is dead immediately,
    independent of its 7-day `exp`.
  - **Multi-device:** one session row per login. Logging out on phone A revokes only A's row;
    phone B's token references a different, still-active session and keeps working. Both
    conditions (valid token + active session) are evaluated per device.
  - **`sessions` doubles as login history.** Successful logins and their end (logout or expiry)
    are fully captured by the rows themselves — so there is **no separate activity/audit table**
    in this increment.
  - **`AUTH_BYPASS` retained** (per ADR-001): when `true`, the middleware injects `req.userId = 1`
    and skips token + session checks entirely (local dev, seeding, tests). Must default `false`
    outside `stage`; the guard lives in the middleware.
  - **No refresh token.** 7-day access token only; on expiry the client re-logs in. Deliberate
    expiration / refresh is deferred.

- **North star (deferred, recorded now):** Auth0 manages its **own** sessions and refresh tokens
  and issues RS256 JWTs. This DB `sessions` store is therefore a **deliberate interim mechanism
  that Auth0 will later subsume** — not throwaway (it gives us real logout today), but not
  permanent. When Auth0 lands, the middleware validates Auth0 JWTs and session/refresh concerns
  move to the IdP; a superseding ADR will record that.

- **Sequencing / triggers (the transition path):**
  1. **Now → bypass stub.** Stay login-free on Expo Go while the UI and features take shape.
  2. **Adopt this mid-point** when the app is stable enough to accept a login step (and you're
     ready to move off Expo Go to a dev client). At that point: write the `/plan-feature` plan,
     flip this ADR to `Accepted`, and implement behind the middleware.
  3. **Adopt Auth0 (north star)** once **fully ejected from Expo Go** (dev client / EAS) — required
     because `react-native-auth0` does not run in Expo Go. A superseding ADR records the swap and
     the `req.userId` (INTEGER) → Auth0 `sub` (string) mapping.

- **Boundary:** unchanged from ADR-001 — `src/middleware/auth.js` remains the *only* place that
  resolves identity. The token shape, session lookup, and bypass all live behind it; routes,
  hooks, and queries still read identity solely via `req.userId`.

## Consequences

- **Positive:** real logout and independent per-device sessions, without adopting Auth0.
- **Positive:** the active/verified gate lives at issuance only — no redundant flag checks, and
  deactivating a user in the DB kills their sessions on the next request (revoked-style behavior
  for free).
- **Positive:** one table (`sessions`) serves both validity and login history.
- **Negative / trade-offs:** auth is no longer purely stateless — **+1 indexed query per
  authenticated request** (accepted on local SQLite). The custom session store diverges from the
  Auth0 north star and will be retired when Auth0 lands.
- **Negative / deferred:** **failed login attempts are not recorded** — a failed login creates no
  session, so it has nowhere to live. If abuse auditing is wanted later, add a separate
  **append-only** `login_activity` log (the mutable-session vs. append-only-audit split) and
  reference `session_id` from it. Out of scope now.
- **Schema follow-ups:** add `active` + `verified` to `users`; add the `sessions` table; seed
  `user_id=1` with a bcrypt hash and `active=1, verified=1`.
- **Implementation follow-up (when triggered):** write the plan in `.claude/agents/plans/`
  (`/plan-feature`), flip this ADR to `Accepted`, and implement behind the middleware boundary;
  add `JWT_SECRET`, `JWT_EXPIRES_IN`, `AUTH_BYPASS`, `SEED_PASSWORD` to env config + validation.
- **Until then:** no code changes — the project stays on the ADR-001 `AUTH_BYPASS` stub.

## Alternatives considered

- **Pure stateless JWT (cosmetic logout).** A `/auth/logout` that only logs an event while the
  token stays valid until `exp`. Rejected: no real logout, no per-device control — the explicit
  thing we want. Cheaper (no per-request query) but doesn't meet the requirement.
- **Token denylist/blocklist.** Store only *revoked* token ids and reject those. Rejected: it
  inverts the model (you track the dead instead of the living), still needs a per-request lookup,
  and doesn't naturally express "list a user's active devices" the way a `sessions` table does.
- **Separate `sessions` + `login_activity` tables now.** Rejected for this increment as premature:
  sessions already are the login history; the append-only audit log only earns its place once we
  track failed attempts. Recorded as the future split.
- **Status flag column on `sessions`.** Rejected: "active" is derivable
  (`revoked_at IS NULL AND expires_at > now`); a stored flag is a denormalization to keep in sync.
- **Adopt Auth0 now.** Rejected per ADR-001: external dependency/cost/UX overhead for a single
  seeded user. Kept as the north star.
