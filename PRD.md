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
| **Tooling** | Bare minimum: manual boundary validation, no Swagger/ESLint. Jest + supertest suite added post-POC (ADR-007). |
| **Environments** | Separated from day one via `dotenv` + `NODE_ENV` — `stage` and `prod`, each with its own DB file. |
| **Auth** | Single seeded user (`user_id = 1`) now; schema + middleware designed for later DB-backed hashed auth. |
| **Money** | Stored as **integer cents** in SQLite; API speaks **decimals** (e.g. `19.99`). Converted at the boundary. |
| **Categories** | First-class resource with CRUD + soft delete; transactions carry **0..N categories as tags** (`category_ids`; the full amount counts under each; ADR-013). |
| **Vaults** | Funded by **allocating an amount** of spendable money into a vault; **withdrawing** an amount returns it to spendable. Movements are recorded in the append-only `vault_history` ledger — its source of truth. No direct spending from a vault. (Corrected in ADR-004.) |
| **Balance** | Endpoint exposes all three: `total` (net worth), `available` (spendable), per-vault balances. Computed live; `available` is signed and may go negative (ADR-012). |
| **Soft deletion** | Everywhere, via a nullable `deleted_at` timestamp (`NULL` = active). |
| **Shopping lists** | Pre-expense checklists, kept **out of the ledger** until checkout books a single expense transaction for the whole list. Item prices are per-unit *estimates*; the checkout `amount` is authoritative. (ADR-008.) |
| **Activity events** | Every successful mutation appends to an **append-only `events` ledger**; `GET /events` serves a polled, context-scoped feed. Remote push (Expo) is the recorded north star delivery channel. (ADR-009.) |
| **Transactions search** | `GET /transactions` filters by text (`q`: description/category), date range, type, category and loan-journal visibility, with server-side totals and cursor pagination (`{ items, next_cursor, totals }`). (ADR-011.) |
| **Loans** | Receivables (money lent out) mirroring the vault model: figures derive from an append-only `loan_history` ledger; lend/repay book **journal transactions** (`loan_id`, excluded from balance math, read-only); `available = total − locked − lent`. (ADR-010.) |

## 5. Data Model

All monetary amounts are `INTEGER` (cents). All tables carry `created_at`, `updated_at`, `deleted_at` (nullable), and `user_id` (defaults to the seeded user; indexed for future multi-tenancy).

- **users** — `id, email, password_hash (nullable for now), …`
- **categories** — `id, user_id, name, kind ('income'|'expense'|'both'), …`
- **vaults** — `id, user_id, name, target_amount (cents, nullable), …`
- **transactions** — `id, user_id, type ('income'|'expense'), amount (cents, > 0), loan_id (FK, nullable), description, occurred_at, …` — a pure income/expense ledger; carries **no** vault reference. Rows with `loan_id` set are **loan journal entries**: display-only history, excluded from balance math, server-owned and read-only (ADR-010).
- **vault_history** — `id, user_id, vault_id, action ('allocate'|'withdraw'), amount (cents, > 0), created_at` — **append-only ledger of vault movements; the source of truth for vault balances** (not just an audit trail).
- **loans** — `id, user_id, team_id (nullable), name, …` — a receivable (money lent to someone). **No money columns**: `amount` (Σ lend) and `pending` (Σ lend − Σ repay) derive from `loan_history`, like a vault balance.
- **loan_history** — `id, user_id, loan_id, action ('lend'|'repay'), amount (cents, > 0), created_at` — **append-only ledger of loan movements; the source of truth for loan figures**.
- **transaction_categories** — `transaction_id, category_id` (PK both; index on `category_id`) — the tag join (ADR-013); replaces the old `transactions.category_id`.
- **shopping_lists** — `id, user_id, team_id (nullable), name, status ('open'|'purchased'), category_id (FK, nullable), transaction_id (FK, nullable), …` — a pre-expense checklist. `status` and `transaction_id` are **server-owned** (set only by checkout).
- **shopping_list_items** — `id, user_id, list_id (FK), name, qty (real, > 0), price (cents, nullable), checked, …` — checklist rows, scoped by their **parent list** rather than by user/team. `price` is a per-**unit** estimate.
- **events** — `id, user_id (actor), team_id (nullable), entity, entity_id, action, summary (JSON, decimal amounts), created_at` — **append-only activity ledger** (immutable: no updates, no soft deletes); source of truth for the `/events` feed.

**Invariants** (enforced in hooks/controller):
- `amount` is always a positive integer; `type` carries the sign meaning.
- `available` may go negative (ADR-012, supersedes the old `≥ 0` rule of ADR-004): transaction writes and checkout are never rejected for balance. Only vault **allocate** and loan **lend** are capped by `available`; vault and loan balances stay non-negative (see §6).
- A vault may only be deleted when its balance is `0` (withdraw it to zero first).
- A loan may only be deleted when its `pending` is `0` (repay — or someday write off — first); its journal rows survive deletion.
- A `purchased` shopping list is frozen history: no edits to it or its items, and no second checkout (`400`).

See `ARCHITECTURE.md` for the Mermaid ER diagram.

## 6. Vault & Balance Model

Vaults are **logical allocations within a single balance**, not separate sub-accounts (the Monzo/Revolut pattern). Money allocated to a vault still belongs to net worth — it is simply not spendable until withdrawn. Transactions are a **pure ledger**; allocation is a **separate, amount-based operation** recorded in `vault_history`. (This corrects the original design, where allocation flipped a transaction's `vault_id` and only whole transactions could move — see ADR-004.)

**Balance figures** (computed live, all in integer cents, always filtering `deleted_at IS NULL`):

- `total` (net worth) = `SUM(income) − SUM(expense)` — from `transactions` **where `loan_id IS NULL`** (journal rows are display-only); **unaffected** by allocate/withdraw and lend/repay.
- `vault[V] balance` = `SUM(allocate) − SUM(withdraw)` for V — from `vault_history`.
- `locked` = `SUM(vault[V])` over active vaults.
- `loan[L] pending` = `SUM(lend) − SUM(repay)` for L — from `loan_history`; `lent` = `SUM(loan[L])` over active loans.
- `available` (spendable) = `total − locked − lent`.

**Allocate** `POST /vaults/:id/allocate { amount }`: move spendable money into a vault → vault balance ↑, available ↓; appends an `allocate` row. Bounded by `amount ≤ available`.

**Withdraw** `POST /vaults/:id/withdraw { amount }`: move money from a vault back to spendable → vault balance ↓, available ↑, net worth unchanged; appends a `withdraw` row. Bounded by `amount ≤ vault[V]`.

**`available` is signed (ADR-012):** the owner may overspend and the ledger records it. Only allocate (`≤ available`) and lend (`≤ available`) are capped, so with `available ≤ 0` nothing can be locked or lent; withdraw stays `≤ vault balance`.

Worked example:

| Action | total | vault E | available |
|---|---|---|---|
| income +2000 | 2000 | 0 | 2000 |
| allocate 500 → E | 2000 | 500 | 1500 |
| expense −1500 | 500 | 500 | 0 |
| expense −1 (would make available −1) | — | — | **rejected 400** |
| withdraw 500 from E | 500 | 0 | 500 |

**Derived, not stored:** balances are always computed from the ledgers (`transactions`, `vault_history`, `loan_history`); there is no materialized balance. A SQLite VIEW is the only sanctioned read-side convenience if ever needed (still derived, zero drift). See ADR-004 for the rationale.

## 6d. Loans (ADR-010)

A **loan is a receivable** — money lent to someone (`name` = usually the person). It mirrors the
vault model: **lend** (`POST /loans/:id/lend { amount }`, ≤ `available`) moves spendable money into
the loan's `pending`; **repay** (≤ `pending`) releases it back. Neither changes `total` — cash
converts to a claim and back. Lent wealth counts toward net worth but never toward spendable.

- **Journal rows.** Every lend/repay also books a transaction (`expense`/`income`, description =
  loan name) carrying `loan_id` — "the ledger tells the whole story." Journal rows are excluded
  from balance math and **read-only** via `/transactions` (`400` on PUT/DELETE): their truth lives
  in `loan_history`.
- **Creation semantics** (`POST /loans`): `{ name }` → empty loan; `{ name, amount }` → create +
  initial lend atomically (≤ `available`); `{ name, amount, pre_existing: true }` → additionally
  posts a **counted** plain income (`"Loan opening: <name>"`, `loan_id NULL`) so a loan made before
  the app existed lands as `total +amount`, `available ±0` — all in one `db.transaction`.
- **Invariants:** `available` already discounts lent money; lend stays capped by it. Deleting an opening income while the money is still lent is now allowed (available goes negative, ADR-012). A loan deletes only at `pending = 0`.
- **North star (deferred):** `POST /loans/:id/write-off` (counted expense for the remaining
  pending — wealth genuinely lost) and a `direction` column for borrowed money. See ADR-010.

## 6b. Shopping Lists (ADR-008)

A **shopping list** is a checklist you build *before* spending: name it, add items, tick off what you actually bought, then **check out**. Checkout books **one expense transaction** for the whole list, links it (`transaction_id`), and freezes the list as `purchased` history.

Planned items are **not** money that moved — a list costs nothing and touches no balance figure until checkout. This keeps `transactions` a faithful record of real charges.

- **Scoping.** A list is context-scoped like transactions (`?team_id=` → personal or team). Its **items are scoped by the list**, not by user/team, so on a shared team list everyone sees everyone's items. Item access is authorized by resolving the parent list in the caller's context first — an unreachable list yields `404` before any item row is touched.
- **Checkout** (`POST /shopping-lists/:id/checkout { amount, category_id?, occurred_at? }`) requires at least one **checked** item and a positive `amount`. Item `price` is a per-unit **estimate**; the client sends the real total (the receipt is authoritative). Categories resolve `body.category_ids`, else `[body.category_id ?? list.category_id]`, else none. The expense is booked into the **list's own context**, not the caller's active one.
- **Validation is reused, not reimplemented:** checkout runs the transactions `BEFORE_CREATE` hook before any write, so an invalid body (bad type, category outside the list's context) is rejected `400` and books nothing. A checkout may overdraw `available` (ADR-012). The expense insert and the list freeze are one atomic DB transaction.
- **Freezing & deletion.** A purchased list rejects renames, category edits, item writes, and a second checkout (`400`). Soft-deleting a list cascades a soft delete to its items and **leaves the linked transaction intact** — the money was really spent.
- **RBAC** is inherited (ADR-005/006): guest read-only, member mutates only lists they created, owner/admin bypass.

## 6c. Activity Events (ADR-009)

Every meaningful successful mutation is recorded in an **append-only `events` ledger** — who
(actor), where (context), what (`entity`/`entity_id`/`action`), plus a JSON `summary` snapshot for
display (amounts as **decimals**). Events are immutable: never updated, never soft-deleted, and
`/events` has no write routes.

- **Emission.** Generated CRUD logs from the **after-hooks** (`CREATE`/`UPDATE`/`DESTROY`), so only
  writes that landed are recorded; custom flows log in their controllers (vault allocate/withdraw,
  list checkout, team management). The checkout event rides the same `db.transaction` as the
  expense + freeze — a rejected checkout logs nothing.
- **Scoping.** `team_id` comes from the **affected record's** context, not the caller's active one;
  `user_id` is always the human actor (admins act as themselves). The feed is context-scoped like
  transactions: personal = your own actions; `?team_id=` = every member's actions in that team.
  Reads are open to all roles (guests included); non-members get `403`.
- **Feed.** Newest first; `entity`/`action` equality filters; `since_id` (only `id >`) and `limit`
  (default 50, max 200) for incremental polling and unread badges; `actor_email` joined in.
- **Catalog.** transactions created/updated/deleted · vaults created/deleted/allocated/withdrawn ·
  loans created/updated/deleted/lent/repaid (journal rows log **no** transaction event — the loan
  event is the story) · shopping lists created/checked_out/deleted · items created/updated/deleted
  (carry the parent list's context) · team updated/member_added/member_removed/role_changed.
  Deliberately unlogged: categories, vault/list renames, team create/delete.
- **North star:** remote push (Expo Push Service) delivering these same events while the app is
  closed — blocked only on a paid Apple Developer membership; the ledger/feed need no changes.

## 7. API Surface

```
# Transactions (CRUD + soft delete)
GET    /transactions            ?q= &from= &to= &type= &category_id= &loans= &sort= &limit= &cursor=  → { items, next_cursor, totals }  (ADR-011)
POST   /transactions            { type, amount, category_ids?: int[], description?, occurred_at? }  → row carries categories: [{ id, name }]  (ADR-013)
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

# Loans (CRUD + soft delete) + actions                        (ADR-010)
GET/POST /loans ; GET/PUT/DELETE /loans/:id     (PUT: { name } only; DELETE requires pending = 0)
POST   /loans                    { name, amount?, pre_existing? }   (see §6d creation semantics)
GET    /loans/:id/history        (loan_history movement ledger)
POST   /loans/:id/lend           { amount }      (≤ available; books a journal expense)
POST   /loans/:id/repay          { amount }      (≤ pending; books a journal income)

# Balance (aggregate business logic)
GET    /balance                 { total, available, lent, vaults:[{id,name,balance,target?}],
                                  loans:[{id,name,amount,pending}], currency }

# Shopping lists (CRUD + soft delete) + checkout            (ADR-008)
GET    /shopping-lists          ?status=open|purchased
POST   /shopping-lists          { name, category_id? }
GET/PUT/DELETE /shopping-lists/:id     (PUT/DELETE blocked once purchased; DELETE cascades to items)
POST   /shopping-lists/:id/checkout    { amount, category_ids?, category_id?, occurred_at? }
                                       (≥ 1 checked item; books one expense; freezes the list)

# Shopping list items (CRUD + soft delete) — authorized through the parent list
GET    /shopping-list-items     ?list_id=   (required)
POST   /shopping-list-items     { list_id, name, qty?, price?, checked? }
PUT/DELETE /shopping-list-items/:id

# Activity events (read-only, append-only ledger)             (ADR-009)
GET    /events                  ?entity= &action= &since_id= &limit=
                                (newest first; limit default 50, max 200;
                                 personal = own actions, ?team_id= = all members' actions)

# Teams (multi-tenant context) + membership management
GET    /teams                   list teams I belong to, each tagged with my `role`
POST   /teams                   { name, color? }  (any user; creator becomes first owner)
GET    /teams/:id               (any member)
PUT    /teams/:id               { name?, color? } (owner-only; at least one field; color: null clears)
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

### Global admin role — ADR-006

Separately, `users.role` is `user` (default) or `admin`. A global **admin** is a platform super-admin
that **overrides all of the above**: it bypasses team RBAC, team membership, and row ownership, can
operate in any team (`?team_id=`) without joining, and can reach any user's personal data via an
admin-only `?user_id=` selector (ignored for non-admins). The role rides in the JWT. **Integrity
invariants are still enforced for admins** (allocate/lend ≤ available, vault-at-0 delete, team-delete-when-empty,
last-owner). Admins are created via `npm run create-user -- <email> <password> admin`.

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
