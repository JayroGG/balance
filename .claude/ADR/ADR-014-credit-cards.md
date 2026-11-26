# ADR-014 — Credit cards: charges, statements and payments

- **Status:** Accepted (BE `balance`)
- **Date:** 2026-11-26

## Context
Card spends were booked as cash expenses (or forgotten), so `available` drifted from reality, payments
were missed and some spends were registered twice. The owner wants card spends tracked separately and
paid from the balance, matching how a real card works.

## Decision
- `cards` table (name, cut_day, due_day, optional credit_limit), scoped/RBAC'd like vaults and loans.
- `transactions.card_id` + new type `card_payment`:
  - charge = expense with `card_id`: a spend (expense totals, categories) but **excluded from net worth /
    available** — cash hasn't moved;
  - payment = `card_payment` with `card_id`: reduces net worth/available, **not** a spend.
- `owed = charges − payments`; payment > owed is rejected. Statement: `last_cut` (latest clamped cut ≤
  today), `due_date` (first clamped due day after it), `statement_balance = max(0, charges ≤ last_cut −
  all payments)`, `current_period = charges > last_cut`. Computed on read, never stored.
- `GET /balance` exposes `cards_owed` and a per-card summary; `total`/`available` stay cash-only.

- Rules fixed during implementation:
  - A payment is created only by `POST /cards/:id/pay { amount, occurred_at? }` (`amount <= owed`); it is
    read-only through `/transactions` (no PUT) and can be deleted (which raises `owed` again).
  - No write may leave `owed < 0`: shrinking, moving, retyping or deleting a charge below what was
    already paid is `400`.
  - `due_date` is not rolled forward while a statement is unpaid; a past `due_date` with
    `statement_balance > 0` means overdue until the next cut produces a new one. Dates are UTC.
  - `GET /transactions` totals add `card_payments` (in neither `income` nor `expense`); `expense`
    includes charges, so `net = income - expense` stays spend-based, not cash-based.
  - A card and its transactions share one context (team cards for team rows, personal cards for
    personal rows), else `400`. Deleting a card keeps its charge/payment history.
  - `transactions` is rebuilt by `npm run migrate` (SQLite can't alter a CHECK): copy, drop, rename
    with foreign keys off, then `foreign_key_check`; idempotent.

## Consequences
- Every balance/totals query must apply the charge/payment rules (same discipline as loan journal rows).
- No interest, fees, refunds or installments (MSI) yet — a refund is entered as a smaller charge edit or
  deferred to a future ADR.
- Deleting a card with debt is refused.

## Alternatives considered
- Separate `card_history` ledger (loan style): rejected — charges need categories, search and the
  transactions list, which transactions already provide.
