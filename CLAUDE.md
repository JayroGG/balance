# CLAUDE.md — `balance`

Project-specific context for Claude Code. Read this together with the global `~/.claude/CLAUDE.md` and `PRD.md`.

## What this is

A **single-user REST API** for personal financial records: incomings, expenses, savings vaults, and balance business logic. Full CRUD with soft deletion. POC stage. See `PRD.md` for requirements/decisions and `ARCHITECTURE.md` for diagrams and the file map.

## Tech stack

- **Runtime:** Node.js (CommonJS).
- **Framework:** Express.
- **Database:** SQLite via `better-sqlite3` (synchronous, single-file).
- **Config:** `dotenv` with per-environment files (`stage`, `prod`).
- **No** TypeScript, ORM, test runner, or linter at POC stage — kept deliberately lean.

## Key commands

> Commands honor `NODE_ENV` (`stage` default, or `prod`). Each environment uses its own DB file.

```bash
NODE_ENV=stage npm run migrate   # apply schema.sql
NODE_ENV=stage npm run seed      # seed user_id=1 + default categories
NODE_ENV=stage npm start         # boot the API
NODE_ENV=prod  npm start         # boot against the prod DB/config
```

## Architecture

- **Entity pattern:** each resource lives in `src/entities/<name>/` as a generated **model** (`db/model.js` via `modelGenerator`) + **routes** (`http/routes.js` via `restGenerator`), with validation/invariants in **hooks** (`http/hooks.js`). Generic CRUD generators live in `src/utils/`. Custom routes register before `restGenerator`. Import models cross-entity directly (never via the entity `index.js`) to avoid circular deps.
- **Money:** stored as integer **cents**; API speaks **decimals**. The model layer converts decimal↔cents via `moneyFields` (`src/lib/money.js`).
- **Auth-ready:** `middleware/auth.js` injects `req.userId = 1` for now. Every table has `user_id`; swap this middleware for real auth in Phase 2 without touching queries.
- **Soft deletion:** every table has a nullable `deleted_at`. All reads filter `deleted_at IS NULL`; deletes set the timestamp. Soft-deleted resources return `404`.
- **Teams & context:** every financial table carries a nullable `team_id`. A request runs in one context, set by `?team_id=` and resolved by `middleware/resolveContext.js` into `req.context = { userId, teamId, role }` (omitted = personal, `role: null`). `team_members` records membership + role.
- **RBAC (ADR-005):** team roles `owner | member | guest` on `team_members`. Two gates centralized in `src/lib/access.js` (`assertCanWrite`/`assertOwns`/`assertCanMutate`), called from the `restGenerator` write handlers and the vault allocate/withdraw routes: guests are read-only; members write only rows they created; owners bypass ownership. Reads are open to all roles. Team management (rename/delete/add/remove/change-role) is owner-only **by role** (not `teams.user_id`); a team deletes only when empty. Role writes funnel through `teams/db/members.js`.

### Vault / balance model (the core logic)

Vaults are logical allocations within one balance, not separate accounts. Transactions are a **pure ledger**; allocation is a **separate, amount-based** operation. Balances are **derived live** from two ledgers — never stored (see ADR-004). Cent-level helpers live in `entities/balance/db/queries.js`.

- `total` (net worth) = `SUM(income) − SUM(expense)` — from `transactions`; unaffected by vaults.
- `vault[V] balance` = `SUM(allocate) − SUM(withdraw)` for V — from `vault_history`.
- `available` (spendable) = `total − SUM(all vault balances)`.

Allocate (`POST /vaults/:id/allocate { amount }`) moves spendable money into a vault (≤ available); withdraw (`{ amount }`) returns it (≤ vault balance). Each **appends** a row to the append-only `vault_history` ledger (its source of truth). **Hard invariant: `available ≥ 0`** — enforced on every write that lowers net worth or raises locked (create expense, increase expense, decrease income, delete income, allocate) → `400` if breached. A vault deletes only at balance 0.

## Key files

| Path | Purpose |
|---|---|
| `src/config/env.js` | Loads/validates `.env.<NODE_ENV>`; exports config. |
| `src/config/db.js` | `better-sqlite3` connection (path from config). |
| `src/db/schema.sql` | Full DDL (all tables, indexes, constraints). |
| `src/db/migrate.js` / `seed.js` | Apply schema / seed user + categories. |
| `src/middleware/` | `auth.js`, `errorHandler.js`. |
| `src/lib/money.js` | Decimal ↔ cents conversion. |
| `src/constants/hooks.js` | Lifecycle hook type constants. |
| `src/utils/{modelGenerator,restGenerator}/` | Generic CRUD model + routes/handlers. |
| `src/entities/{transactions,vaults,categories,balance}/` | Feature entities (constants, `db/`, `http/`). |
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
