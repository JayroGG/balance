# ADR-007 — Jest + supertest harness over a throwaway SQLite file

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Jayro
- **Supersedes / Related:** amends the "no test suite" tooling row locked in `PRD.md` §4 at POC kickoff; pattern borrowed from `llm-insights`.

## Context

The POC deliberately shipped without a test runner; validation was manual curls after each
feature. The project has outgrown that: it now carries auth (ADR-003 sessions), team RBAC
(ADR-005), a global admin role (ADR-006), and hard money invariants (ADR-004) — exactly the
kind of cross-cutting behavior that regresses silently. A mobile client also now consumes the
API against written contracts (`docs/react-native-*.md`), so "it worked when I curled it" is
no longer enough. `llm-insights` already established a house testing pattern: Jest + supertest
against the exported Express app, integration suites per entity, a shared local DB with
destructive teardown, serial runs.

## Decision

Adopt the `llm-insights` pattern, simplified for this stack (CommonJS, no babel/TS transform
needed; `better-sqlite3` is synchronous):

- **Runner:** Jest (`npm test` → `NODE_ENV=test jest --runInBand`), `testEnvironment: node`.
- **HTTP:** supertest against `src/app.js` (no `listen`, no port).
- **DB:** a throwaway SQLite file (`data/balance.test.db`, gitignored) configured by a
  **committed** `.env.test` (no secrets). `test/testSetup.js` (Jest globalSetup) deletes it per
  run; `test/helpers/db.js` applies `schema.sql` and wipes rows between tests. Serial execution
  because suites share the file.
- **Auth:** tests exercise the **real** login flow — `test/helpers/db.js#seedUser` inserts
  bcrypt-hashed users, `test/helpers/api.js#login` obtains JWTs via `POST /auth/login`. No auth
  mocking, no `AUTH_BYPASS` (it is stage-only by design).
- **Layout:** `test/unit-testing/` for pure functions, `test/integration-test/<entity>/` for
  HTTP behavior, `test/helpers/` shared — mirroring `llm-insights`.

## Consequences

- **Positive:** the PRD §6 worked example, the `available ≥ 0` invariant, both RBAC gates, and
  the team-color mobile contract are executable specs (47 tests, ~1s). Real-auth tests cover the
  middleware and session revocation for free.
- **Negative / trade-offs:** serial-only (fine at this scale, ~1s); `db.js` resolves paths so
  `:memory:` isn't usable — the file-based DB is the accepted cost; AUTOINCREMENT ids grow
  across wipes, so tests must capture returned ids, never assume them.
- **Follow-ups:** cover the global admin override paths (ADR-006) and categories hooks; wire
  `npm test` into CI/deploy when a pipeline exists.

## Alternatives considered

- **Keep manual curl validation** — doesn't scale past one contributor and one client; regressions
  in invariants/RBAC are exactly the silent kind.
- **`node:test` built-in runner** — zero deps, but diverges from the house pattern; consistency
  across projects (same layout, same commands) is worth the dev dependency.
- **In-memory SQLite per suite** — cleanest isolation, but requires special-casing `:memory:` in
  `src/config/db.js`; touching prod code purely for tests wasn't worth it versus a per-run file.
