# ADR-008 — Shopping lists: a pre-expense checklist that books one expense at checkout

- **Status:** Accepted
- **Date:** 2026-07-09
- **Deciders:** Jayro
- **Supersedes / Related:** builds on ADR-004 (derived balances, `available ≥ 0`), ADR-005 (team RBAC), ADR-006 (global admin).

## Context

Spending starts before the ledger sees it: you plan a grocery run, tick items off in the aisle,
then one charge lands. Modelling that plan as transactions would corrupt the ledger — a planned
item is not money that moved, and `available` must not react to intentions. But keeping the plan
outside the system entirely loses the link between "what we agreed to buy" and "what it cost",
which is exactly the thing a shared household team wants to look back on.

So the checklist needs to live next to the ledger without being part of it, and there needs to be
one explicit moment — checkout — where a plan becomes a real expense.

Two structural questions fell out of that:

1. **How are items scoped?** Every financial table here is scoped by `user_id` (+ `team_id`), and
   `modelGenerator` enforces that automatically. Applied naively to items, a teammate adding
   "milk" to a shared list would produce a row nobody else can see — the list would silently
   disagree with itself per viewer.
2. **How does checkout respect `available ≥ 0`?** The invariant is enforced in the transactions
   `BEFORE_CREATE` hook. A checkout that books an expense must not be able to sneak past it.

## Decision

**Two entities.** `shopping_lists` is context-scoped exactly like transactions (`team_id`, driven
by `?team_id=`). `shopping_list_items` is **scoped by its parent list**, not by user or team: it
carries `list_id`, is listed only via a required `?list_id=`, and inherits `user_id` from the list
at insert. Authorization is delegated — every item hook resolves the parent list through
`req.context` first, and an unreachable list throws `404` before any row is read or written. One
shared list, one shared set of items; cross-team access is impossible because the list lookup is
the gate.

**Checkout is the only writer of `status` and `transaction_id`.** Both columns are deliberately
absent from the entity's `create`/`update` field lists, so no request body can set them.
`POST /shopping-lists/:id/checkout { amount, category_id?, occurred_at? }` books **one expense**
for the whole list (client sends the real total; item `price` is a per-unit *estimate*, never the
source of truth), links it, and flips the list to `purchased`.

- The expense is booked into the **list's own context**, not the caller's active one, so a shared
  list always posts against its own ledger even if the caller switched teams mid-session.
- The invariant is **reused, not reimplemented**: the controller calls the transactions
  `BEFORE_CREATE` hook directly, with a synthetic `req.context`, *before any write*. A checkout
  that would push `available` below zero throws `400` and books nothing.
- The expense insert and the list freeze run inside one `better-sqlite3` transaction — both land
  or neither does.

**A purchased list is frozen history.** No rename, no category change, no item add/edit/delete,
no second checkout. Soft-deleting a list cascades a soft delete to its items, and deliberately
**leaves the linked transaction alone** — the money really was spent; deleting the plan must not
rewrite the ledger.

**RBAC is inherited, not redefined.** List and item writes both call the existing
`assertCanMutate` from `src/lib/access.js`: guests read-only, members mutate only lists they
created, owners and global admins bypass ownership.

## Consequences

- **Positive:** the ledger stays pure — a plan costs nothing until checkout. The invariant has
  exactly one implementation, so it cannot drift between `POST /transactions` and checkout.
  Items on a shared list behave the way a shared list should, and the `404`-through-the-parent
  rule makes cross-team leakage a structural impossibility rather than a check someone has to
  remember to write.
- **Negative / trade-offs:** `shopping_list_items` does **not** use `modelGenerator` — it needs
  list-keyed SQL rather than user-scoped SQL, so its model is hand-written (~70 lines) and
  duplicates the soft-delete/money-conversion idioms. That is the accepted cost of the scoping
  decision; the alternative was a `teamScoped`-style flag deep in the generator for one caller.
  `GET /shopping-list-items` without `?list_id=` is an error, not an unfiltered list — mildly
  unusual for a REST collection.
- **Amount is client-supplied.** The API does not sum item prices at checkout, so a typo books a
  wrong expense. This is intentional: the receipt total is authoritative and item estimates
  routinely disagree with it. The client is expected to pre-fill from the estimate and let the
  user correct.
- **Follow-ups:** a `GET /shopping-lists/:id` that embeds its items would save the mobile client a
  round-trip; per-item `checked_by` for shared lists; unfreezing (reopen a purchased list by
  voiding its transaction) if the need appears.

## Alternatives considered

- **Items as draft transactions** (`status: 'planned'` on `transactions`) — one table, "free"
  RBAC. Rejected: every balance query, every invariant, and every hook would have to learn to
  exclude planned rows, and one missed filter silently corrupts net worth. Contaminating the
  ledger to save a table is a bad trade.
- **One expense transaction per checked item** — richer history, per-item categories. Rejected
  for the POC: a 30-item grocery run becomes 30 ledger rows for one card charge, which is not how
  the money moved and makes reconciliation against a bank statement (Phase 4) harder. The single
  linked expense keeps the ledger a faithful record of *charges*.
- **User/team-scoped items via `modelGenerator`** — free consistency with every other entity.
  Rejected: it breaks the shared-list premise (§Context, question 1). Scoping by parent is the
  correct model for a child collection whose visibility is the parent's.
- **Re-deriving the `available ≥ 0` check inside the checkout controller** — avoids the slightly
  unusual "call another entity's hook" move. Rejected: two implementations of a hard money
  invariant is exactly the drift ADR-004 exists to prevent.
