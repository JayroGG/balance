# Plan — Vault allocation correction (ADR-004)

> Implements **ADR-004**: decouple vaults from transactions, make allocate/withdraw amount-based
> over an append-only `vault_history` ledger, and enforce `available ≥ 0` on every spendable-
> affecting write. Balances stay **derived** (no stored balance).

## Outcome

- `transactions` is a pure ledger — no `vault_id`.
- `vault_history` is the source of truth for vault balances — `allocate`/`withdraw` of arbitrary
  amounts, no `transaction_id`.
- `POST /vaults/:id/allocate|withdraw` take `{ amount }`.
- `available` can never go negative; vaulted money is protected.

## Model (cents)

```
net_worth = Σincome − Σexpense                       (transactions, deleted_at IS NULL)
vault[V]  = Σallocate − Σwithdraw for V              (vault_history)
locked    = Σ vault[V] over active vaults
available = net_worth − locked   (invariant: ≥ 0)
```

Guarded writes (reject `400` if result would breach `available ≥ 0`): create expense, increase
expense, decrease income, delete income, allocate. Bounded: withdraw ≤ `vault[V]`. Vault delete only
when `vault[V] = 0`.

## Tasks

1. **Schema** (`src/db/schema.sql`)
   - Drop `transactions.vault_id` + `idx_transactions_vault`.
   - Drop `vault_history.transaction_id`.
   - Recreate the dev DB (gitignored): delete `data/balance.stage.db`, re-migrate, re-seed.

2. **Balance queries** (`src/entities/balance/db/queries.js`)
   - Add cent helpers: `netWorthCents`, `vaultBalanceCents(vaultId)`, `lockedCents`,
     `availableCents`.
   - Rewrite `get` to derive vault balances from `vault_history` (not the transactions join).
   - Export the helpers (consumed by transactions hooks + vaults controller).

3. **Transactions ledger**
   - `db/fields.js` — remove `vault_id` from `create`, `update`, `filterFields`.
   - `db/model.js` — drop `findByIdRaw` + `setVaultId` (now unused); plain `modelGenerator`.
   - `http/hooks.js` — drop the vault invariant; add the shared `assertSpendable` guard on
     `BEFORE_CREATE`, `BEFORE_UPDATE`, `BEFORE_DESTROY` (compute net-worth delta of the write;
     reject if `available + delta < 0`).

4. **Vaults**
   - `db/history.js` — `add(userId, vaultId, action, amountCents)` (drop `transactionId`).
   - `http/controller.js` — `allocate`/`withdraw` read `{ amount }`; allocate bounded by
     `availableCents`, withdraw bounded by `vaultBalanceCents`; append a movement; return the vault
     with its derived `balance`.
   - `http/hooks.js` — add `BEFORE_DESTROY`: block delete when `vaultBalanceCents ≠ 0`.

5. **Docs** — update `PRD.md` (§3, §5, §6, §7), `ARCHITECTURE.md` (ER, balance flow, lifecycle,
   conventions), `CLAUDE.md` (vault/balance model + conventions). Update the project-context memory.

6. **Validate** — recreate stage DB; boot the API; run the scenario below; confirm figures + the
   `400` guards; tear down.

## Validation scenario

| Step | Expect |
|---|---|
| `POST /transactions` income 2000 | 201 |
| `GET /balance` | total 2000, available 2000 |
| `POST /vaults` "Emergency" | 201 |
| `POST /vaults/1/allocate {amount:500}` | 200, vault balance 500 |
| `GET /balance` | total 2000, available 1500, vault 500 |
| `POST /vaults/1/allocate {amount:2000}` | 400 (exceeds available) |
| `POST /transactions` expense 1600 | 400 (exceeds available 1500) |
| `POST /transactions` expense 1500 | 201 |
| `GET /balance` | total 500, available 0, vault 500 |
| `POST /vaults/1/withdraw {amount:600}` | 400 (exceeds vault 500) |
| `DELETE /vaults/1` | 400 (non-zero balance) |
| `POST /vaults/1/withdraw {amount:500}` | 200; balance available 500 |
| `DELETE /vaults/1` | 204 |

## Notes / non-goals

- No migration framework — `schema.sql` is the DDL; recreate the dev DB to apply (POC).
- `vault_history` is append-only; "withdraw" is the reverse entry, never a row mutation.
- Mobile contract change handed off in `docs/react-native-vault-model-update.md`.
