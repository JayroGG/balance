# ADR-004 — Vaults decoupled from transactions; amount-based allocation over a derived-balance ledger

- **Status:** Accepted
- **Date:** 2026-06-27
- **Deciders:** Jayro Gómez
- **Supersedes / Related:** Corrects the vault/balance model in **PRD §5–§6**, `ARCHITECTURE.md`
  (ER + balance-flow), and `CLAUDE.md` ("Vault / balance model"). Drives a breaking change to the
  mobile contract — see `docs/react-native-vault-model-update.md`.

## Context

Phase 1 shipped a vault model that **conflated two distinct concepts**: the *transaction ledger*
(a record of money coming in and going out) and the *act of allocating money to a vault*.

As built (PRD §6):

- A vault was funded by **tagging an income transaction** with `vault_id`.
- **Allocate** = set an income's `vault_id`; **withdraw** = set it back to `NULL`.
- `vault[V] balance` = `SUM(income WHERE vault_id = V)`.
- `vault_history` existed only as an **audit log**, not as the source of truth.
- Partial-amount withdrawals were explicitly **out of scope** (PRD §6, §3).

This was a **misunderstanding of intent**, identified in review. The consequences of the conflation:

1. **You can only move whole transactions.** Allocating or withdrawing an *arbitrary amount* is
   impossible — the unit of movement is a transaction, not a sum. Real saving doesn't work that
   way ("put 50 aside", not "put transaction #42 aside").
2. **A transaction's `vault_id` was mutable state repurposed as the allocation mechanism.**
   Transactions were meant to be an immutable-ish **historical record** — "income arrived, expense
   happened, that's it" — not a lever you flip to manage money.

The intent was always: **transactions are the ledger; allocation is a separate operation on amounts.**

Constraints unchanged: single-user POC, `better-sqlite3` (synchronous, single file), lean deps, no
test runner. Data volume is one person's personal finances — tiny.

## Decision

Separate the two concepts. **Transactions become a pure ledger; vault movements become their own
amount-based, append-only ledger; all balances are derived live from those two ledgers.**

- **Now (corrected model):**
  - **Transactions are a pure ledger.** Drop `transactions.vault_id` entirely. A transaction
    records only `type`, `amount`, `category_id`, `description`, `occurred_at`. It never references
    a vault.
  - **`vault_history` is the source of truth for vault balances** (append-only). Each row is an
    `allocate` or `withdraw` of an **arbitrary amount** to/from a vault. Drop
    `vault_history.transaction_id` — movements are **not** tied to a transaction. To reverse an
    allocate you append a `withdraw`; rows are never mutated or deleted.
  - **Allocate / withdraw operate on amounts**, not transactions:
    - `POST /vaults/:id/allocate { amount }` — move spendable money into the vault.
    - `POST /vaults/:id/withdraw { amount }` — move money from the vault back to spendable.
  - **Balances are derived in real time** (normalized — *no* stored balance column/table), all in
    integer cents:
    ```
    net_worth  = Σ(income) − Σ(expense)                  -- transactions, deleted_at IS NULL
    vault[V]   = Σ(allocate) − Σ(withdraw)  for V         -- vault_history, vault_id = V
    locked     = Σ vault[V]  over active vaults
    available  = net_worth − locked
    ```
    The ledgers are the single source of truth; balances are always computed from them. If a
    read-side convenience is ever wanted, the only sanctioned form is a **SQLite VIEW** (still
    derived, zero drift) — never a materialized/stored balance.
  - **Hard invariant: `available ≥ 0` at all times** (equivalently `net_worth ≥ locked`). Money in
    a vault is **untouchable** — to spend it you must withdraw it first. Enforced on **every write
    that lowers `net_worth` or raises `locked`**, via one shared hook helper that computes
    "available as if this write were applied" and rejects with `400` if it would go negative:

    | Operation | Effect | Guard |
    |---|---|---|
    | create expense | net_worth ↓ | `amount ≤ available` |
    | increase expense (PUT) | net_worth ↓ | Δ ≤ available |
    | decrease income (PUT) | net_worth ↓ | net_worth must not fall below `locked` |
    | delete income (soft) | net_worth ↓ | same |
    | allocate | locked ↑ | `amount ≤ available` |
    | withdraw | locked ↓ | `amount ≤ vault[V]` (vault can't go negative) |
    | delete vault | — | only if `vault[V] = 0` (withdraw to zero first) |
    | create/increase income, delete/decrease expense | net_worth ↑ | none (always safe) |

- **Boundary / seam:** all of this stays where the entity pattern already puts it — invariants in
  `http/hooks.js`, the SQL in `db/model.js` / `db/queries.js`. The single shared "would this breach
  `available ≥ 0`?" helper is the only new cross-cutting piece.

- **North star (recorded):** amount-based allocation **is now the baseline** — the "no partial
  withdrawals" non-goal (PRD §3, §6) is **retired**. Genuinely deferred future work: correctable
  vault movements (reversal entries rather than raw appends are already the model; a UI to undo a
  specific movement is future), and multi-currency.

## Consequences

- **Positive:** allocate/withdraw any amount — the model now matches how saving actually works.
- **Positive:** clean separation — the transaction ledger and the vault-movement ledger are
  independent; `available` is purely their difference. One identity, no special cases.
- **Positive:** vaulted money is genuinely protected — `available` can never go negative, so you
  can't accidentally spend your savings.
- **Positive:** `vault_history` is now load-bearing (the movement ledger) instead of a decorative
  audit log; it doubles as the per-vault history view for free.
- **Positive:** no denormalization — one source of truth, zero balance-drift bugs.
- **Negative / trade-offs:** **+1 aggregate query** on writes that can reduce spendable money
  (expense create/increase, income decrease/delete, allocate). Negligible on local synchronous
  SQLite at single-user scale; reads (`GET /balance`) are unaffected.
- **Negative / breaking change:** schema migration **drops `transactions.vault_id` and
  `vault_history.transaction_id`**; the API contract changes (allocate/withdraw bodies, transaction
  and vault-history record shapes, a new `400` on spend-beyond-available). The mobile client must
  update — see `docs/react-native-vault-model-update.md`.
- **Follow-ups:**
  1. Write the correction plan in `.claude/agents/plans/` (`/plan-feature`).
  2. Schema migration (drop the two columns); update seed if needed.
  3. Rework `transactions` hooks (the `available ≥ 0` guard), `vaults` controller
     (amount-based allocate/withdraw), `balance` queries (derived from movements).
  4. Update `PRD.md` (§3, §5, §6, §7), `ARCHITECTURE.md` (ER, balance flow, lifecycle), `CLAUDE.md`.
  5. Hand `docs/react-native-vault-model-update.md` to the mobile agent.

## Alternatives considered

- **Keep the `vault_id`-on-transaction model.** Rejected: only whole-transaction moves are
  possible, and it conflates the ledger with the allocation mechanism — the root mistake.
- **Stored / materialized balance** (a `balance` row updated on every write). Rejected: it's a
  cache that must re-sync across ~6 write paths (income/expense create/update/delete, allocate,
  withdraw) and will drift; premature optimization at single-user SQLite scale. The ledger stays
  the source of truth; a VIEW is the only convenience layer if ever needed.
- **Allow `available` to go negative** (record overspend as a signal). Rejected by decision:
  vaulted money must be protected; block any write that would breach `available ≥ 0`.
- **Tie each vault movement to a `transaction_id`** (the income that "funded" it). Rejected:
  re-introduces exactly the coupling we're removing — allocation is about *amounts*, not specific
  transactions.
