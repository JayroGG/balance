# Feature: Loans (lent-out money) with balance discount

The following plan should be complete, but validate documentation and codebase patterns and task
sanity before you start implementing. Pay special attention to naming of existing utils, models,
and hook constants. Import from the right files (cross-entity = direct `db/model.js` imports).

Source contract: `/Users/jayro/Dev/ReactNative/Projects/balance-manager/docs/backend-loans-request.md`
(the mobile side's actionable request). Decision record: `.claude/ADR/ADR-010-loans-lent-money.md`.

## Feature Description

A **loan is a receivable** — money the user lent to someone (`name` = usually the person). It
mirrors the vault model (ADR-004): no money columns on the record; `pending` (still owed) and
`amount` (total lent) are **derived from an append-only `loan_history` ledger** (`lend`/`repay`
movements). **Lend** moves spendable → pending (bounded by `available`); **repay** moves pending →
spendable (bounded by `pending`). Neither changes `total` — cash converts to a claim and back.

Every lend/repay *also* books a **journal transaction** (`expense` for lend, `income` for repay)
carrying a new nullable `transactions.loan_id`. Journal rows are display-only history: **excluded
from all balance math** and **read-only** through `/transactions` (their truth lives in
`loan_history`).

**Pre-existing loans** (lent before the app existed): `POST /loans { name, amount,
pre_existing: true }` atomically posts a **counted** plain income (`loan_id = NULL`, description
`"Loan opening: <name>"`) *plus* the initial lend movement + its journal row. Net: `total +amount`,
`available ±0`.

## The equilibrium (must hold; tests assert it)

Let `base = Σ income − Σ expense` over transactions **where `loan_id IS NULL`**.
Per loan: `pending = Σ lend − Σ repay`, `amount = Σ lend`.

- `total = base` (same formula, just skips journal rows)
- `available = total − Σ vault balances − Σ loan pending` ← **the only formula change**
- `lent = Σ pending` over active loans
- The existing **`available ≥ 0`** invariant needs no new machinery — it simply evaluates against
  the new `available` everywhere it already fires (expense create/edit, income delete/edit-down,
  vault allocate, list checkout). E.g. deleting an opening income while the money is still lent is
  rejected `400`, exactly like deleting income locked in a vault.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium
**Primary Systems Affected**: schema + migrate, balance queries (the core formula), transactions
hooks/model, new `loans` entity, app wiring, events catalog, test harness
**Dependencies**: none new

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ THESE BEFORE IMPLEMENTING

- `src/db/schema.sql` — `vaults` (lines 60-71) + `vault_history` (90-100): the exact table shapes
  to mirror; `transactions` (73-88) gains `loan_id`
- `src/db/migrate.js` — the `PRAGMA table_info` ALTER guard pattern (teams.color) to copy for
  `transactions.loan_id`; `CREATE TABLE IF NOT EXISTS` re-run covers the two new tables
- `src/entities/balance/db/queries.js` — **the file the formula change lives in**: `where()`,
  `netWorthCents`, `vaultBalanceCents`, `lockedCents`, `availableCents`, `get()` — every new
  helper mirrors an existing one
- `src/entities/vaults/db/history.js` — the append-only ledger db module to mirror (`add`,
  `findByVault` newest-first with decimal amounts)
- `src/entities/vaults/http/controller.js` — `parseAmount`, `requireVault`, `vaultView`, the
  allocate/withdraw bound checks, `assertCanMutate`, `EventModel.log` call shape — the loans
  controller is structurally this file
- `src/entities/vaults/http/hooks.js` — `BEFORE_DESTROY` zero-balance rule to mirror for pending
- `src/entities/vaults/http/routes.js` — custom routes before `restGenerator`
- `src/entities/vaults/db/fields.js` + `db/model.js` — fields shape + `modelGenerator` usage
- `src/entities/transactions/http/hooks.js` — the switch to extend with the journal read-only
  guards; note `assertSpendable` already uses `availableCents` (the formula change propagates
  automatically)
- `src/entities/transactions/db/fields.js` — do **not** add `loan_id` to create/update whitelists
  (that is exactly how it stays server-owned: client-sent `loan_id` is silently ignored, same as
  `shopping_lists.status`)
- `src/entities/transactions/db/model.js` — spread-in custom method precedent for `createJournal`
- `src/entities/shopping-lists/http/controller.js` — the `db.transaction` atomic-commit pattern
  (event logged INSIDE it) and booking into the **record's own context**
  (`{ userId: list.user_id, teamId: list.team_id ?? null, isAdmin: req.context.isAdmin }`)
- `src/utils/restGenerator/handlers/createHandler.js` — `assertCanWrite(req.context)` — the custom
  `POST /loans` route shadows this handler, so the controller must call it itself
- `src/lib/access.js` — `assertCanWrite` / `assertCanMutate`
- `src/lib/money.js` — `toCents` / `toDecimal`
- `src/entities/index.js` + `src/app.js` — registry + `routes[]` (loans mounts with `context: true`)
- `test/helpers/db.js` — `TABLES` wipe list (add `loan_history`, `loans` — children before parents)
- `test/integration-test/shopping-lists/shopping-lists.test.js` — integration test style

### New Files to Create

- `src/entities/loans/constants.js` — `ENTITY_NAME = 'loans'`
- `src/entities/loans/db/fields.js`
- `src/entities/loans/db/model.js` — `LoanModel = modelGenerator(ENTITY_NAME, fields)`
- `src/entities/loans/db/history.js` — `add`, `findByLoan`, `figures`
- `src/entities/loans/http/hooks.js`
- `src/entities/loans/http/controller.js` — `create`, `lend`, `repay`, `getHistory`
- `src/entities/loans/http/routes.js`
- `src/entities/loans/index.js`
- `test/integration-test/loans/loans.test.js`

### GOTCHAS

- **Custom `POST /` shadows the generated create.** Register `router.post('/', ctrl.create)`
  before `restGenerator`; Express takes the first match. The controller must therefore call
  `assertCanWrite(req.context)` itself (guest denial) — the generated `createHandler` never runs
  for loans, and the `CREATE` after-hook never fires (the controller logs its own `created` event).
- **Journal rows must NOT go through `transactionHooks`** — no `BEFORE_CREATE` guard call for
  them. The lend bound check (`≤ available`) *is* the guard; the journal expense itself is
  excluded from balance so it must not be double-checked (and the transactions `CREATE` after-hook
  must not fire — no `transaction/created` event for journal rows; the `loan/lent` event covers it).
- **The opening income of `pre_existing` DOES count** (`loan_id = NULL`) and needs no guard
  either: it *raises* available. Insert it **before** the lend movement inside the atomic commit
  so intermediate state never has `available < 0`.
- **`createJournal` takes cents** (like `history.add`), not decimals — the controller already has
  cents; don't round-trip.
- `loan_history` sums: `pending = Σ(lend) − Σ(repay)`, `amount = Σ(lend)` — for `amount`, the
  `ELSE` branch of the `CASE` is `0`, not `-amount`. Two different CASE expressions.
- `netWorthCents` gains `AND loan_id IS NULL`; **`lockedCents` and the vaults sub-query are
  untouched** (vault_history has no journal rows).
- Loan update is `{ name }` only — the fields whitelist enforces it; no hook check needed.

---

## IMPLEMENTATION TASKS

### Task 1 — Schema + migration

`src/db/schema.sql`: after `vault_history`, add (mirroring vaults/vault_history exactly,
including comment style):

```sql
-- Receivables: money lent out (ADR-010). Context-scoped like vaults. No money
-- columns: amount/pending derive from loan_history, like a vault balance.
CREATE TABLE IF NOT EXISTS loans (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  team_id    INTEGER REFERENCES teams(id),
  name       TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_loans_user ON loans(user_id);
CREATE INDEX IF NOT EXISTS idx_loans_team ON loans(team_id);

-- Append-only ledger of loan movements; source of truth for loan figures.
-- pending = SUM(lend) - SUM(repay); amount lent = SUM(lend).
CREATE TABLE IF NOT EXISTS loan_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  loan_id    INTEGER NOT NULL REFERENCES loans(id),
  action     TEXT    NOT NULL CHECK (action IN ('lend', 'repay')),
  amount     INTEGER NOT NULL CHECK (amount > 0),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_loan_history_loan ON loan_history(loan_id);
```

In the `transactions` CREATE TABLE, add after `category_id`:
`loan_id     INTEGER REFERENCES loans(id),` with a trailing comment `-- journal flag (ADR-010): set by lend/repay, excluded from balance`.
(SQLite resolves the forward reference at DML time; fine.)

`src/db/migrate.js`: after the teams.color guard, same pattern:

```js
if (!db.prepare(`PRAGMA table_info(transactions)`).all().some((c) => c.name === 'loan_id')) {
  db.exec(`ALTER TABLE transactions ADD COLUMN loan_id INTEGER REFERENCES loans(id)`);
}
```

**Validation**: `rm -f data/balance.test.db && NODE_ENV=test npm run migrate` (or just run the
test suite, whose setup migrates); re-run migrate on an existing stage DB is idempotent.

### Task 2 — Balance queries (the formula change)

`src/entities/balance/db/queries.js`:

1. `netWorthCents`: add `AND loan_id IS NULL` to the WHERE.
2. New `loanPendingCents(scope, loanId)` — mirror `vaultBalanceCents`:
   `SUM(CASE WHEN action = 'lend' THEN amount ELSE -amount END)` from `loan_history WHERE loan_id = ?`.
3. New `lentCents(scope)` — mirror `lockedCents` over `loan_history lh JOIN loans l`, active
   loans, context-scoped via `where(scope)` on `l.`.
4. `availableCents = (scope) => netWorthCents(scope) - lockedCents(scope) - lentCents(scope);`
5. `get(scope)`: compute `lent = lentCents(scope)`; add a loans list query mirroring the vaults
   one:

```sql
SELECT l.id, l.name,
       COALESCE(SUM(CASE WHEN lh.action = 'lend' THEN lh.amount ELSE 0 END), 0)          AS amount,
       COALESCE(SUM(CASE WHEN lh.action = 'lend' THEN lh.amount ELSE -lh.amount END), 0) AS pending
FROM loans l
LEFT JOIN loan_history lh ON lh.loan_id = l.id
WHERE l.${sql} AND l.deleted_at IS NULL
GROUP BY l.id ORDER BY l.name
```

   Response shape (order the keys like this):
   `{ total, available: toDecimal(net - locked - lent), lent: toDecimal(lent), vaults, loans: loans.map(l => ({ id, name, amount: toDecimal(l.amount), pending: toDecimal(l.pending) })), currency }`.
6. Export `lentCents` and `loanPendingCents` alongside the existing exports.

**Validation**: existing balance/vault tests still pass (no loans → `lent: 0`, `loans: []`,
available unchanged).

### Task 3 — Transactions: journal guards + journal writer

`src/entities/transactions/http/hooks.js`:
- `BEFORE_UPDATE`: first line — `if (previous.loan_id != null)` throw
  `{ message: 'Loan journal transactions are read-only; use the loan lend/repay endpoints', status: 400 }`.
- `BEFORE_DESTROY`: same check on `record.loan_id`.
- Do NOT touch `BEFORE_CREATE` (loan_id can't arrive: not whitelisted) or the after-hooks.

`src/entities/transactions/db/model.js`: spread in a custom method:

```js
// Journal row for a loan movement (ADR-010): loan_id set, cents in, no hooks.
// Excluded from balance math; read-only via /transactions.
createJournal({ userId, teamId }, { type, amountCents, description, loanId }) { ... }
```
Raw INSERT into transactions `(user_id, team_id, type, amount, description, loan_id)`; return
`lastInsertRowid` (nothing consumes the row).

**Validation**: `npm test` — existing transaction suites green.

### Task 4 — Loans entity

- `constants.js`: `ENTITY_NAME = 'loans'`.
- `db/fields.js`: `{ create: ['name'], update: ['name'], moneyFields: [], filterFields: [], teamScoped: true }`
  (money never moves through CRUD — only lend/repay).
- `db/model.js`: `LoanModel = modelGenerator(ENTITY_NAME, fields)`.
- `db/history.js` — mirror `vaults/db/history.js`: `add(userId, loanId, action, amountCents)`,
  `findByLoan(loanId)` (newest first, decimal amounts), plus
  `figures(loanId)` → `{ amountCents, pendingCents }` (one grouped query, both CASE sums) for the
  response view.
- `http/hooks.js` (mirror vault hooks; import `loanPendingCents` from balance queries,
  `EventModel` from `../../events/db/model`):
  - `BEFORE_DESTROY`: `loanPendingCents(req.context, record.id) !== 0` → 400
    `'Cannot delete a loan with pending money; repay it to zero first'`.
  - `UPDATE` after-hook: log `{ entity: 'loan', action: 'updated', summary: { name: record.name } }`.
  - `DESTROY` after-hook: log `action: 'deleted'`, `summary: { name: record.name }`.
  - No `BEFORE_CREATE`/`CREATE` cases (custom create route; see GOTCHAS).
- `http/controller.js` (structurally the vaults controller + the checkout atomic pattern):
  - `loanView(loan)` → `{ id: loan.id, name: loan.name, amount: toDecimal(figures.amountCents), pending: toDecimal(figures.pendingCents) }`.
  - `parseAmount` — copy from vaults controller verbatim.
  - `requireLoan(scope, id)` → 404 `'Loan not found'`.
  - `loanScope(loan, req)` = `{ userId: loan.user_id, teamId: loan.team_id ?? null, isAdmin: req.context.isAdmin }`
    — journal rows and bound checks run in the **loan's own context** (checkout precedent).
  - **`create`**: `assertCanWrite(req.context)`; `body.name` required → 400. If `body.amount`
    is nullish → `LoanModel.create` + log `created` `{ name }` → `201 loanView`. Else parse cents;
    if not `body.pre_existing`: `cents > availableCents(req.context)` → 400
    `'Insufficient available balance: cannot lend more than is spendable'`. Then one
    `db.transaction`: create loan → if `pre_existing`, `TransactionModel.create(scope, { type: 'income', amount: body.amount, description: 'Loan opening: ' + name })`
    (plain counted income, decimals — the normal model path) → `history.add(req.userId, loan.id, 'lend', cents)`
    → `TransactionModel.createJournal(scope, { type: 'expense', amountCents: cents, description: loan.name, loanId: loan.id })`
    → log `created` `{ name, amount: toDecimal(cents) }`. `201 loanView`.
  - **`lend`**: requireLoan + `assertCanMutate` + parse; `cents > availableCents(loanScope)` → 400
    (same message). Atomic: `history.add(..., 'lend', cents)` + journal `expense` + log `lent`
    `{ name, amount }`. `200 loanView`.
  - **`repay`**: bound `cents > loanPendingCents(loanScope, id)` → 400
    `'Cannot repay more than the loan pending amount'`. Atomic: `history.add(..., 'repay', cents)`
    + journal `income` + log `repaid` `{ name, amount }`. `200 loanView`.
  - **`getHistory`**: requireLoan → `res.json(history.findByLoan(id))`.
- `http/routes.js`: `GET /:id/history`, `POST /:id/lend`, `POST /:id/repay`,
  `POST /` (ctrl.create — shadows the generated create), then
  `restGenerator(LoanModel, router, loanHooks)`.
- `index.js`: `{ Entity: { model: LoanModel, routes } }`.

### Task 5 — Wiring

`src/entities/index.js`: add `LoansEntity`. `src/app.js`: destructure it and add
`{ path: '/loans', route: LoansEntity.routes, context: true }` to `routes[]` (next to vaults).

**Validation**: boot smoke — `NODE_ENV=test node -e "require('./src/app')"`; then `npm test`.

### Task 6 — Integration tests

`test/helpers/db.js`: add `'loan_history', 'loans'` to `TABLES` (before `transactions`? order:
children first — put `loan_history` before `loans`, and both can sit next to `vault_history`).

`test/integration-test/loans/loans.test.js`, style of the shopping-lists suite. Cover:

1. **Creation semantics**: plain `{ name }` → 201, `pending 0`; `{ name, amount }` → available
   −amount, total unchanged; over-available → 400 and **nothing written** (no loan, no history,
   no transactions); `{ name, amount, pre_existing: true }` → total +amount, available unchanged,
   `/transactions` shows the counted opening income (`loan_id: null`) AND the journal expense
   (`loan_id` set).
2. **Equilibrium on `/balance`**: with income 1000, vault-allocate 200, lend 300 →
   `{ total: 1000, available: 500, lent: 300 }`, `loans: [{ amount: 300, pending: 300 }]`.
3. **lend/repay**: repay releases available and drops pending; repay > pending → 400;
   lend > available → 400; missing/zero/negative amount → 400; response shape
   `{ id, name, amount, pending }` (amount stays Σ lend after repay).
4. **Journal read-only**: PUT and DELETE on a journal row → 400; `loan_id` in a POST
   `/transactions` body is ignored (row lands with `loan_id: null`).
5. **Invariant interplay**: deleting the pre-existing opening income while pending > 0 → 400;
   an expense that would overdraw `available` (because money is lent) → 400.
6. **Delete rule**: DELETE loan with pending > 0 → 400; after repaying to zero → 200/204, journal
   rows still readable in `/transactions`.
7. **History**: `GET /loans/:id/history` newest first, `{ action, amount }` decimals; 404 for a
   foreign loan.
8. **RBAC (team context)**: guest lend → 403; member lends on own loan, cannot mutate another
   member's loan (403); owner can; team `?team_id=` scoping on `/loans` and `/balance`.
9. **Events**: `loan created/lent/repaid/deleted` appear in `/events` with `{ name, amount }`
   summaries; no `transaction created` event for journal rows.

**Validation**: full `npm test` green, serially (house jest config already serial).
