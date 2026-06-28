# ADR-005 — Team RBAC: owner / member / guest with a two-gate authorization model

- **Status:** Accepted
- **Date:** 2026-06-28
- **Deciders:** Jayro Gómez
- **Supersedes / Related:** Builds on the multi-tenant context model (`team_id` + `resolveContext`)
  shipped earlier; refines ADR-001 (auth as a modular layer). Related: ADR-004 (derived balance,
  per-context invariants).

## Context

Multi-tenancy shipped with **binary** team authorization: `resolveContext` verified only that the
caller was *a member* of the team in `?team_id=`, after which any member could read **and write** any
of that team's rows. Two gaps surfaced:

1. **No graded permissions.** Shared finance needs roles — someone who can only look (a guest), a
   contributor who manages their own entries, and an admin who manages everything and everyone.
2. **Team management was creator-bound.** `PUT`/`DELETE /teams/:id` used the *generated*
   CRUD scoped to `teams.user_id` (the creator), so a co-owner added later could manage members but
   could not rename or delete the team. Inconsistent, and it blocks real multi-owner teams.

The mobile client also needs `GET /teams` as its context-switcher and must vary screen affordances by
the caller's role. Constraints unchanged: POC, `better-sqlite3` (synchronous, single-threaded), lean
deps, no test runner.

## Decision

Introduce a three-tier role on `team_members` (`role IN ('owner','member','guest')`) and enforce it
with **two independent gates**, centralized so every team-scoped entity behaves identically.

- **Gate 1 — method capability (role):** guests are **read-only**; owner/member (and personal
  context) may write. There is no method-level owner/member split.
- **Gate 2 — row ownership:** for **edit/delete/allocate/withdraw**, a **member** may act only on rows
  they created (`record.user_id === req.userId`); an **owner bypasses** ownership (the "admin
  bypass"); **personal context** is already `user_id = self`-scoped, so the gate is a no-op there.
- **Reads are open to all roles** — members/guests/owners all see *all* of the team's rows.
- **Team management** (rename, delete, add/remove member, change role) is **owner-only, decided by
  `team_members.role`** — not by `teams.user_id`. Multiple owners are first-class; the creator has no
  special power beyond being the first owner. Race-free explicit guards (e.g. last-owner count) are
  sufficient because the DB is synchronous/single-threaded.
- **Team deletion is blocked unless the team is empty** (no active transactions or vaults) — mirrors
  the existing "a vault deletes only at balance 0" rule. Non-cascading: leftover `team_members` /
  `categories` become inert once the team is soft-deleted.

**Boundary / seam:** the gates live in **one** helper, `src/lib/access.js` (`assertCanWrite`,
`assertOwns`, `assertCanMutate`), called from the generic `restGenerator` write handlers
(create/update/destroy) and the two custom vault write routes (allocate/withdraw). `resolveContext`
resolves `roleOf()` → `req.context.role`; the `modelGenerator` is unchanged (stays a pure scoped
CRUD — ownership is decided in the handler layer). All role writes funnel through
`teams/db/members.js` (`addMember` / `setRole` / `removeMember`).

- **North star (deferred):** Auth0 + richer RBAC. The single `members.js` role-write seam is where a
  future Auth0 integration would also sync the IdP role, so the swap stays local. No Auth0 call now.

## Consequences

- **Positive:** graded, uniform permissions across transactions/vaults/categories/balance with one
  enforcement point; real multi-owner teams; consistent role-based management; guest (read-only)
  sharing; safe deletion.
- **Positive:** `addMember` is now an upsert (`ON CONFLICT … DO UPDATE … deleted_at = NULL`), fixing a
  latent bug where a soft-deleted membership row made a removed member un-re-addable.
- **Negative / trade-offs:** the ownership gate lives in the handler layer, not the model — any
  *future* custom write route must remember to call it (today only vault allocate/withdraw); mitigated
  by the single `access.js` home. No automated tests — a curl role matrix is the safety net.
- **Follow-ups:** if cascade-on-delete is ever wanted, add it explicitly; if guest needs finer read
  scoping, revisit. Auth0 role-sync at the `members.js` seam when ADR-001's north star lands.

## Alternatives considered

- **Enforce ownership in `modelGenerator` (WHERE `user_id = self` for members).** Rejected: reads must
  stay open to all members, so the predicate would have to be write-only and conditional on role,
  complicating the central generator and producing silent 0-row "no-op" updates instead of a clear
  403. Handler-layer gating gives explicit 403s and keeps the model pure.
- **Keep team management creator-scoped.** Rejected: blocks multi-owner teams (the explicit goal) and
  is inconsistent with role-based member management already in place.
- **Cascade-delete a team's data.** Rejected for the POC: wider blast radius; block-until-empty is the
  same shape as the vault-at-0 rule and keeps deletion a deliberate act.
- **Add roles to the JWT/claims.** Rejected: role is per-team and mutable; resolving it per request
  from `team_members` (one indexed query, already paid for membership) is simpler and always current.
