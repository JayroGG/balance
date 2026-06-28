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
| **Vaults** | Funded by **allocating an amount** of spendable money into a vault; **withdrawing** an amount returns it to spendable. Movements are recorded in the append-only `vault_history` ledger — its source of truth. No direct spending from a vault. (Corrected in ADR-004.) |
| **Balance** | Endpoint exposes all three: `total` (net worth), `available` (spendable), per-vault balances. Computed live; `available` is a hard `≥ 0` invariant. |
| **Soft deletion** | Everywhere, via a nullable `deleted_at` timestamp (`NULL` = active). |

## 5. Data Model

All monetary amounts are `INTEGER` (cents). All tables carry `created_at`, `updated_at`, `deleted_at` (nullable), and `user_id` (defaults to the seeded user; indexed for future multi-tenancy).

- **users** — `id, email, password_hash (nullable for now), …`
- **categories** — `id, user_id, name, kind ('income'|'expense'|'both'), …`
- **vaults** — `id, user_id, name, target_amount (cents, nullable), …`
- **transactions** — `id, user_id, type ('income'|'expense'), amount (cents, > 0), category_id (FK, nullable), description, occurred_at, …` — a pure income/expense ledger; carries **no** vault reference.
- **vault_history** — `id, user_id, vault_id, action ('allocate'|'withdraw'), amount (cents, > 0), created_at` — **append-only ledger of vault movements; the source of truth for vault balances** (not just an audit trail).

**Invariants** (enforced in hooks/controller):
- `amount` is always a positive integer; `type` carries the sign meaning.
- `available ≥ 0` at all times — money in a vault is untouchable; any write that would push it negative is rejected `400` (see §6).
- A vault may only be deleted when its balance is `0` (withdraw it to zero first).

See `ARCHITECTURE.md` for the Mermaid ER diagram.

## 6. Vault & Balance Model

Vaults are **logical allocations within a single balance**, not separate sub-accounts (the Monzo/Revolut pattern). Money allocated to a vault still belongs to net worth — it is simply not spendable until withdrawn. Transactions are a **pure ledger**; allocation is a **separate, amount-based operation** recorded in `vault_history`. (This corrects the original design, where allocation flipped a transaction's `vault_id` and only whole transactions could move — see ADR-004.)

**Balance figures** (computed live, all in integer cents, always filtering `deleted_at IS NULL`):

- `total` (net worth) = `SUM(income) − SUM(expense)` — from `transactions`; **unaffected** by allocate/withdraw.
- `vault[V] balance` = `SUM(allocate) − SUM(withdraw)` for V — from `vault_history`.
- `locked` = `SUM(vault[V])` over active vaults.
- `available` (spendable) = `total − locked`.

**Allocate** `POST /vaults/:id/allocate { amount }`: move spendable money into a vault → vault balance ↑, available ↓; appends an `allocate` row. Bounded by `amount ≤ available`.

**Withdraw** `POST /vaults/:id/withdraw { amount }`: move money from a vault back to spendable → vault balance ↓, available ↑, net worth unchanged; appends a `withdraw` row. Bounded by `amount ≤ vault[V]`.

**Hard invariant — `available ≥ 0`:** vaulted money is protected; to spend it you must withdraw it first. Enforced on every write that lowers `net_worth` or raises `locked` — create expense, increase expense, decrease income, delete income, and allocate all reject with `400` if they would breach it.

Worked example:

| Action | total | vault E | available |
|---|---|---|---|
| income +2000 | 2000 | 0 | 2000 |
| allocate 500 → E | 2000 | 500 | 1500 |
| expense −1500 | 500 | 500 | 0 |
| expense −1 (would make available −1) | — | — | **rejected 400** |
| withdraw 500 from E | 500 | 0 | 500 |

**Derived, not stored:** balances are always computed from the two ledgers (`transactions`, `vault_history`); there is no materialized balance. A SQLite VIEW is the only sanctioned read-side convenience if ever needed (still derived, zero drift). See ADR-004 for the rationale.

## 7. API Surface

```
# Transactions (CRUD + soft delete)
GET    /transactions            ?type= &category_id=
POST   /transactions            { type, amount, category_id?, description?, occurred_at? }
GET    /transactions/:id
PUT    /transactions/:id
DELETE /transactions/:id        (soft delete)

# Categories (CRUD + soft delete)
GET/POST /categories ; GET/PUT/DELETE /categories/:id

# Vaults (CRUD + soft delete) + actions
GET/POST /vaults ; GET/PUT/DELETE /vaults/:id   (DELETE requires balance = 0)
GET    /vaults/:id/history       (vault_history movement ledger)
POST   /vaults/:id/allocate      { amount }      (≤ available)
POST   /vaults/:id/withdraw      { amount }      (≤ vault balance)

# Balance (aggregate business logic)
GET    /balance                 { total, available, vaults:[{id,name,balance,target?}], currency }

# Teams (multi-tenant context) + membership management
GET    /teams                   list teams I belong to, each tagged with my `role`
POST   /teams                   { name }        (any user; creator becomes first owner)
GET    /teams/:id               (any member)
PUT    /teams/:id               { name }        (owner-only; rename)
DELETE /teams/:id               (owner-only; blocked unless team has no active transactions/vaults)
GET    /teams/:id/members       (any member)
POST   /teams/:id/members       { email|user_id, role }   (owner-only; add/revive member)
PUT    /teams/:id/members/:userId  { role }     (owner-only; promote/demote; can't demote last owner)
DELETE /teams/:id/members/:userId  (owner-only; can't remove last owner)

# Context switching: every financial endpoint takes an optional ?team_id=
#   omitted -> personal (user_id = me AND team_id IS NULL)
#   present -> that team's data (membership verified; role enforced)
```

Amounts in requests/responses are **decimals**. Soft-deleted resources return `404`. Standard status codes (`200/201/400/404/500`); RBAC denials return `403`.

### Roles & permissions (team context) — ADR-005

Membership carries a role: **owner | member | guest**. Two gates, enforced uniformly across
transactions, vaults, categories, balance:

- **Read (GET):** all roles see *all* the team's rows.
- **Create / edit / delete / allocate / withdraw:** **guest** is denied (read-only); **member** may
  create, and edit/delete/allocate only rows **they created**; **owner** bypasses ownership (full
  access). **Personal context** (`team_id` null) is always `user_id = self` — full self-management.
- **Team management** (rename, delete, add/remove member, change role) is **owner-only by
  `team_members.role`** (multiple owners supported; the creator is not privileged).

## 8. Architecture (summary)

Entity pattern: each resource lives in `src/entities/<name>/` as a generated **model** (`db/model.js` via `modelGenerator`) and **routes** (`http/routes.js` via `restGenerator`), with validation and invariants in **hooks** (`http/hooks.js`). Generic CRUD generators live in `src/utils/`. Money decimal↔cents conversion is handled by the model layer (`moneyFields`). DB connection and environment config are isolated in `src/config/`. See `ARCHITECTURE.md` for the full directory map and diagrams.

## 9. Phases

- **Phase 1 — POC (current):** schema + migrate + seed; Categories, Vaults (with allocate/withdraw + history), Transactions, and Balance modules; environment separation; documentation/scaffolding.
- **Phase 2 — Auth:** DB-backed users with hashed passwords (ADR-003), then Auth0 + RBAC as the north star (ADR-001); swap the POC auth middleware for real authentication; user-scope every query.
- **Phase 3 — Enhancements:** multi-currency, budgets per category/period, recurring transactions, reporting/aggregation endpoints.
- **Phase 4 — Bank/account integrations (future, post-Auth0):** import transactions automatically from a linked account/card via a banking aggregator (e.g. **Pluggy** or **Belvo** for Nubank / Open Finance Brasil — Google Wallet has no transaction-read API, so it's out). Depends on real auth being in place (per-user tokens). Needs a `connections`/`accounts` concept, an import service mapping external transactions → the `transactions` ledger, and idempotent sync (`external_id` + `source` on transactions). Aggregator choice (Pluggy vs. Belvo) is its own ADR when this starts.

## 10. Workflow & Documentation Deliverables

Every project follows the shared agent-driven workflow and ships agent-readable scaffolding so any agent (Claude Code or otherwise) can navigate the codebase and understand the architecture:

- `PRD.md` (this file) — requirements, decisions, phases.
- `CLAUDE.md` — tech stack, key commands, architecture, key files, the `/prime → /plan-feature → /execute → /commit` workflow.
- `ARCHITECTURE.md` — Mermaid ER diagram, balance-flow diagram, directory/file map.
- `README.md` — setup, environment config, run instructions, endpoint summary.
- `.claude/agents/plans/` — feature implementation plans (generated by `/plan-feature`).

Per-project long-term memory lives in `~/.claude/projects/<path>/memory/` and is auto-maintained across conversations.
