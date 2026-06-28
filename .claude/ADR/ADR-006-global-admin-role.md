# ADR-006 — Global admin role (platform super-admin) over team RBAC

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Jayro Gómez
- **Supersedes / Related:** Extends ADR-005 (team RBAC). Related: ADR-001 (auth boundary), ADR-003 (DB sessions / JWT).

## Context

ADR-005 introduced **per-team** roles (`owner | member | guest`). That covers authorization *within*
a team, but there is no notion of a **platform-level** actor who can operate across all teams and all
users for support, moderation, and data fixes. The product owner wants to mint **admin accounts**
alongside normal accounts, where an admin **bypasses everything**: team RBAC gates, team membership,
and row ownership — and can reach **any** user's data, including personal-context data.

This is distinct from the team `owner` (the "admin bypass" within a single team from ADR-005). It is a
**global** capability attached to the user identity, not to a membership row.

Constraints unchanged: POC, `better-sqlite3` (synchronous, single-threaded), lean deps, the single
identity boundary of ADR-001, and the DB-session JWT of ADR-003.

## Decision

Add a **global role** to the user identity and let `admin` override all authorization.

- **Schema:** `users.role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin'))`. (Distinct
  from `team_members.role`; the two never mix.)
- **Identity:** `role` is included as a JWT claim at login and read by `src/middleware/auth.js`, which
  sets `req.isAdmin` and `req.context.isAdmin`. Under the `AUTH_BYPASS` stub the role is read from the
  DB for the seeded user so admin can be exercised locally. (Trusting the claim is consistent with how
  `sub`/`email` are trusted; the per-request session check of ADR-003 still allows instant revocation
  via logout, and admin status changes rarely.)
- **Bypass scope (full god-mode):**
  - **Team RBAC + membership:** `resolveContext` grants an admin any existing team via `?team_id=`
    **without** a membership row (role treated as `owner`); `src/lib/access.js` gates
    (`assertCanWrite`/`assertOwns`) short-circuit for admins; the teams controller `requireRole`
    returns early for admins; `GET /teams` lists **all** teams for an admin.
  - **Ownership / cross-user:** in `modelGenerator`, single-row ops (`findById`/`update`/`softDelete`)
    reach **any** record by id for an admin (god-mode), and list scoping lets an admin target a
    specific team (`?team_id=`) or a specific user's personal data via an **admin-only `?user_id=`**
    selector (ignored for non-admins — no privilege escalation). Balance queries honor the same.
- **Creating admins:** `src/db/createUser.js` takes an optional `role` arg (`user`|`admin`).
- **Integrity invariants are NOT bypassed.** Admin overrides *authorization*, not *data correctness*:
  `available ≥ 0`, a vault deletes only at balance 0, a team deletes only when empty, and the
  last-owner guard all still hold for admins. These are correctness rules, not permissions.
- **Boundary (ADR-001) preserved:** identity (incl. `isAdmin`) is resolved only in `auth.js`; routes,
  hooks, queries read it via `req.isAdmin` / `req.context`.

- **North star (deferred):** when Auth0 lands, the platform role moves to IdP roles/claims (RS256);
  this `users.role` column becomes the interim store, retired by a superseding ADR.

## Consequences

- **Positive:** one global flag delivers support/moderation god-mode without per-feature special cases;
  it composes with team RBAC instead of replacing it.
- **Positive:** admin-only `?user_id=` makes cross-user personal access explicit and auditable in logs,
  while being inert for normal users.
- **Negative / trade-offs:** a broad capability — an admin can read/write anyone's data. Guard admin
  account creation. The role rides in the JWT, so a freshly-granted/revoked admin is only fully current
  after re-login or session revocation (acceptable: admin status rarely changes; logout is instant).
- **Negative / deferred:** no admin **audit log** of cross-user actions yet (request logging captures
  method/url/status only). Add an append-only audit table if accountability is needed later.

## Alternatives considered

- **Reuse team `owner` as the admin.** Rejected: owner is per-team and cannot express
  cross-team/cross-user platform power.
- **Resolve `role` from the DB every request instead of the JWT.** Viable (always current) and we
  already query the session row; rejected for now to keep the claim model uniform with `sub`/`email`.
  Revisit if instant admin revocation without logout becomes a requirement.
- **A separate `admins` table / boolean `is_admin`.** Equivalent; a single `role` enum on `users` is
  simpler and extends to more platform roles later.
- **Bypass integrity invariants too.** Rejected: those protect data correctness, not access; an admin
  can still achieve any end-state through the normal guarded operations.
