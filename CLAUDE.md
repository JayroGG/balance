# CLAUDE.md — `balance`

Project-specific context for Claude Code. Read this together with the global `~/.claude/CLAUDE.md` and `PRD.md`.

## What this is

A **single-user REST API** for personal financial records: incomings, expenses, savings vaults, and balance business logic. Full CRUD with soft deletion. POC stage. See `PRD.md` for requirements/decisions and `ARCHITECTURE.md` for diagrams and the file map.

## Tech stack

- **Runtime:** Node.js (CommonJS).
- **Framework:** Express.
- **Database:** SQLite via `better-sqlite3` (synchronous, single-file).
- **Config:** `dotenv` with per-environment files (`stage`, `prod`, `test`).
- **Tests:** Jest + supertest against the exported Express app (ADR-007) — `test/` with `unit-testing/` and `integration-test/`, serial runs over a throwaway SQLite file (`.env.test`, reset each run), real logins via `/auth/login`.
- **No** TypeScript, ORM, or linter at POC stage — kept deliberately lean.

## Key commands

> Commands honor `NODE_ENV` (`stage` default, or `prod`). Each environment uses its own DB file.

```bash
NODE_ENV=stage npm run migrate   # apply schema.sql
NODE_ENV=stage npm run seed      # seed user_id=1 + default categories (+ demo@example.com / demo1234 when SEED_DEMO_USER=true; never prod/Fly)
NODE_ENV=stage npm start         # boot the API
NODE_ENV=prod  npm start         # boot against the prod DB/config
npm test                         # Jest suite (sets NODE_ENV=test itself)
```

## Architecture

- **Entity pattern:** each resource lives in `src/entities/<name>/` as a generated **model** (`db/model.js` via `modelGenerator`) + **routes** (`http/routes.js` via `restGenerator`), with validation/invariants in **hooks** (`http/hooks.js`). Generic CRUD generators live in `src/utils/`. Custom routes register before `restGenerator`. Import models cross-entity directly (never via the entity `index.js`) to avoid circular deps.
- **Money:** stored as integer **cents**; API speaks **decimals**. The model layer converts decimal↔cents via `moneyFields` (`src/lib/money.js`).
- **Auth-ready:** `middleware/auth.js` injects `req.userId = 1` for now. Every table has `user_id`; swap this middleware for real auth in Phase 2 without touching queries.
- **Soft deletion:** every table has a nullable `deleted_at`. All reads filter `deleted_at IS NULL`; deletes set the timestamp. Soft-deleted resources return `404`.
- **Teams & context:** every financial table carries a nullable `team_id`. A request runs in one context, set by `?team_id=` and resolved by `middleware/resolveContext.js` into `req.context = { userId, teamId, role }` (omitted = personal, `role: null`). `team_members` records membership + role.
- **RBAC (ADR-005):** team roles `owner | member | guest` on `team_members`. Two gates centralized in `src/lib/access.js` (`assertCanWrite`/`assertOwns`/`assertCanMutate`), called from the `restGenerator` write handlers and the vault allocate/withdraw routes: guests are read-only; members write only rows they created; owners bypass ownership. Reads are open to all roles. Team management (rename/delete/add/remove/change-role) is owner-only **by role** (not `teams.user_id`); a team deletes only when empty. Role writes funnel through `teams/db/members.js`.
- **Global admin (ADR-006):** `users.role` (`user|admin`), carried in the JWT → `req.isAdmin`/`req.context.isAdmin` (set in `auth.js`). An admin overrides team RBAC, membership, and ownership (bypass in `access.js`, `resolveContext`, `modelGenerator`, teams `requireRole`); can target any team (`?team_id=`) and any user's personal data (admin-only `?user_id=`). Integrity invariants still apply. Create admins via `npm run create-user -- <email> <pass> admin`.

- **Shopping lists (ADR-008):** pre-expense checklists that stay **out of the ledger** until checkout. `shopping_lists` is context-scoped like transactions; `shopping_list_items` is scoped by its **parent list** (hand-written model, not `modelGenerator`) so a shared list shows every member's items — item hooks resolve the list via `req.context` and `404` if it isn't visible. `POST /shopping-lists/:id/checkout { amount }` books **one expense** into the list's own context, links it, and freezes the list (`status: 'purchased'` — no further edits, no re-checkout). It **reuses** the transactions `BEFORE_CREATE` hook (type + category-scope validation; no balance guard, ADR-012) before any write, then commits the expense + freeze in one `db.transaction`. Item `price` is a per-unit estimate; the checkout `amount` is authoritative. Deleting a list cascades to items and leaves the transaction intact.

- **Loans (ADR-010):** receivables mirroring the vault model — no money columns; `pending = Σlend − Σrepay` and `amount = Σlend` derive from the append-only `loan_history` ledger. `POST /loans/:id/lend { amount }` (≤ available) and `/repay` (≤ pending) each **also book a journal transaction** (`expense`/`income` with `transactions.loan_id` set) in the loan's own context — journal rows are **excluded from balance math** and **read-only** via `/transactions` (`400` on PUT/DELETE; `loan_id` never whitelisted). `available = total − locked − lent`; `total` sums only `loan_id IS NULL` rows. Creation: `{ name }` plain; `{ name, amount }` = create + lend atomic; `+ pre_existing: true` also posts a counted opening income (`total +A`, `available ±0`) — one `db.transaction` each. Loan deletes only at `pending = 0` (journal rows survive). Events: `loan created/updated/deleted/lent/repaid`; journal rows log no transaction event. North star: write-off endpoint + `direction` (borrowed) column.

- **Activity events (ADR-009):** every successful mutation appends to the immutable `events` ledger (append-only like `vault_history`; hand-written model). Actor = `req.userId`; `team_id` = the **affected record's** context (items use the parent list's). Emitted from the after-hooks (`CREATE`/`UPDATE`/`DESTROY`) for generated CRUD, and from controllers for allocate/withdraw, checkout (inside its atomic commit), and team management. `summary` is a JSON display snapshot with **decimal** amounts. `GET /events` (read-only, `context: true`) returns the newest-first feed — `entity`/`action`/`since_id`/`limit` (default 50, max 200) params, `actor_email` joined; personal feed = own actions, team feed = all members'; reads open to every role. Unlogged by design: categories, renames, team create/delete. North star: Expo remote push over this same ledger.

- **Multi-category (ADR-013):** categories are **tags** on a transaction via `transaction_categories(transaction_id, category_id)` (the old `transactions.category_id` column is migrated then dropped by `npm run migrate`). Writes take `category_ids: int[]` (deduped; `[]` clears; omitted leaves untouched; every id must be a live category of the **transaction's own context** — team rows team categories, personal rows the owner's — else `400`; the legacy `category_id` key is rejected `400`). Reads carry `categories: [{ id, name }]` on list/search/get. The full amount counts under each tag, so per-category totals can exceed the total; unfiltered totals count each row once. Checkout books `category_ids` (or `category_id`, else the list default) as the tag set.
- **Credit cards (ADR-014):** `cards(name, cut_day, due_day, credit_limit?)`, context-scoped/RBAC'd like loans. A **charge** = `expense` + `transactions.card_id`: a spend (expense totals, category filters) but **excluded from `total`/`available`** — cash hasn't moved. `POST /cards/:id/pay { amount, occurred_at? }` (`≤ owed`, may push available negative) books a `card_payment` row: reduces cash, **not** a spend (own `card_payments` total), read-only via `/transactions` (PUT `400`; DELETE ok, restores the debt). Never stored: `owed = Σcharges − Σpayments`; `last_cut` = latest clamped cut ≤ today, `due_date` = first clamped due day after it (not rolled while unpaid), `statement_balance = max(0, Σcharges ≤ last_cut − Σpayments)`, `current_period = Σcharges > last_cut` (`src/lib/cardCycle.js`, `cards/db/figures.js`). Card reads carry those figures; `/balance` adds `cards_owed` + `cards[]`. Writes may not leave `owed < 0` (shrink/move/delete a charge below its payments → `400`); card delete only at `owed = 0`; `card_id` must be a live card of the transaction's own context. `npm run migrate` rebuilds `transactions` (CHECK + `card_id`). Events: `card created/updated/deleted/paid`.
- **Refresh tokens (ADR-015):** login returns `{ token, refreshToken }`: a short access JWT (`JWT_EXPIRES_IN`, default `1h`) + an opaque 32-byte refresh token (`REFRESH_EXPIRES_IN`, default `60d`, sliding). Only the SHA-256 is stored on the `sessions` row (`refresh_hash`, `refresh_expires_at`, `refresh_prev_hash`); `sessions.expires_at` follows the refresh expiry, the JWT keeps its own short `exp`. Public `POST /auth/refresh { refreshToken }` rotates (same `jti`, new pair, old token dead); replaying the previous token revokes the session; revoked/expired/inactive/unverified → `401`. Logout kills both tokens.
- **Vault order (ADR-016):** `vault_order(user_id, vault_id, position)` — each user's own order over (possibly shared) vaults. `PUT /vaults/order { ids }` → `204` (ids must be live vaults visible in the context, else `404`; any role may call it). `GET /vaults` and `/balance` `vaults` sort by the caller's position, then unordered by `created_at` (`vaults/db/order.js`).
- **Transfers (ADR-017):** first inter-context write. `transfers(id, user_id, from_team_id, to_team_id, amount, description, occurred_at, reversal_of UNIQUE)` is **append-only** (never updated/deleted; NULL team = the actor's personal). Each transfer books one `transactions` row per context — types `transfer_out`/`transfer_in`, linked by `transfer_id`, read-only via `/transactions` (`400`), not income/expense, no categories — plus `vault_history` withdraws carrying `transfer_id`. Caller must be a **real owner** (`team_members.role='owner'`) of both sides via `assertRealOwner` in `access.js`: **no admin bypass**, admin `?user_id=` rejected. Never negative: if `available < amount` the caller supplies `vaults: [{vault_id, amount}]` summing to exactly the gap (none allowed otherwise). Undo = `POST /transfers/:id/reverse` (new row with `reversal_of`, opposite direction, vault parts re-allocated; once only, reversals not reversible; `400` if destination `available < amount`). Endpoints: `POST /transfers`, `POST /transfers/:id/reverse`, `GET /transfers`, `GET /transfers/:id`. Rows expose `transfer_id` + `counterpart_label`. Events: `transfer_sent`/`transfer_received`/`transfer_reversed`. Card charges stay open to any team member.
- **Step-up auth (ADR-018):** `POST /auth/step-up { password }` → `{ permit, expires_at }` (hashed, 5 min, single-use, user-bound). `POST /transfers` and `/transfers/:id/reverse` require `X-Step-Up: <permit>`; missing/expired/used/foreign → `403 { code: 'STEP_UP_REQUIRED' }`; wrong password → `401`. Consumed in the action's `db.transaction`.
- **Transactions search (ADR-011):** `GET /transactions` is a custom route (before `restGenerator`) returning `{ items, next_cursor, totals }`. Params: `q` (description/any tag name, literal LIKE), `from`/`to` (inclusive `YYYY-MM-DD`), `type`, `category_id` (matches any tag, `EXISTS`), `loans=only|exclude`, `sort=asc|desc`, `limit` (30/100), `cursor` (opaque keyset on `(occurred_at, id)`); bad input → `400`. `totals` cover the whole filtered set and exclude journal rows (`count` includes them). Param parsing/cursor codec lives in `src/lib/pagination.js`, shared with `/events`; scope reuses `modelGenerator`'s `scopeClause(scope, alias)`.

### Vault / balance model (the core logic)

Vaults are logical allocations within one balance, not separate accounts. Transactions are a **pure ledger**; allocation is a **separate, amount-based** operation. Balances are **derived live** from two ledgers — never stored (see ADR-004). Cent-level helpers live in `entities/balance/db/queries.js`.

- `total` (net worth) = `SUM(income) − SUM(expense) − SUM(card_payment)` — from `transactions` where `loan_id IS NULL` and card charges are skipped (ADR-014); unaffected by vaults and loans.
- `vault[V] balance` = `SUM(allocate) − SUM(withdraw)` for V — from `vault_history`.
- `loan[L] pending` = `SUM(lend) − SUM(repay)` for L — from `loan_history`.
- `available` (spendable) = `total − SUM(all vault balances) − SUM(all loan pending)`.

Allocate (`POST /vaults/:id/allocate { amount }`) moves spendable money into a vault (≤ available); withdraw (`{ amount }`) returns it (≤ vault balance). Each **appends** a row to the append-only `vault_history` ledger (its source of truth). **`available` is signed (ADR-012):** transaction writes and shopping-list checkout may push it below 0 (no guard, no special status); only **allocate** and **lend** are capped by it (`amount ≤ available`, so nothing can be locked or lent while `available ≤ 0`), and vault/loan balances stay non-negative. A vault deletes only at balance 0.

## Key files

| Path | Purpose |
|---|---|
| `src/config/env.js` | Loads/validates `.env.<NODE_ENV>`; exports config. |
| `src/config/db.js` | `better-sqlite3` connection (path from config). |
| `src/db/schema.sql` | Full DDL (all tables, indexes, constraints). |
| `src/db/migrate.js` / `seed.js` | Apply schema / seed user + categories. |
| `src/middleware/` | `auth.js`, `errorHandler.js`. |
| `src/lib/pagination.js` | Shared limit/positive-int parsing and keyset cursor codec (events, transactions). |
| `src/lib/money.js` | Decimal ↔ cents conversion. |
| `src/constants/hooks.js` | Lifecycle hook type constants. |
| `src/utils/{modelGenerator,restGenerator}/` | Generic CRUD model + routes/handlers. |
| `src/entities/{transactions,vaults,categories,balance}/` | Feature entities (constants, `db/`, `http/`). |
| `src/entities/loans/` | Receivables: lend/repay controller + `loan_history` ledger (ADR-010). |
| `src/entities/cards/` | Credit cards: pay controller, derived statement figures (ADR-014). |
| `src/lib/cardCycle.js` | Cut/due date math with month-end clamping. |
| `src/entities/{shopping-lists,shopping-list-items}/` | Checklists + checkout controller (books one expense). |
| `src/entities/events/` | Append-only activity ledger (hand-written model) + read-only `/events` feed. |
| `src/app.js` / `src/server.js` | Express wiring / boot sequence. |

## Workflow

Follow the global loop for non-trivial work:

1. `/prime` — load context (this file + `PRD.md`, git log, structure).
2. `/plan-feature <task>` — research first; plan saved to `.claude/agents/plans/`.
3. `/execute <plan-path>` — implement step by step, validate after each task.
4. `/commit` — atomic commit, conventional tag (`feat:`, `fix:`, `refactor:`, …).

Per-project long-term memory lives in `~/.claude/projects/<path>/memory/`.

## Conventions

- Minimal changes — only what's asked; no unrequested refactors or comments.
- Validate at boundaries only (request bodies); trust internal guarantees.
- Positive amounts only; `type` carries the sign. Reject any write that would push `available` below 0 with `400`.
