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
NODE_ENV=stage npm run seed      # seed user_id=1 + default categories
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

- **Shopping lists (ADR-008):** pre-expense checklists that stay **out of the ledger** until checkout. `shopping_lists` is context-scoped like transactions; `shopping_list_items` is scoped by its **parent list** (hand-written model, not `modelGenerator`) so a shared list shows every member's items — item hooks resolve the list via `req.context` and `404` if it isn't visible. `POST /shopping-lists/:id/checkout { amount }` books **one expense** into the list's own context, links it, and freezes the list (`status: 'purchased'` — no further edits, no re-checkout). It **reuses** the transactions `BEFORE_CREATE` hook for the `available ≥ 0` guard before any write, then commits the expense + freeze in one `db.transaction`. Item `price` is a per-unit estimate; the checkout `amount` is authoritative. Deleting a list cascades to items and leaves the transaction intact.

- **Loans (ADR-010):** receivables mirroring the vault model — no money columns; `pending = Σlend − Σrepay` and `amount = Σlend` derive from the append-only `loan_history` ledger. `POST /loans/:id/lend { amount }` (≤ available) and `/repay` (≤ pending) each **also book a journal transaction** (`expense`/`income` with `transactions.loan_id` set) in the loan's own context — journal rows are **excluded from balance math** and **read-only** via `/transactions` (`400` on PUT/DELETE; `loan_id` never whitelisted). `available = total − locked − lent`; `total` sums only `loan_id IS NULL` rows. Creation: `{ name }` plain; `{ name, amount }` = create + lend atomic; `+ pre_existing: true` also posts a counted opening income (`total +A`, `available ±0`) — one `db.transaction` each. Loan deletes only at `pending = 0` (journal rows survive). Events: `loan created/updated/deleted/lent/repaid`; journal rows log no transaction event. North star: write-off endpoint + `direction` (borrowed) column.

- **Activity events (ADR-009):** every successful mutation appends to the immutable `events` ledger (append-only like `vault_history`; hand-written model). Actor = `req.userId`; `team_id` = the **affected record's** context (items use the parent list's). Emitted from the after-hooks (`CREATE`/`UPDATE`/`DESTROY`) for generated CRUD, and from controllers for allocate/withdraw, checkout (inside its atomic commit), and team management. `summary` is a JSON display snapshot with **decimal** amounts. `GET /events` (read-only, `context: true`) returns the newest-first feed — `entity`/`action`/`since_id`/`limit` (default 50, max 200) params, `actor_email` joined; personal feed = own actions, team feed = all members'; reads open to every role. Unlogged by design: categories, renames, team create/delete. North star: Expo remote push over this same ledger.

- **Transactions search (ADR-011):** `GET /transactions` is a custom route (before `restGenerator`) returning `{ items, next_cursor, totals }`. Params: `q` (description/category name, literal LIKE), `from`/`to` (inclusive `YYYY-MM-DD`), `type`, `category_id`, `loans=only|exclude`, `sort=asc|desc`, `limit` (30/100), `cursor` (opaque keyset on `(occurred_at, id)`); bad input → `400`. `totals` cover the whole filtered set and exclude journal rows (`count` includes them). Param parsing/cursor codec lives in `src/lib/pagination.js`, shared with `/events`; scope reuses `modelGenerator`'s `scopeClause(scope, alias)`.

### Vault / balance model (the core logic)

Vaults are logical allocations within one balance, not separate accounts. Transactions are a **pure ledger**; allocation is a **separate, amount-based** operation. Balances are **derived live** from two ledgers — never stored (see ADR-004). Cent-level helpers live in `entities/balance/db/queries.js`.

- `total` (net worth) = `SUM(income) − SUM(expense)` — from `transactions` where `loan_id IS NULL`; unaffected by vaults and loans.
- `vault[V] balance` = `SUM(allocate) − SUM(withdraw)` for V — from `vault_history`.
- `loan[L] pending` = `SUM(lend) − SUM(repay)` for L — from `loan_history`.
- `available` (spendable) = `total − SUM(all vault balances) − SUM(all loan pending)`.

Allocate (`POST /vaults/:id/allocate { amount }`) moves spendable money into a vault (≤ available); withdraw (`{ amount }`) returns it (≤ vault balance). Each **appends** a row to the append-only `vault_history` ledger (its source of truth). **Hard invariant: `available ≥ 0`** — enforced on every write that lowers net worth or raises locked (create expense, increase expense, decrease income, delete income, allocate) → `400` if breached. A vault deletes only at balance 0.

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
