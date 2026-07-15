# ADR-009 — Activity events ledger: a polled feed now, remote push as a delivery channel later

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Jayro
- **Supersedes / Related:** builds on ADR-004 (append-only ledgers), ADR-005 (team RBAC), ADR-006 (global admin), ADR-008 (checkout atomicity).

## Context

The motivating ask was push notifications: "tell me when a teammate books a transaction." But
remote push to iOS requires a paid Apple Developer Program membership regardless of provider —
OneSignal, Firebase, and Expo all deliver through APNs — and this project doesn't have one. Only
Android getting notifications was ruled out as pointless.

Meanwhile the underlying value isn't the push itself: it's *knowing what happened* in a shared
team. Nothing in the system records mutations as history — a member's transaction is visible as
data, but "who did what, when" is not queryable. Whatever notification channel eventually exists,
it needs exactly that record. So the channel question (push, polling, websockets) is separable
from the data question (an activity ledger), and the data half has no Apple dependency at all.

## Decision

**An append-only `events` ledger + a read-only polled feed, with remote push recorded as the
north star delivery channel.**

- **Now (MVP):** every meaningful successful mutation appends a row to `events`
  (`user_id` = actor, `team_id` = the affected record's context, `entity`, `entity_id`, `action`,
  JSON `summary` snapshot with decimal amounts). `GET /events` serves the feed, context-scoped
  exactly like `/transactions` (personal = own actions; `?team_id=` = every member's actions),
  newest-first with `entity`/`action`/`since_id`/`limit` params. The client polls (on focus /
  pull-to-refresh) and may fire local notifications for unread events — zero infrastructure.
- **North star (deferred):** remote push via **Expo Push Service** (`expo-notifications` in the
  app, `expo-server-sdk` on this backend, APNs `.p8` key managed by EAS). OneSignal was rejected:
  the mobile app is already Expo, so OneSignal adds a vendor SDK and dashboard to do what Expo
  does natively for free. The only blocker is the $99/year Apple Developer membership.
- **Boundary (the seam):** push is a *delivery channel over the same ledger* — when it lands, the
  work is a `push_tokens` entity plus a sender invoked where `EventModel.log` is called (or a thin
  dispatcher wrapping it). No schema, feed, or client-screen changes.

### Mechanics

- **Emission points.** Generated CRUD logs from the **after-hooks** (`CREATE`/`UPDATE`/`DESTROY`),
  so only writes that actually landed are recorded, with the post-write (decimal-formatted)
  record. Custom flows log in their controllers: vault allocate/withdraw, list checkout, team
  management. The checkout event is **inside** the existing `db.transaction`, atomic with the
  expense + freeze — a rejected checkout logs nothing (extends ADR-008's atomicity).
- **Immutability.** Like `vault_history`: no `updated_at`/`deleted_at`, no update/delete paths,
  no write routes. `EventModel.log` is the only writer, and it is fail-loud (no try/catch — an
  insert failure means the DB itself is broken).
- **Hand-written model.** The feed needs DESC ordering, `LIMIT`, `since_id`, and a `users` join —
  none of which `modelGenerator.findAll` does. Same precedent as `shopping_list_items` (ADR-008):
  bypass the generator rather than bloat it for one consumer.
- **Access.** Reads are open to all roles (guests included), consistent with ADR-005;
  `resolveContext` already rejects non-members. Admins reach any team feed and, via `?user_id=`,
  any user's personal feed.
- **Catalog.** transactions created/updated/deleted; vaults created/deleted/allocated/withdrawn;
  shopping lists created/checked_out/deleted; list items created/updated/deleted (events carry the
  **parent list's** context, since items have no `team_id`); team updated / member_added /
  member_removed / role_changed.

## Consequences

- **Positive:** teammate awareness ships with no Apple/Firebase dependency; the ledger doubles as
  an audit trail; push later is additive, not a redesign; `since_id` gives the client cheap unread
  badges.
- **Negative / trade-offs:**
  - Not real-time — the app must be opened (or poll) to learn anything. Accepted: this *is* the MVP.
  - Personal feeds are **actor-keyed**, so an admin editing another user's personal data logs an
    event only the admin's own feed shows. Accepted for a personal project; a `subject_user_id`
    column is the fix if it ever matters.
  - Deliberately unlogged: categories CRUD, vault/list renames, team create/delete (no audience or
    pure noise). Each is a three-line hook case away if wanted.
  - `events` grows forever (append-only). Fine at this scale; pruning would be a later ADR.
  - Team deletion still only checks transactions/vaults (`isEmpty` unchanged) — events never block
    it, and a deleted team's events become unreachable history. Accepted.
- **Follow-ups:** `push_tokens` entity + Expo push sender when the Apple membership exists;
  RN activity-feed screen (brief: `docs/react-native-activity-feed-update.md`).

## Alternatives considered

- **OneSignal** — rejected; redundant vendor on an Expo app, and it doesn't remove the Apple
  membership requirement (nothing does).
- **Remote push now, Android-only** — rejected by product criterion: asymmetric notifications
  make no sense for a two-platform household app.
- **Websockets / SSE** — real-time without APNs, but only while the app is open, which polling
  already covers at this scale; permanent connection infrastructure for marginal gain.
- **Deriving activity from existing tables (no ledger)** — reconstructing "who did what" from
  `updated_at`/`deleted_at` loses updates' before/after, misses vault moves' actors, and can't
  order heterogeneous mutations; a ledger is the honest model (same reasoning as ADR-004).
