# ADR-001 — Authentication as a modular layer (DB-hashed now, Auth0 north star)

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Jayro Gómez
- **Supersedes / Related:** Refines PRD §4 (Auth) and PRD §9 Phase 2.

## Context

`balance` is a single-user POC. Today `src/middleware/auth.js` injects a fixed `req.userId = 1`;
there is no real authentication. Every table already carries `user_id` and every query is
user-scoped, so the data model is auth-ready — only the identity resolution is stubbed.

We want to move fast on the prototype **without painting ourselves into a corner**. The principle
is: aim high from day one (record the best-practice target), but ship the leanest thing that
works now, behind a seam that makes the upgrade cheap. Authentication is a textbook case — it
should be a replaceable block, like Lego, not wired through the whole codebase.

## Decision

Treat authentication as a **single modular boundary**. `src/middleware/auth.js` is the *only*
place that resolves a request into an identity (`req.userId`). Everything downstream is
auth-agnostic and never changes when the mechanism changes.

- **Now (prototype):** keep the bypass stub. It is explicitly toggleable via an env flag
  (e.g. `AUTH_BYPASS=true` → inject `req.userId = 1`), so auth can be turned off for local dev,
  seeding, and tests just by flipping a variable.
- **Next increment:** **DB-backed hashed passwords** (bcrypt/argon2) issuing a token, validated
  inside the same middleware. This is acceptable, "good-enough" auth for an early real deployment.
- **North star (deferred, recorded now):** **Auth0** as the identity provider — hosted login,
  JWT / `idToken` Bearer auth, and **roles & permissions (RBAC)**. The mobile client
  (see `docs/react-native-expo-PRD.md`) already standardizes on `react-native-auth0`, so the
  backend's eventual job is to validate Auth0-issued JWTs. We are **not building this for the MVP**,
  but it is the documented target so the gap is intentional, not accidental.
- **Boundary contract:** whatever the mechanism, it must end by setting `req.userId` (and later
  `req.userRoles` / `req.permissions`). No route, controller, hook, or query reads auth state
  any other way. Swapping bypass → DB-hashed → Auth0 means editing one file.

## Consequences

- **Positive:** the prototype ships with zero auth friction; the upgrade path is a single
  middleware swap with queries untouched (every table already has `user_id`).
- **Positive:** the "shoot high" target (Auth0 + RBAC) is on the record from the start.
- **Negative / trade-offs:** the bypass flag is a foot-gun if it ever ships enabled to prod —
  it must default to `false` outside `stage`, and that guard belongs in the middleware.
- **Follow-ups:** (1) add `AUTH_BYPASS` handling + env validation; (2) design the user/role/
  permission schema so RBAC drops in later; (3) when Auth0 work starts, write a plan in
  `.claude/agents/plans/` and a superseding ADR if the contract changes.

## Alternatives considered

- **Adopt Auth0 now.** Rejected for the POC: external dependency, setup/cost, and login UX
  overhead that buys nothing while there is a single seeded user. Kept as the north star instead.
- **Session cookies.** Rejected: the API is token-oriented and primarily serves a mobile client,
  where Bearer tokens are the natural fit.
- **No auth seam (inline checks).** Rejected: scatters identity logic across the codebase and
  makes the future swap expensive — the opposite of the modular goal.
