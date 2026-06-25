# PRD — `balance`

> Product Requirements Document. Long-term memory for the project: requirements, decisions, and feature phases. Keep this current as scope evolves.

## 1. Overview

`balance` is a **single-user REST API** for tracking personal financial records. It records **incomings** (income) and **expenses**, supports full **CRUD with soft deletion**, and exposes **balance business logic** through a dedicated endpoint.

The defining feature: some incomings are set aside into **savings vaults** (conceptually like Monzo *Pots* / Revolut *Vaults*). The balance endpoint must therefore report not just a single number but three figures — **total net worth**, **spendable/available money**, and **per-vault balances** — so money parked in vaults is correctly excluded from what's spendable while still counting toward net worth.

This is a proof of concept (POC). Two things must be correct from day one: the **data model + balance math**, and the **project scaffolding/workflow files** so the project integrates with the same agent-driven workflow used across other projects (e.g. `llm-insights`).

## 2. Goals

- Record incomings and expenses with full CRUD.
- Soft-delete everything (recoverable, audit-friendly) — no hard deletes.
- Allocate income into named savings vaults and track each vault's balance.
- Expose a balance endpoint returning total, available, and per-vault figures.
- Keep the schema and middleware **auth-ready** so DB-backed hashed auth can be added later without restructuring.

## 3. Non-Goals (POC)

- No UI / frontend (REST API only).
- No authentication yet (single seeded user).
- No multi-currency (single currency, configurable label).
- No budgets, recurring transactions, or reporting/analytics.
- No partial-amount vault withdrawals (see §6).

## 4. Locked Decisions

| Area | Decision |
|---|---|
| **Scope** | REST API only, no UI. |
| **Stack** | Node.js + Express + `better-sqlite3`. JavaScript (CommonJS). |
| **Tooling** | Bare minimum: manual boundary validation, no test suite, no Swagger/ESLint. |
| **Environments** | Separated from day one via `dotenv` + `NODE_ENV` — `stage` and `prod`, each with its own DB file. |
| **Auth** | Single seeded user (`user_id = 1`) now; schema + middleware designed for later DB-backed hashed auth. |
| **Money** | Stored as **integer cents** in SQLite; API speaks **decimals** (e.g. `19.99`). Converted at the boundary. |
| **Categories** | First-class resource with CRUD + soft delete; transactions reference a category. |
| **Vaults** | Funded by **tagging income** with `vault_id` (mutable). Detaching (`vault_id → NULL`) = withdrawal → money becomes spendable. No direct spending from a vault. Allocate/withdraw logged in `vault_history`. |
| **Balance** | Endpoint exposes all three: `total` (net worth), `available` (spendable), per-vault balances. |
| **Soft deletion** | Everywhere, via a nullable `deleted_at` timestamp (`NULL` = active). |

## 5. Data Model

All monetary amounts are `INTEGER` (cents). All tables carry `created_at`, `updated_at`, `deleted_at` (nullable), and `user_id` (defaults to the seeded user; indexed for future multi-tenancy).

- **users** — `id, email, password_hash (nullable for now), …`
- **categories** — `id, user_id, name, kind ('income'|'expense'|'both'), …`
- **vaults** — `id, user_id, name, target_amount (cents, nullable), …`
- **transactions** — `id, user_id, type ('income'|'expense'), amount (cents, > 0), category_id (FK, nullable), vault_id (FK→vaults, nullable; only valid when type='income'), description, occurred_at, …`
- **vault_history** — `id, user_id, vault_id, transaction_id, action ('allocate'|'withdraw'), amount (cents), created_at` — audit trail of vault movements.

**Invariants** (enforced in the service layer):
- `expense` transactions must have `vault_id = NULL`.
- `vault_id` may only reference an active (non-deleted) vault.
- `amount` is always a positive integer; `type` carries the sign meaning.

See `ARCHITECTURE.md` for the Mermaid ER diagram.

## 6. Vault & Balance Model

Vaults are **logical allocations within a single balance**, not separate sub-accounts (the Monzo/Revolut pattern). Money allocated to a vault still belongs to net worth — it is simply not spendable until withdrawn.

**Balance figures** (computed live, always filtering `deleted_at IS NULL`):

- `total` (net worth) = `SUM(income) − SUM(expense)` — **unaffected** by vault tagging or withdrawal.
- `vault[V] balance` = `SUM(income WHERE vault_id = V)` (expenses are never vaulted).
- `available` (spendable) = `total − SUM(all vault balances)`.

**Allocate**: set an income transaction's `vault_id` to a vault (at creation or later) → vault balance ↑, available ↓; logs an `allocate` row.

**Withdraw**: set the transaction's `vault_id` back to `NULL` → vault balance ↓, available ↑, net worth unchanged; logs a `withdraw` row.

Worked example:

| Action | total | vault E | available |
|---|---|---|---|
| income +2000 (main) | 2000 | 0 | 2000 |
| income +500 (vault E) | 2500 | 500 | 2000 |
| withdraw 500 from E (detach) | 2500 | 0 | 2500 |
| expense −100 (main) | 2400 | 0 | 2400 |

**Decision — partial withdrawals (out of scope for POC):** withdrawal operates per income-transaction (detaches that transaction's full amount). Partial-amount withdrawal (splitting a transaction) is future work.

## 7. API Surface

```
# Transactions (CRUD + soft delete)
GET    /transactions            ?type= &vault_id= &category_id=
POST   /transactions            { type, amount, category_id?, vault_id?, description?, occurred_at? }
GET    /transactions/:id
PUT    /transactions/:id
DELETE /transactions/:id        (soft delete)

# Categories (CRUD + soft delete)
GET/POST /categories ; GET/PUT/DELETE /categories/:id

# Vaults (CRUD + soft delete) + actions
GET/POST /vaults ; GET/PUT/DELETE /vaults/:id
GET    /vaults/:id/history       (vault_history log)
POST   /vaults/:id/allocate      { transaction_id }
POST   /vaults/:id/withdraw      { transaction_id }

# Balance (aggregate business logic)
GET    /balance                 { total, available, vaults:[{id,name,balance,target?}], currency }
```

Amounts in requests/responses are **decimals**. Soft-deleted resources return `404`. Standard status codes (`200/201/400/404/500`).

## 8. Architecture (summary)

Entity pattern: each resource lives in `src/entities/<name>/` as a generated **model** (`db/model.js` via `modelGenerator`) and **routes** (`http/routes.js` via `restGenerator`), with validation and invariants in **hooks** (`http/hooks.js`). Generic CRUD generators live in `src/utils/`. Money decimal↔cents conversion is handled by the model layer (`moneyFields`). DB connection and environment config are isolated in `src/config/`. See `ARCHITECTURE.md` for the full directory map and diagrams.

## 9. Phases

- **Phase 1 — POC (current):** schema + migrate + seed; Categories, Vaults (with allocate/withdraw + history), Transactions, and Balance modules; environment separation; documentation/scaffolding.
- **Phase 2 — Auth:** DB-backed users with hashed passwords; swap the POC auth middleware for real authentication; user-scope every query.
- **Phase 3 — Enhancements:** partial vault withdrawals, multi-currency, budgets per category/period, recurring transactions, reporting/aggregation endpoints.

## 10. Workflow & Documentation Deliverables

Every project follows the shared agent-driven workflow and ships agent-readable scaffolding so any agent (Claude Code or otherwise) can navigate the codebase and understand the architecture:

- `PRD.md` (this file) — requirements, decisions, phases.
- `CLAUDE.md` — tech stack, key commands, architecture, key files, the `/prime → /plan-feature → /execute → /commit` workflow.
- `ARCHITECTURE.md` — Mermaid ER diagram, balance-flow diagram, directory/file map.
- `README.md` — setup, environment config, run instructions, endpoint summary.
- `.claude/agents/plans/` — feature implementation plans (generated by `/plan-feature`).

Per-project long-term memory lives in `~/.claude/projects/<path>/memory/` and is auto-maintained across conversations.
