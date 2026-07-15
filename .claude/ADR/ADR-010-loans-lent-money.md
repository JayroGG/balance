# ADR-010 — Loans as receivables: a second vault-shaped ledger with journal transactions

- **Status:** Accepted
- **Date:** 2026-07-15
- **Deciders:** Jayro (contract proposed by the `balance-mobile` client, its ADR-018)
- **Supersedes / Related:** extends ADR-004 (derived balances over append-only ledgers), ADR-005/006 (RBAC), ADR-008 (atomic multi-write commits), ADR-009 (events catalog).

## Context

The user lends money to people (10K to a friend — 9K repaid, 1K pending; a separate 23K fully
pending) and wants that wealth to count toward `total` while never appearing in `available`;
repayments should release money back to spendable. Today the mobile app fakes this with income +
vaults and the semantics come out inverted: a vault is *my money set aside*, a loan is *my money
in someone else's hands*. Nothing in the system models a receivable.

Two constraints from the existing design: balances are **derived, never stored** (ADR-004), and
`transactions` is a pure ledger whose sums *are* the balance math — so loan movements must either
stay out of it or be excluded from the math explicitly.

## Decision

**A `loans` entity mirroring the vault model** — no money columns; figures derived from an
append-only `loan_history` ledger (`lend` | `repay`) — **plus journal transactions** for
visibility in the transaction list.

- **Movements.** `POST /loans/:id/lend { amount }` (bounded by `available`) and
  `POST /loans/:id/repay { amount }` (bounded by the loan's `pending`) append to `loan_history`.
  `pending = Σ lend − Σ repay`, `amount = Σ lend`. Neither movement changes `total` — cash
  converts to a claim and back.
- **The formula change** (the only one): `available = total − Σ vault balances − Σ loan pending`.
  `total` keeps its formula but sums only transactions `WHERE loan_id IS NULL`. A new `lent`
  figure (`Σ pending`) and a `loans[]` block join the `/balance` payload.
- **Journal rows.** Every lend/repay also books a transaction (`expense`/`income`, `description`
  = loan name) carrying a new nullable `transactions.loan_id`. These rows are display-only
  history: excluded from balance math, **server-owned** (`loan_id` is not in the field
  whitelists), and **read-only** through `/transactions` (`400` on PUT/DELETE). Unlike a
  shopping-list checkout expense — real money whose truth is the row itself — a journal row has a
  derived source of truth (`loan_history`), so letting it drift would corrupt the display without
  touching the math. The mobile side recommended read-only; we agree.
- **Pre-existing loans** (lent before the app tracked it): `POST /loans { name, amount,
  pre_existing: true }` atomically posts a **counted** plain income (`loan_id = NULL`,
  `"Loan opening: <name>"`) plus the initial lend movement and its journal row — net effect
  `total +amount`, `available ±0`, one `db.transaction` (checkout's atomicity philosophy: one
  owner for ledger invariants).
- **Invariants reused, not reinvented.** The `available ≥ 0` rule gains no new machinery — every
  existing guard (`assertSpendable`, allocate bound, checkout) now evaluates the discounted
  `available`, so e.g. deleting an opening income while its money is still lent is rejected like
  deleting income locked in a vault. A loan deletes only at `pending = 0` (vault rule); its
  journal rows survive deletion (frozen history, like checkout transactions). RBAC is the
  standard matrix (guest read-only; member owns; owner/admin bypass); context scoping is the
  standard `?team_id=`.
- **Events.** `loan` `created` (with `amount` when created with one) / `updated` / `deleted` /
  `lent` / `repaid`, summaries `{ name, amount? }`. Journal rows log **no** `transaction` events —
  the loan event is the story.

## Consequences

- **Positive:** receivables count toward net worth without inflating spendable money; repayment
  is a first-class flow; the transaction list tells the whole story via journal rows; zero new
  invariant machinery — the formula change propagates through `availableCents` to every existing
  guard; the model is a proven copy (vaults) rather than a new species.
- **Negative / trade-offs:**
  - Journal rows make `/transactions` no longer sum to `total` naively — consumers must skip
    `loan_id` rows. Accepted and documented as a shape-change note to clients.
  - A loan whose debtor never repays can never be deleted (pending sticks). Accepted for now —
    see north star.
  - `loan_history` and journal rows are deliberately redundant (one derived truth, one display
    copy). Accepted: the redundancy is write-once and server-owned.
- **North star (deferred, nothing precludes it):**
  - **Write-off** — `POST /loans/:id/write-off` posting a *counted* expense for the remaining
    pending and zeroing it (wealth genuinely lost); unblocks deleting abandoned loans.
  - **Borrowed direction** (money the user owes): a `direction` column extending this same
    entity rather than a new one.

## Alternatives considered

- **Keep faking with income + vaults** — rejected: semantics inverted (vault = set aside, loan =
  out of hand), repayments double-count, and the 23K pre-existing case can't be expressed.
- **Stored `pending` column on `loans`** — rejected by ADR-004's core rule: balances derive from
  ledgers; a stored figure drifts.
- **Loans only in `loan_history`, no journal rows** — cleaner math (no `loan_id` exclusion) but
  the transaction list loses the story and the client would stitch two feeds; the request
  explicitly wants "the ledger tells the whole story".
- **Journal rows counted, no formula change** (lend = plain expense) — makes `total` drop when
  lending, contradicting the requirement that lent wealth stays net worth.
- **Mutable journal rows (checkout precedent)** — rejected: checkouts have no derived source of
  truth; journal rows do (`loan_history`), so edits could only desynchronize the display.
