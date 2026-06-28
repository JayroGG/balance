# Feature: Global admin role (platform super-admin)

> Written alongside the implementation (the plan step was skipped in-session and is recorded here for
> the standard workflow trail). Decision rationale lives in ADR-006; this is the build plan.

## Feature Description

Add a **global role** to users (`user | admin`) where `admin` is a platform super-admin that bypasses
**all** authorization: team RBAC (ADR-005), team membership, and row ownership — and can reach any
user's data, including personal-context data. Distinct from the per-team `owner`. Integrity invariants
(`available ≥ 0`, vault-at-0 delete, team-delete-when-empty, last-owner) are **not** bypassed.

**Type:** New capability (authorization). **Complexity:** Medium. **Deps:** none new.

## Problem / Solution

ADR-005 only governs authority *within* a team. There's no platform actor for support/moderation/data
fixes across all teams and users. Solution: a `users.role` column carried as a JWT claim, surfaced as
`req.isAdmin` / `req.context.isAdmin` at the single auth boundary (ADR-001), with bypass logic added at
the central choke points (model scoping, access gates, context resolution, teams controller).

## Context references (files touched)

- `src/db/schema.sql` — add `users.role` enum column.
- `src/db/createUser.js` — optional `role` arg to mint admins.
- `src/entities/auth/db/users.js` — `findByEmail` returns `role`; add `roleById` (bypass path).
- `src/entities/auth/http/controller.js` — include `role` in the JWT claim.
- `src/middleware/auth.js` — `setIdentity` sets `req.isAdmin` + `req.context.isAdmin`; JWT reads the
  claim, bypass path reads the DB role.
- `src/middleware/resolveContext.js` — admin reaches any existing team without membership; admin-only
  `?user_id=` selector for personal data of any user.
- `src/utils/modelGenerator/index.js` — `scopeClause` admin branch (team / targetUser / own for lists);
  `rowScope` gives admins god-mode single-row access by id (`findById`/`update`/`softDelete`).
- `src/lib/access.js` — `assertCanWrite` / `assertOwns` short-circuit for `isAdmin`.
- `src/entities/balance/db/queries.js` — `where()` honors `targetUserId`; admin team flows via `teamId`.
- `src/entities/teams/http/controller.js` — `requireRole` early-returns for admins; `listMine` → all
  teams; `getOne` 404s on missing team for admins.
- `src/entities/teams/db/model.js` — `listAll()` (admin god-mode team list).

## Implementation tasks (as executed)

1. **Schema + createUser:** add `users.role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))`;
   `createUser.js <email> <password> [user|admin]`.
2. **Identity:** `users.findByEmail` selects `role`; `+roleById`; login signs `role` into the token;
   `auth.js` sets `req.isAdmin` + `context.isAdmin` (bypass path reads DB role for the seeded user).
3. **Bypass at choke points:** `access.js` gates skip for admin; `resolveContext` grants any team +
   adds admin-only `?user_id=`; `modelGenerator` `scopeClause`/`rowScope` admin branches; balance
   `where()` honors `targetUserId`.
4. **Teams:** `requireRole` admin bypass; `listMine` → `listAll()` for admin; `getOne` existence 404.
5. **Verify:** see below.

## Validation (performed)

- `node --check` all files; `require('./src/app')` loads.
- Fresh DB migrate + seed; provisioned an `admin` (not a member of team 1), a normal user, and data
  owned by user 1.
- Booted with real auth (`AUTH_BYPASS=false`), logged in via JWT, asserted:
  - admin `GET/PUT` on team 1 data **without membership** → 200; `GET /balance?team_id=1` → 200.
  - admin `?user_id=1` returns user 1's personal rows; admin `PUT` of user 1's personal row by id → 200.
  - admin `GET /teams` → all teams; admin add-member / rename on a team they don't own → 201 / 200.
  - **non-admin** `?user_id=1` is ignored (returns own/empty, not user 1's) — no escalation.
  - member-not-owner write on another's row still → 403 (RBAC intact for non-admins).

## Notes / risks

- Broad capability — protect admin account creation. Audit logging of cross-user admin actions is
  deferred (ADR-006).
- Role rides in the JWT → newly granted/revoked admin is current after re-login or session revocation.
- Integrity invariants deliberately remain enforced for admins.
