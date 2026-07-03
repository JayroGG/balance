# ADR-008 — Auto-capture domain model: sources, aliases, captures (+ transfers)

- **Status:** Accepted
- **Date:** 2026-07-02
- **Deciders:** Jayro
- **Supersedes / Related:** builds on ADR-004 (ledger semantics unchanged), ADR-005/006 (RBAC
  reused for routing + transfers), ADR-003 (sessions table extended for scoped tokens). Contract:
  `docs/react-native-auto-capture-request.md`; rationale: mobile repo
  `docs/auto-transaction-capture-research.md` §8.

## Context

The mobile client wants transactions created automatically from payment notifications
(Google Wallet / Apple Pay / bank-app pushes, relayed by iOS Shortcuts / MacroDroid). A
notification is *evidence* of a payment, not a transaction: the same purchase can be reported by
two apps (wallet + bank), card-less pushes (SPEI) carry no card number yet must resolve to an
account, and each card/account must route to its own context (personal vs a team) — an automation
cannot know which tab is open. Without an identity + routing + dedup layer, auto-capture would
double-book and dump everything into one context.

## Decision

Add an intermediate evidence layer between "notification arrived" and "transaction exists",
resolved entirely server-side (devices send structured fields only; raw notification text never
leaves the phone):

- **`payment_sources`** — one row per pot of money (bank `account` or `credit_card`; a debit card
  is an access method to its account, not a source). User-owned, never team-scoped; each source
  carries the **routing rule** `target_team_id` (`NULL` = personal) deciding where its
  transactions land, plus an optional `default_category_id`.
- **`source_aliases`** — per-channel recognition: `card_last4` (4 digits) or `channel_default`
  (the channel's only pot, for card-less pushes). A channel may have at most one active
  `channel_default` per user.
- **`captures`** — the append-ish ingest ledger: one row per evidence with provenance and dedup
  state (`pending | posted | duplicate | discarded`). Ingest pipeline on `POST /captures`:
  1. exact dedup by `(user, channel, notification_hash)` → idempotent 200 with the existing row;
  2. alias match (`last4` → `card_last4`, else `channel_default`) → no match = `pending`;
  3. cross-channel dedup: same source/amount/direction within ±5 min → `duplicate` + `duplicate_of`;
  4. auto-post a real transaction in the source's routed context (`type` from `direction`,
     `occurred_at` from `captured_at`, category from the source default). Any step-4 failure
     (available-rule, lost team access) leaves the capture `pending` — **ingest never 4xxs a
     well-formed capture** (automations can't handle errors); the review inbox
     (`GET /captures?status=pending` + `confirm`/`discard`) is the exception path.
- **`transactions`** gains nullable provenance columns `source_id`, `capture_id`,
  `transfer_group_id` — server-set only, stripped from public create/update bodies. Ledger
  semantics (ADR-004) unchanged.
- **Transfers** (slice 2) — moving money between contexts is one atomic operation creating two
  linked transactions (`expense` in *from*, `income` in *to*) sharing a `transfer_group_id`;
  RBAC write check on both ends; legs are not individually editable/deletable.
- **Automation token** — long-lived ingest-scoped credential for phone automations that cannot
  refresh a JWT: `POST /auth/tokens` mints a session row (`scope='ingest'`, ~1 year) and a JWT
  carrying `scope`; the auth middleware exposes `req.tokenScope` and an app-level guard rejects
  anything but `POST /captures` with 403. Revocable via `DELETE /auth/tokens/:id` (normal
  session revocation). A leaked phone secret exposes only the ability to add pending evidence.

## Consequences

- **Positive:** all resolution logic is shared by every capture path (Shortcuts, MacroDroid,
  future native listener, future aggregator feed — each is just another `channel`); dedup and
  routing are testable server-side; the ledger stays pure (captures reference transactions, not
  the reverse semantics).
- **Negative / accepted:** `captures` ↔ `transactions` reference each other (insert order:
  capture → transaction → back-link), which forces the test wipe to suspend FKs; the ±5 min
  dedup window is a heuristic (a genuine identical double-purchase within 5 min on the same
  source folds into one — visible in the inbox as `duplicate`, recoverable by confirm).
- **North star, ship lean:** canonical-preference on cross-channel dedup (bank row wins over
  wallet) is simplified to "first survives, later folds"; retro "link as transfer" detection and
  the aggregator channel are deliberately deferred.
