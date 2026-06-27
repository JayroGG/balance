# Mobile change notice — vault allocation model corrected (action required)

> **For the `balance-mobile` (React Native + Expo) agent.** A breaking backend model change.
> Apply it to `docs/react-native-expo-PRD.md` (the mobile PRD) and the affected screens/slices.
> Source of truth: backend **ADR-004** (`.claude/ADR/ADR-004-vault-allocation-model.md`). Dated 2026-06-27.

## TL;DR

Vaults are **no longer funded by tagging a transaction**. Transactions are now a **pure ledger**
(money in / money out — nothing else). Allocating and withdrawing are their own **amount-based**
operations. And **you can no longer spend money that's locked in a vault** — the backend rejects it.

## What changed (and why it matters for the UI)

1. **Transactions lost `vault_id`.** A transaction is `{ id, user_id, type, amount, category_id,
   description, occurred_at, created_at, updated_at, deleted_at }` — **no `vault_id`**.
   → Remove the **vault picker** from the create/edit transaction form. Remove `vault_id` from the
     transactions filter chips, the record shape, and the detail screen.

2. **Allocate / withdraw now take an `amount`, not a `transaction_id`.**
   | Method | Path | Old body | **New body** |
   |---|---|---|---|
   | POST | `/vaults/:id/allocate` | `{ transaction_id }` | **`{ amount }`** (decimal) |
   | POST | `/vaults/:id/withdraw` | `{ transaction_id }` | **`{ amount }`** (decimal) |
   → Replace the "pick an eligible income transaction" UX with a **plain amount input**.
     Allocate moves spendable → vault; withdraw moves vault → spendable.

3. **Vault history rows lost `transaction_id`.** A row is now
   `{ id, user_id, vault_id, action, amount, created_at }` (`action` ∈ `allocate | withdraw`,
   newest first).
   → Render history as amount movements; drop any link to a transaction.

4. **New `400` — you can't overspend your spendable money.** Vaulted money is protected:
   `available` can never go negative. The backend now returns `400` (with `{ error }`) when a write
   would push `available` below zero:
   - creating an **expense** larger than `available`,
   - editing an expense **up**, or an income **down**, past what's spendable,
   - **deleting an income** whose money is currently locked in a vault,
   - **allocating** more than `available`; **withdrawing** more than the vault holds.
   → Surface `error` as the user-facing message (you already do this via the central handler).
     Optional nicety: pre-validate client-side against `available` / vault balance to fail fast, but
     the backend is the authority.

5. **Vault delete now conditional.** A vault can only be deleted when its balance is `0`
   (withdraw to zero first), else `400`.

## What did NOT change

- **`GET /balance` response shape is identical:** `{ total, available, vaults:[{id,name,balance,target}], currency }`.
  Semantics are tighter now — `available` is guaranteed `≥ 0`, and vault balances come from
  allocate/withdraw movements. The dashboard stays the same; balances/targets per vault still come
  from `/balance`, not `GET /vaults`.
- Money is still **decimals** in/out; amounts still positive; `type` carries the sign.
- Soft-delete semantics (`404` = gone), categories endpoints, and the auth seam are unchanged.

## Allocate/withdraw response

`POST /vaults/:id/allocate|withdraw` returns `200` with the updated vault including its derived
balance: `{ id, name, balance, target }` (`target` may be `null`). After either call, **refetch
`GET /balance`** so the dashboard's `total` / `available` / vault cards stay consistent.

## Edits to make in `docs/react-native-expo-PRD.md`

- **§3 Non-Goals:** delete "No partial vault withdrawals…" — partial/amount-based moves are now the
  baseline. Also drop the parenthetical "(backend withdraws a whole transaction at a time)".
- **§2 Goals:** reword "Allocate / withdraw an income transaction to/from a vault" →
  "Allocate / withdraw an **amount** to/from a vault."
- **§4.1 Transactions:** remove `vault_id` from the POST/PUT bodies, the `?vault_id=` filter, and
  the record shape; delete the "expense can never carry a `vault_id`" invariant; add the new
  `available ≥ 0` invariant (expense/income writes can `400`).
- **§4.1 Vaults:** change allocate/withdraw bodies to `{ amount }`; update the history row shape to
  drop `transaction_id`; rewrite the allocate/withdraw rules paragraph (amount-bounded by
  `available` / vault balance; no transaction eligibility logic); note vault delete requires a zero
  balance.
- **§8 Screens:** Transactions form — remove the income-only vault picker. Vaults detail —
  allocate/withdraw become amount inputs (not transaction pickers).
- **§6.1 / state:** `transactions` slice loses the `vault_id` field/filter; `vaults` slice's
  allocate/withdraw thunks take `(vaultId, amount)` instead of `(vaultId, transactionId)`.

## Suggested mobile-side ADR

Record this on the mobile repo as its own ADR (mirroring backend ADR-004) so the client's decision
log explains why the transaction form lost its vault picker and why allocate/withdraw are amounts —
e.g. `ADR-003 — Amount-based vault allocation (follows backend ADR-004)`.
