# Feature: Multi-tenant shared finance + login (phased)

The following plan should be complete, but it's important that you validate documentation and codebase patterns and task sanity before you start implementing.

Pay special attention to naming of existing utils, types, and models. Import from the right files (cross-entity: import the model/queries **file** directly, never the entity `index.js` — avoids circular deps).

## Feature Description

Move `balance` from a single-user POC to a **multi-tenant** model with **shared finance via teams**, then add **real login** (ADR-003).

- Every `transactions`, `vaults`, and `categories` row keeps `user_id` (ownership) and gains a nullable `team_id`. `team_id IS NULL` → **personal**; `team_id` set → **shared** (team-owned). Personal and team categories are separate sets — a team's categories are not shared with personal and vice-versa.
- A request operates in exactly one **context**, selected by a `?team_id=` query param: omitted = personal `(user_id = me AND team_id IS NULL)`; present = that team `(team_id = T)` after a membership check. This applies uniformly to `/transactions`, `/vaults`, `/categories`, and `/balance`.
- **Authorization model:** membership (`team_members`, verified in `resolveContext`) is the authorization; `team_id` scoping on the queries is the isolation. For team rows there is no per-user ownership check on update/delete — any verified member may read/create/update/delete that team's transactions, vaults, and categories.
- Balance math (`net_worth`, `locked`, `available`) and the hard `available ≥ 0` invariant become **context-scoped**.
- New tables: `teams`, `team_members` (the tenant-isolation control), `sessions` (ADR-003). `users` gains `active` + `verified`.
- Phase B layers ADR-003 login on top: bcrypt password check, DB `sessions`, HS256 JWT with `jti`, `AUTH_BYPASS` retained, `POST /auth/login` + `POST /auth/logout`.

## User Story

As a person managing both my own money and money shared with others (partner, household, project),
I want each transaction and vault to be either personal or owned by a team I belong to, with one endpoint set that switches context by `team_id`,
So that my personal balance and each team's balance are calculated and protected independently, and only members can see or change a team's finances.

## Problem Statement

The current model assumes one seeded user and one global balance. There is no concept of identity beyond the `AUTH_BYPASS`-style stub (`req.userId = 1`), no way to share finances, and balance/invariant logic is computed over a single `user_id` scope. We need shared finance with strict tenant isolation, plus real authentication, **without** breaking the entity pattern or the derived-balance model (ADR-004).

## Solution Statement

Introduce a single **context object** `{ userId, teamId }` resolved once per request and threaded through the model + balance layers, replacing the bare `userId` scoping argument. Team-capability is opt-in per entity (`fields.teamScoped`). A `resolveContext` middleware validates membership and sets `req.context`. Balance queries and the shared invariant guard take the context and scope accordingly. Phase B swaps the auth stub for ADR-003's bcrypt + DB-session login behind the same `src/middleware/auth.js` boundary.

## Feature Metadata

**Feature Type**: New Capability (multi-tenancy) + Enhancement (auth)
**Estimated Complexity**: High
**Primary Systems Affected**: `modelGenerator`, `restGenerator` handlers, `balance/db/queries.js`, transaction + vault hooks/controller, schema/migrate/seed, auth middleware, new `teams`/`team_members`/`sessions`/`auth` modules, env config.
**Dependencies**: `bcryptjs`, `jsonwebtoken` (Phase B only).

---

## CONTEXT REFERENCES

### Relevant Codebase Files — IMPORTANT: READ THESE BEFORE IMPLEMENTING

- `src/utils/modelGenerator/index.js` (1-89) — Why: the generic CRUD model; **all 5 methods are scoped by `userId` as the first arg**. This is the central refactor (`userId` → `scope` object + `teamScoped` branch). Note `findAll` conditions array (27-39), `create` injecting `user_id` (46-58), `findById`/`update`/`softDelete` WHERE clauses.
- `src/utils/restGenerator/index.js` (8-15) — Why: mounts the 5 handlers; signatures unchanged but handlers below change what they pass.
- `src/utils/restGenerator/handlers/listAllHandler.js` (4-14) — Why: passes `req.userId` + builds `filters` from `entity.filterFields`. Must pass `scope`; `team_id` is NOT a filter field (it's context).
- `src/utils/restGenerator/handlers/createHandler.js` (4-15) — Why: `entity.create(req.userId, body)` → `entity.create(scope, body)`.
- `src/utils/restGenerator/handlers/updateHandler.js` (4-18) — Why: `findById`/`update` by `req.userId` → `scope`.
- `src/utils/restGenerator/handlers/destroyHandler.js` (4-14) — Why: `findById`/`softDelete` by `req.userId` → `scope`.
- `src/utils/restGenerator/handlers/getOneHandler.js` (4-11) — Why: `findById(req.userId, ...)` → `scope`.
- `src/entities/balance/db/queries.js` (1-64) — Why: `netWorthCents`/`vaultBalanceCents`/`lockedCents`/`availableCents`/`get` all take `userId`; rework to take `scope` and scope by context (personal vs team). This is the heart of context-scoped balance.
- `src/entities/transactions/http/hooks.js` (1-58) — Why: `assertSpendable(req.userId, ...)` invariant guard → `assertSpendable(req.context, ...)`. Keep `contribution`/`assertType` logic.
- `src/entities/transactions/db/fields.js` (1-8) — Why: add `teamScoped: true`. Do NOT add `team_id` to `create`/`update` (injected from context, never from body).
- `src/entities/vaults/http/controller.js` (1-70) — Why: `allocate`/`withdraw`/`getHistory`/`vaultView` use `req.userId`; switch reads of balance to `req.context`, keep `history.add` actor = `req.userId`.
- `src/entities/vaults/http/hooks.js` (1-24) — Why: `vaultBalanceCents(req.userId, record.id)` → `req.context`.
- `src/entities/vaults/db/fields.js` (1-8) — Why: add `teamScoped: true`.
- `src/entities/vaults/db/history.js` (1-15) — Why: `add(userId,...)` = actor; `findByVault(userId, vaultId)` scoping. Movement balance is per-vault (context-independent once vault id is known), but `findByVault` should scope by vault only (the vault was already authorized via context in the controller).
- `src/entities/vaults/http/routes.js` (1-17) — Why: custom routes BEFORE `restGenerator`; mount `resolveContext` here.
- `src/entities/transactions/http/routes.js` (1-9) — Why: mount `resolveContext`.
- `src/entities/balance/http/routes.js` (1-11) — Why: `queries.get(req.userId)` → `queries.get(req.context)`; mount `resolveContext`.
- `src/entities/categories/*` — Why: becomes **team-scoped** (add `teamScoped: true`, mount `resolveContext`). `categoryHooks` only validates `name`/`kind` (no user/balance logic) so it needs NO change — same one-line treatment as transactions/vaults. Read `categories/db/{fields,model}.js`, `http/{hooks,routes}.js`, `index.js`. Also the model pattern to mirror for the new `teams` entity (which stays NON-team-scoped — owner-scoped via `team_members`).
- `src/entities/index.js` (1-7) + `src/app.js` (1-33) — Why: entity collection + route mounting + middleware order (where `resolveContext` and public `/auth/login` slot in).
- `src/middleware/auth.js` (1-5) — Why: the ONLY identity boundary (ADR-001). Phase B rewrite. Also set a default `req.context` here.
- `src/db/schema.sql` (1-58) — Why: all DDL; add the new tables + `team_id` columns here. Data is disposable, so fresh-DB creation is the migration path (`rm -f data/*.db*`) — no ALTER logic.
- `src/db/migrate.js` (1-9) + `src/server.js` (1-23) — Why: migrate `db.exec(schema)`; server.js re-execs schema on boot (14-18). Both stay AS-IS — they pick up the new schema on a fresh DB.
- `src/db/seed.js` (1-24) — Why: seed user 1 + categories; extend with bcrypt hash, active/verified, a team + membership.
- `src/config/env.js` (1-15) — Why: env load/validate; add JWT_SECRET, JWT_EXPIRES_IN, AUTH_BYPASS, SEED_PASSWORD.
- `src/config/db.js` (1-11) — Why: `foreign_keys = ON` is set — new FKs are enforced; seed/migrate order matters.
- `src/constants/hooks.js` (1-12) — Why: hook type constants (BEFORE_CREATE etc.) for the new `teams` hooks.
- `src/middleware/errorHandler.js` (1-7) — Why: error shape — throw `{ message, status }` (set `e.status`) to short-circuit; 403/401 flow through here.

### ADRs (read for rationale)

- `.claude/ADR/ADR-001-auth-strategy.md` — auth as a single modular boundary; `AUTH_BYPASS` foot-gun must default false outside `stage`.
- `.claude/ADR/ADR-003-session-validation.md` — the exact login/session design to implement in Phase B (token shape, `jti`, validation query, logout, env vars, seed). **Flip to Accepted.**
- `.claude/ADR/ADR-004-vault-allocation-model.md` — derived-balance invariants; the `available ≥ 0` table (lines 69-78) now applies **per context**.

### New Files to Create

**Phase A (multi-tenancy):**
- `src/middleware/resolveContext.js` — resolves `?team_id=` → `req.context = { userId, teamId }`; membership check (403/404).
- `src/entities/teams/constants.js` — `ENTITY_NAME = 'teams'`.
- `src/entities/teams/db/fields.js` — `{ create:['name'], update:['name'], moneyFields:[], filterFields:[] }`.
- `src/entities/teams/db/model.js` — `modelGenerator('teams', fields)` (personal/owner-scoped, NOT teamScoped) + custom `listForMember(userId)`.
- `src/entities/teams/db/members.js` — `isMember(userId, teamId)`, `addMember(...)`, `removeMember(...)`, `listMembers(teamId)`, `findUserByEmail(email)`.
- `src/entities/teams/http/hooks.js` — on CREATE, insert creator into `team_members` as `owner`.
- `src/entities/teams/http/controller.js` — `listMine`, `addMember`, `removeMember`, `listMembers` (owner-only guard).
- `src/entities/teams/http/routes.js` — custom member routes BEFORE `restGenerator`.
- `src/entities/teams/index.js` — exports `{ Entity: { model, routes } }`.

**Phase B (login):**
- `src/entities/auth/db/sessions.js` — `create(userId, ip, ua)`, `findById(id)`, `revoke(id)`.
- `src/entities/auth/db/users.js` — `findByEmail(email)` (returns `password_hash`, `active`, `verified`).
- `src/entities/auth/http/controller.js` — `login`, `logout`.
- `src/entities/auth/http/routes.js` — exports `{ publicRoutes, protectedRoutes }` (login public, logout protected).
- `src/entities/auth/index.js`.

**Docs:**
- `.claude/ADR/ADR-005-multi-tenant-shared-finance.md` — new ADR (retire single-user premise).

### Patterns to Follow (from this codebase)

**Error short-circuit (everywhere):**
```js
const e = new Error('message'); e.status = 400; throw e;
```
Handled centrally by `errorHandler.js`. Use 400 (validation), 401 (auth), 403 (not a member), 404 (not found).

**Cross-entity import (avoid circular deps):**
```js
const { availableCents } = require('../../balance/db/queries'); // file, not index.js
```

**Entity layout:** `constants.js` → `db/{fields,model}.js` → `http/{hooks,routes,controller?}.js` → `index.js` exporting `{ Entity: { model, routes } }`. Custom routes register **before** `restGenerator`.

**Model injection:** `user_id` is injected by `modelGenerator.create` (line 52), never taken from the body. `team_id` will follow the same rule — injected from `scope`, never from `body`.

**Money:** integer cents in DB; `moneyFields` convert at the boundary (`modelGenerator` `fmt`/`parseMoney`). Don't double-convert.

---

## IMPLEMENTATION PLAN

### Phase A — Multi-tenant data model + context scoping (under existing AUTH_BYPASS stub)

Goal: teams, membership, `team_id` on transactions/vaults, context-scoped reads/writes/balance/invariants. Identity stays `req.userId = 1` (stub unchanged this phase). Ship and validate before Phase B.

### Phase B — ADR-003 login (bcrypt + sessions + JWT) behind the auth boundary

Goal: real `POST /auth/login` / `POST /auth/logout`, DB sessions, JWT `jti` validation, `AUTH_BYPASS` retained and guarded. No changes to routes/hooks/queries (identity boundary unchanged per ADR-001).

---

## STEP-BY-STEP TASKS

Execute in order, top to bottom. Validate after each.

### — PHASE A —

> **Migration note (existing data is disposable — confirmed by product owner):** do NOT build ALTER-guard upgrade logic. Put the full shape in `schema.sql` for fresh DBs and recreate the local DB by deleting the file (`rm -f data/balance.stage.db*`) then `migrate` + `seed`. On Fly, the stage volume DB can be wiped the same way (`fly ssh console` → remove the file, or just let boot recreate after deletion). This keeps `migrate.js` and `server.js` simple.

### UPDATE `src/db/schema.sql`
- **IMPLEMENT**: Add `active INTEGER NOT NULL DEFAULT 1` and `verified INTEGER NOT NULL DEFAULT 0` to `users`. Add new tables `teams`, `team_members`, `sessions`. Add `team_id INTEGER REFERENCES teams(id)` (nullable) to `transactions`, `vaults`, **and `categories`** + supporting indexes.
- **PATTERN**: Mirror existing DDL style (lines 1-58): `INTEGER PRIMARY KEY AUTOINCREMENT`, `created_at/updated_at/deleted_at` defaults via `strftime`, `CREATE INDEX IF NOT EXISTS`.
- **DDL**:
  ```sql
  CREATE TABLE IF NOT EXISTS teams (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),  -- owner/creator
    name       TEXT    NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    deleted_at TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_teams_user ON teams(user_id);

  CREATE TABLE IF NOT EXISTS team_members (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    team_id    INTEGER NOT NULL REFERENCES teams(id),
    user_id    INTEGER NOT NULL REFERENCES users(id),
    role       TEXT    NOT NULL CHECK (role IN ('owner','member')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    deleted_at TEXT,
    UNIQUE (team_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_team_members_user ON team_members(user_id);
  CREATE INDEX IF NOT EXISTS idx_team_members_team ON team_members(team_id);

  CREATE TABLE IF NOT EXISTS sessions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    issued_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')),
    expires_at TEXT NOT NULL,
    revoked_at TEXT,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  ```
  Also add `team_id INTEGER REFERENCES teams(id),` to the `transactions`, `vaults`, AND `categories` DDL, plus
  `CREATE INDEX IF NOT EXISTS idx_transactions_team ON transactions(team_id);`
  `CREATE INDEX IF NOT EXISTS idx_vaults_team ON vaults(team_id);`
  `CREATE INDEX IF NOT EXISTS idx_categories_team ON categories(team_id);`
- **GOTCHA**: SQLite allows **forward FK references at `CREATE` time** (the parent table need not exist yet — FKs are only enforced at INSERT with `foreign_keys=ON`), so table order in `schema.sql` is not strictly required. Still, define `users` → `teams` → the referencing tables for readability. The ordering that **does** matter is at **seed/insert** time: user → team → team_members. Since data is disposable, recreate the DB fresh (`rm -f data/*.db*`) — no ALTER migration needed.
- **VALIDATE**: `node -e "const fs=require('fs');const s=fs.readFileSync('src/db/schema.sql','utf8');require('better-sqlite3')(':memory:').exec(s);console.log('schema ok')"`

### `src/db/migrate.js` and `src/server.js` — NO CHANGE (data is disposable)
- **IMPLEMENT**: Leave both as-is. `migrate.js` already `db.exec(schema.sql)` and `server.js` re-execs schema on boot — both pick up the new tables/columns automatically on a **fresh** DB. No ALTER-guard logic, no `runMigrations` extraction.
- **GOTCHA**: existing DB files won't gain the new columns via `CREATE TABLE IF NOT EXISTS`. Because data is disposable, delete the DB first: `rm -f data/balance.stage.db*` then `migrate` + `seed`. Forgetting this → "no such column: team_id" at runtime; that's the signal to wipe + re-migrate.
- **VALIDATE**: `rm -f data/balance.stage.db* && NODE_ENV=stage node src/db/migrate.js`

### REFACTOR `src/utils/modelGenerator/index.js` (CENTRAL)
- **IMPLEMENT**: Change the scoping argument of all methods from `userId` to a `scope` object `{ userId, teamId }`. Add `const teamScoped = !!fields.teamScoped;`. Introduce a `scopeClause(scope)` helper returning `{ sql, values }`:
  - teamScoped + `scope.teamId != null` → `team_id = ?` with `[scope.teamId]`
  - teamScoped + `teamId == null` → `user_id = ? AND team_id IS NULL` with `[scope.userId]`
  - not teamScoped → `user_id = ?` with `[scope.userId]`
  Apply in `findAll` (replace the `['user_id = ?', 'deleted_at IS NULL']` seed at line 28), `findById`, `update`, `softDelete`. In `create` (line 46-58): cols = `['user_id', ...(teamScoped ? ['team_id'] : []), ...keys]`; values = `[scope.userId, ...(teamScoped ? [scope.teamId ?? null] : []), ...vals]`. `findById` after insert uses `scope`.
- **PATTERN**: keep `fmt`/`parseMoney`/`moneyFields` untouched; only the WHERE construction + create columns change.
- **GOTCHA**: `findAll` still appends `deleted_at IS NULL` and merges `filters`. `team_id` must NEVER be a `filterField` (it's context, not a query filter) — verify `fields.filterFields` for transactions/vaults/categories excludes it (categories' is `[]`, fine). For team context, reads are scoped by `team_id` only (any member sees all team rows) — intended. For personal, `team_id IS NULL` is required so team rows don't leak into personal.
- **GOTCHA**: every existing call site passes `userId` (a number) — they ALL must change to pass a `scope` object. The next tasks update handlers, balance queries, hooks, controllers. Do not leave any `entity.method(req.userId, ...)`.
- **VALIDATE**: `node --check src/utils/modelGenerator/index.js`

### UPDATE the 5 handlers in `src/utils/restGenerator/handlers/`
- **IMPLEMENT**: In each handler, derive `const scope = req.context || { userId: req.userId, teamId: null };` and pass `scope` everywhere the handler currently passes `req.userId` (listAll `entity.findAll(scope, filters)`; getOne/update/destroy `entity.findById(scope, ...)`, `entity.update(scope, id, body)`, `entity.softDelete(scope, id)`; create `entity.create(scope, body)`).
- **PATTERN**: hooks still receive `req` (they read `req.context` themselves). Do not change the hook call signatures.
- **GOTCHA**: `req.context` is set by `auth.js` default (next task) for ALL routes, and overridden by `resolveContext` on team-capable routers. The `|| {…}` fallback is belt-and-suspenders.
- **VALIDATE**: `for f in src/utils/restGenerator/handlers/*.js; do node --check "$f"; done`

### UPDATE `src/middleware/auth.js` (Phase A: default context only)
- **IMPLEMENT**: Keep the stub (`req.userId = 1`) for now but ALSO set `req.context = { userId: req.userId, teamId: null }` before `next()`. (Phase B rewrites identity resolution; the default-context line stays.)
- **VALIDATE**: `node --check src/middleware/auth.js`

### CREATE `src/middleware/resolveContext.js`
- **IMPLEMENT**: Express middleware. Read `req.query.team_id`. If undefined/empty → leave `req.context = { userId: req.userId, teamId: null }` (already set by auth). If present: parse to positive integer (else `400`); then via `require('../entities/teams/db/members')`: if `!teamExists(teamId)` → `404 'Team not found'`; else if `!isMember(req.userId, teamId)` → `403 'Not a member of this team'`; else set `req.context = { userId: req.userId, teamId }`.
- **GOTCHA**: import the members **file** directly (no circular dep — `members.js` imports only `config/db`). Validate `team_id` is a clean positive integer (`Number.isInteger(n) && n > 0`). Splitting 404 (no such team) from 403 (exists, not a member) avoids leaking team existence inconsistently while still being correct; both are acceptable, but be deliberate. A soft-deleted team → 404 (not 403), since `isMember` already excludes it.
- **VALIDATE**: `node --check src/middleware/resolveContext.js`

### CREATE `src/entities/teams/` (constants, fields, model, members, hooks, controller, routes, index)
- **IMPLEMENT**:
  - `constants.js`: `ENTITY_NAME = 'teams'`.
  - `db/fields.js`: `{ create:['name'], update:['name'], moneyFields:[], filterFields:[] }` (NOT teamScoped — teams are owner/user-scoped).
  - `db/model.js`: `const TeamModel = modelGenerator(ENTITY_NAME, fields)` spread with `listForMember(userId)` = teams joined to active `team_members` for that user.
  - `db/members.js`: pure SQL helpers on `team_members`/`teams`/`users`:
    - `teamExists(teamId)` → boolean (`teams` row with `deleted_at IS NULL`).
    - `isMember(userId, teamId)` → boolean — **JOIN `teams` and require `teams.deleted_at IS NULL` AND `team_members.deleted_at IS NULL`** (a soft-deleted team has no reachable members).
    - `roleOf(userId, teamId)` → `'owner' | 'member' | undefined` (for owner-only guards; same active-join).
    - `addMember(teamId, userId, role)` → `INSERT OR IGNORE`.
    - `removeMember(teamId, userId)` → soft `deleted_at` set.
    - `listMembers(teamId)` → join users for names/emails.
    - `findUserByEmail(email)` → `{ id }` or undefined.
  - `http/hooks.js`: on `CREATE` (record available), `addMember(record.id, req.userId, 'owner')`.
  - `http/controller.js`:
    - `listMine` → `TeamModel.listForMember(req.userId)`.
    - `getOne` (member-only) → `roleOf(req.userId, id)` undefined → `404`; else return the team. **Needed because the generated `GET /:id` is owner-scoped (`user_id = creator`), so a non-owner member could not fetch a team they belong to.** Register this custom `GET /:id` before `restGenerator`.
    - `addMember` (owner-only via `roleOf === 'owner'` else `403`) → resolve target: if `email` given, `findUserByEmail`; **unknown email → `404 'User not found'`**; if `user_id` given, use it. Then `addMember(teamId, targetId, role)`.
    - `removeMember` (owner-only) → cannot remove the **last owner** (count active owners; if removing would drop to 0 → `400`).
    - `listMembers` (member-only via `roleOf`).
  - `http/routes.js`: register custom routes BEFORE `restGenerator(TeamModel, router, teamHooks)`:
    `GET /` → `listMine`; `GET /:id` → `getOne`; `GET /:id/members`; `POST /:id/members`; `DELETE /:id/members/:userId`. Keep generated `POST /`, `PUT /:id`, `DELETE /:id` (owner-scoped is correct for mutate/delete).
  - `index.js`: export `{ Entity: { model: TeamModel, routes } }`.
- **PATTERN**: mirror `src/entities/categories/*` for the CRUD skeleton and `src/entities/vaults/http/{routes,controller}.js` for custom-routes-before-restGenerator + controller error style.
- **GOTCHA**: owner-only guard = `roleOf(req.userId, teamId) === 'owner'`. Custom `GET /` and `GET /:id` must register before `restGenerator` to shadow the owner-scoped generated handlers (which would otherwise hide teams the user is a member-but-not-owner of).
- **GOTCHA (team deletion / cascade)**: the generated `DELETE /:id` only soft-deletes the `teams` row (owner-scoped). Its `transactions`/`vaults`/`categories`/`team_members` rows are NOT cascaded — they become **unreachable** because `resolveContext` 404s on a soft-deleted team (via `isMember`/`teamExists`). Accepted for POC (orphaned-but-inaccessible, recoverable). Document in ADR-005; a future task can add explicit cascade or block deletion unless the team's balance is 0 and it has one member.
- **VALIDATE**: `for f in src/entities/teams/**/*.js; do node --check "$f"; done`

### UPDATE `src/entities/index.js` and `src/app.js`
- **IMPLEMENT**: Add `TeamsEntity` to the collection and a `{ path: '/teams', route: TeamsEntity.routes }` mount. Mount `resolveContext` on the team-capable routers: **categories, vaults, transactions, balance**. Simplest: `app.use('/categories', resolveContext, CategoriesEntity.routes)` etc. `teams` does NOT get `resolveContext` (it's managed via `team_members`, not context).
- **PATTERN**: current `routes.forEach` loop (app.js 21-28). Either special-case the four team-capable mounts with `resolveContext`, or add a `context: true` flag per route entry and conditionally insert the middleware.
- **GOTCHA**: middleware order — `express.json`, logger, `auth` (sets userId + default context), THEN routers. `resolveContext` must run after `auth` (needs `req.userId`).
- **VALIDATE**: `node --check src/app.js && node --check src/entities/index.js`

### UPDATE `transactions`, `vaults`, AND `categories` `db/fields.js`
- **IMPLEMENT**: add `teamScoped: true` to the `fields` object in `transactions/db/fields.js`, `vaults/db/fields.js`, AND `categories/db/fields.js`. Do NOT add `team_id` to `create`/`update` arrays (injected from context). `categoryHooks` needs NO change — it only validates `name`/`kind`.
- **GOTCHA**: with `teamScoped`, `categories` reads/writes scope by context exactly like transactions/vaults: `?team_id=T` → that team's categories; omitted → personal categories (`user_id AND team_id IS NULL`). Personal and team category sets are disjoint. The seeded default categories (seed.js) are personal (`team_id NULL`); a team starts with no categories until a member creates them in team context.
- **VALIDATE**: `node --check src/entities/transactions/db/fields.js src/entities/vaults/db/fields.js src/entities/categories/db/fields.js` (run per file).

### REFACTOR `src/entities/balance/db/queries.js` (context-scoped)
- **IMPLEMENT**: Change every helper to take `scope` ({ userId, teamId }) and build the WHERE clause from context:
  - `netWorthCents(scope)`: personal → `WHERE user_id = :userId AND team_id IS NULL AND deleted_at IS NULL`; team → `WHERE team_id = :teamId AND deleted_at IS NULL`.
  - `lockedCents(scope)`: join `vault_history` to `vaults`; filter vaults by context: personal → `v.user_id = :userId AND v.team_id IS NULL`; team → `v.team_id = :teamId`; always `v.deleted_at IS NULL`.
  - `vaultBalanceCents(scope, vaultId)`: `SUM(allocate)-SUM(withdraw)` for `vault_id = :vaultId` (context already authorized the vault upstream; you may keep a `user_id`-free sum, or include the context filter defensively).
  - `availableCents(scope)` = `netWorthCents(scope) - lockedCents(scope)`.
  - `get(scope)`: the API view — vaults list filtered by context; returns `{ total, available, vaults[], currency }`.
- **PATTERN**: keep `toDecimal`/`currency` usage. Mirror the existing CASE-sum SQL (lines 9-49).
- **GOTCHA**: every caller (transaction hooks, vault hooks, vault controller, balance route) now passes `scope`. The `vault_history` rows have a `user_id` (actor) that is irrelevant to balance — never filter vault balance by actor `user_id`; filter by the **vault's** context (via the join) or by `vault_id`.
- **VALIDATE**: `node --check src/entities/balance/db/queries.js`

### UPDATE `src/entities/transactions/http/hooks.js`
- **IMPLEMENT**: `assertSpendable(scope, deltaCents)` reading `availableCents(scope)`. Call sites pass `req.context` instead of `req.userId` (BEFORE_CREATE, BEFORE_UPDATE, BEFORE_DESTROY). `contribution`/`assertType` unchanged.
- **GOTCHA**: the invariant is now per-context — a team expense is bounded by the team's available, a personal expense by personal available. `req.context` is guaranteed set (auth default + resolveContext).
- **VALIDATE**: `node --check src/entities/transactions/http/hooks.js`

### UPDATE `src/entities/vaults/http/hooks.js`, `http/controller.js`, `db/history.js`
- **IMPLEMENT**:
  - hooks: `vaultBalanceCents(req.context, record.id)` in BEFORE_DESTROY.
  - controller: `requireVault` uses `VaultModel.findById(req.context, vaultId)` (so a vault is only reachable in its own context); `allocate` bounds by `availableCents(req.context)`; `withdraw` bounds by `vaultBalanceCents(req.context, vaultId)`; `history.add(req.userId, vaultId, action, cents)` — actor stays `req.userId`. `getHistory` uses `history.findByVault(vaultId)` after `requireVault`.
  - history: `add(userId, vaultId, action, cents)` unchanged (actor). `findByVault` can drop the `user_id` filter (scope by `vault_id` only) since the vault was authorized via context — OR keep signature and pass vault only. Update its one call site accordingly.
- **GOTCHA**: `vaultView` builds the response with `vaultBalanceCents(req.context, vault.id)`.
- **VALIDATE**: `node --check src/entities/vaults/http/hooks.js src/entities/vaults/http/controller.js src/entities/vaults/db/history.js` (per file).

### UPDATE `src/entities/balance/http/routes.js`
- **IMPLEMENT**: `queries.get(req.context)` instead of `req.userId`.
- **VALIDATE**: `node --check src/entities/balance/http/routes.js`

### UPDATE `src/db/seed.js` (Phase A portion — NO bcrypt)
- **IMPLEMENT**: Keep user-1 + categories. Add: `UPDATE users SET active=1, verified=1 WHERE id=1`; seed a team (id 1, `user_id=1`, name e.g. `'Household'`) and a `team_members` row (`team_id=1, user_id=1, role='owner'`) so team flows are testable under bypass. Use `INSERT OR IGNORE` for idempotency.
- **GOTCHA**: **Do NOT `require('bcryptjs')` here in Phase A** — the dep isn't installed until Phase B, so requiring it now crashes `node src/db/seed.js`. The `password_hash` line is added in the **Phase B** seed task below, after the dep exists. Insert order: user → team → team_members (FK `foreign_keys=ON`).
- **VALIDATE**: `rm -f data/balance.stage.db* && NODE_ENV=stage node src/db/migrate.js && NODE_ENV=stage node src/db/seed.js && NODE_ENV=stage node src/db/seed.js` (second seed must be a no-op).

### PHASE A integration validation
- **VALIDATE**: boot + curl sequence (see VALIDATION COMMANDS Level 4, Phase A).

### — PHASE B — (ADR-003 login)

### UPDATE `package.json`
- **IMPLEMENT**: add deps `bcryptjs` and `jsonwebtoken`. Install.
- **VALIDATE**: `npm install bcryptjs jsonwebtoken && node -e "require('bcryptjs');require('jsonwebtoken');console.log('deps ok')"`

### UPDATE `src/config/env.js`
- **IMPLEMENT**: load + export `jwtSecret` (JWT_SECRET), `jwtExpiresIn` (JWT_EXPIRES_IN, default `'7d'`), `authBypass` (`process.env.AUTH_BYPASS === 'true'`), `seedPassword` (SEED_PASSWORD). Validation: require `JWT_SECRET` whenever `authBypass !== true`. Keep existing required `PORT/DB_PATH/CURRENCY`.
- **GOTCHA**: `AUTH_BYPASS` must be ineffective outside `stage` (ADR-001/003). **Fail closed at BOTH layers:** (1) in `env.js` validation, `throw` if `authBypass === true && nodeEnv === 'prod'` (a misconfigured prod must not boot); (2) the middleware additionally ignores bypass unless `nodeEnv === 'stage'`. Update `.env.example` + document in README.
- **VALIDATE**: `NODE_ENV=stage node -e "console.log(require('./src/config/env'))"`

### CREATE `src/entities/auth/db/users.js` and `db/sessions.js`
- **IMPLEMENT**:
  - `users.js`: `findByEmail(email)` → row incl. `id, password_hash, active, verified` (no soft-deleted: `deleted_at IS NULL`).
  - `sessions.js`: `create(userId, ip, ua)` → inserts with `expires_at = issued_at` placeholder (schema requires NOT NULL), returns `lastInsertRowid`; `setExpiry(id, iso)` → `UPDATE ... SET expires_at = ?`; `findById(id)`; `revoke(id)` → set `revoked_at = now`. (Login inserts → signs token with the new id as `jti` → `setExpiry` from the token's `exp`.)
- **VALIDATE**: `node --check src/entities/auth/db/users.js src/entities/auth/db/sessions.js`

### CREATE `src/entities/auth/http/controller.js` + `routes.js` + `index.js`
- **IMPLEMENT** per ADR-003:
  - `login`: body `{ email, password }`. `findByEmail`; if missing → 401. `bcrypt.compareSync(password, password_hash)`; if false → 401. Require `active && verified`; else 401 (generic message — don't leak which). **Order to avoid a chicken-and-egg with `jti`:** insert the session row first (with a placeholder/expires computed below) to get `sessionId`, then sign `jwt.sign({ sub: user.id, email, jti: sessionId }, jwtSecret, { expiresIn: jwtExpiresIn })`, then set the session's `expires_at` from the token's own `exp` claim (`new Date(jwt.decode(token).exp * 1000).toISOString()`) so the row and token never disagree. Respond `{ token }`. (Alternatively compute `expires_at` up front from `jwtExpiresIn` with a small parser, but deriving from `exp` is the single-source approach.)
  - `logout`: the protected `auth` middleware already validated the token and set `req.sessionId` (= `jti`). Controller calls `sessions.revoke(req.sessionId)` → `204`. (No re-decode needed if the middleware exposes `req.sessionId`.)
  - `routes.js`: export `{ publicRoutes }` (Router with `POST /login`) and `{ protectedRoutes }` (Router with `POST /logout`).
- **GOTCHA**: login MUST be public (mounted before global auth). Logout MUST be protected (needs a valid token to know which session). Generic 401 for all failure modes (bad creds / inactive / unverified).
- **VALIDATE**: `node --check src/entities/auth/http/controller.js src/entities/auth/http/routes.js src/entities/auth/index.js`

### REWRITE `src/middleware/auth.js` (ADR-003 validation)
- **IMPLEMENT**:
  - Bypass only when `config.authBypass === true && config.nodeEnv === 'stage'`: set `req.userId = 1`, `req.context = { userId:1, teamId:null }`, `next()`. (Prod with bypass already failed to boot via env.js; the `=== 'stage'` check is the second guard.)
  - Else: read `Authorization: Bearer <token>` (missing/malformed → 401); `jwt.verify(token, jwtSecret)` (HS256) → `{ sub, jti }`; `sessions.findById(jti)`; require row exists, `user_id === sub`, `revoked_at IS NULL`, `expires_at > now`; else 401. Set `req.userId = sub`, `req.context = { userId: sub, teamId: null }`, and **always** `req.sessionId = jti` (logout depends on it). `next()`.
- **GOTCHA**: this is the ONLY identity boundary (ADR-001). Downstream code unchanged. `+1 indexed session query per request` is accepted (ADR-003). Catch `jwt.verify` errors → 401.
- **VALIDATE**: `node --check src/middleware/auth.js`

### UPDATE `src/app.js` (mount auth routes)
- **IMPLEMENT**: mount `AuthEntity.publicRoutes` at `/auth` BEFORE `app.use(auth)`; mount `AuthEntity.protectedRoutes` at `/auth` AFTER `app.use(auth)`.
- **VALIDATE**: `node --check src/app.js`

### UPDATE `src/db/seed.js` (Phase B — add the bcrypt hash)
- **IMPLEMENT**: now that `bcryptjs` is installed, set user 1 `password_hash = bcrypt.hashSync(config.seedPassword, 10)` (active/verified were already set in the Phase A seed task; re-asserting them is harmless). Requires `SEED_PASSWORD` in env.
- **VALIDATE**: `NODE_ENV=stage node src/db/seed.js` then assert hash present (see Level 4).

### DOCS (after both phases work)
- **IMPLEMENT**:
  - CREATE `.claude/ADR/ADR-005-multi-tenant-shared-finance.md` (template `ADR-000-template.md`): decision = transactions/vaults/categories carry nullable `team_id`; context via `?team_id=`; `team_members` is the isolation control and membership (not row ownership) is the authorization; balance/invariant per-context; personal and team category sets are disjoint; retires PRD "single-user" (§1/§3). North star: RBAC roles richer than owner/member.
  - UPDATE `.claude/ADR/ADR-003-session-validation.md` status → **Accepted**.
  - UPDATE `.claude/ADR/README.md` index (add ADR-005).
  - UPDATE `PRD.md` (§1, §3, §5 data model, §6 per-context balance, §7 API surface incl. `?team_id=`, `/teams`, `/auth`), `ARCHITECTURE.md` (ER: teams/team_members/sessions + team_id; balance-flow per context; lifecycle: resolveContext + auth), `CLAUDE.md` (key files + context model + auth).
- **VALIDATE**: manual doc review; `ls .claude/ADR/ADR-005-*`.

---

## TESTING STRATEGY

No test runner exists (POC). Validation is **syntax checks + a scripted curl smoke flow** against a throwaway stage DB.

### Unit-ish (smoke) checks
- `node --check` every changed/new file.
- `node -e` requires for new modules to catch load-time errors and circular deps.

### Integration (curl flow) — Phase A (under AUTH_BYPASS)
Seeded: user 1, team 1 (owner = user 1).
1. Personal income → personal balance reflects it; team balance does not.
2. Team income (`?team_id=1`) → team balance reflects it; personal does not.
3. Personal expense beyond personal available → `400`. Team allocate beyond team available → `400`.
4. `GET /transactions` (no param) returns only personal; `?team_id=1` returns only team rows.
5. `?team_id=<not-a-member>` → `403`.
6. Categories: `POST /categories?team_id=1` creates a team category; `GET /categories` (personal) does NOT list it; `GET /categories?team_id=1` does. Personal categories never appear in team context.

### Integration (curl flow) — Phase B
6. `POST /auth/login` good creds → `{ token }`; bad creds/inactive/unverified → `401`.
7. Authed request with token → works; after `POST /auth/logout` → same token now `401` (session revoked).
8. `AUTH_BYPASS=true` (stage) bypasses; with `NODE_ENV=prod` bypass is ignored.

### Edge cases to verify
- Personal vs team leakage across ALL three team-scoped entities (transactions, vaults, categories): a personal row never appears in team context and vice-versa (the `team_id IS NULL` predicate).
- `team_id` cannot be forged via request **body** (must be injected from context only) — for transactions, vaults, and categories.
- Vault deletion blocked unless its context balance is 0.
- Allocate/withdraw scoped to the vault's context; cross-context vault id → `404`.
- Membership removal: cannot remove the last owner.
- Seed idempotency (run twice, no errors).
- Fresh DB: `rm -f data/*.db*` then migrate + seed produces the new schema cleanly.

---

## VALIDATION COMMANDS

### Level 1: Syntax & Style
```bash
# every JS file parses
find src -name '*.js' -exec node --check {} \;
```

### Level 2: Module load (circular-dep / require check)
```bash
NODE_ENV=stage node -e "require('./src/app'); console.log('app loads')"
NODE_ENV=stage node -e "require('./src/entities/teams/db/members'); require('./src/entities/balance/db/queries'); console.log('modules load')"
```

### Level 3: Fresh migrate + seed (data disposable)
```bash
rm -f data/balance.stage.db*
NODE_ENV=stage node src/db/migrate.js
NODE_ENV=stage node src/db/seed.js && NODE_ENV=stage node src/db/seed.js   # seed idempotent
```

### Level 4: Manual API validation
Boot: `NODE_ENV=stage AUTH_BYPASS=true npm start` (separate shell). Base `http://localhost:3000`.

**Phase A:**
```bash
# personal income
curl -s -XPOST localhost:3000/transactions -H 'Content-Type: application/json' -d '{"type":"income","amount":2000}'
# team income
curl -s -XPOST 'localhost:3000/transactions?team_id=1' -H 'Content-Type: application/json' -d '{"type":"income","amount":500}'
# balances differ by context
curl -s localhost:3000/balance                 # personal: total 2000
curl -s 'localhost:3000/balance?team_id=1'      # team: total 500
# listing scoped
curl -s localhost:3000/transactions             # personal only
curl -s 'localhost:3000/transactions?team_id=1'  # team only
# non-member team → 403
curl -s -o /dev/null -w '%{http_code}\n' 'localhost:3000/balance?team_id=999'
# personal overspend → 400
curl -s -o /dev/null -w '%{http_code}\n' -XPOST localhost:3000/transactions -H 'Content-Type: application/json' -d '{"type":"expense","amount":999999}'
```

**Phase B** (boot WITHOUT bypass: `NODE_ENV=stage AUTH_BYPASS=false JWT_SECRET=devsecret npm start`):
```bash
TOKEN=$(curl -s -XPOST localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"user@balance.local","password":"'"$SEED_PASSWORD"'"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')
curl -s localhost:3000/balance -H "Authorization: Bearer $TOKEN"      # 200
curl -s -XPOST localhost:3000/auth/logout -H "Authorization: Bearer $TOKEN" -o /dev/null -w '%{http_code}\n'  # 204
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/balance -H "Authorization: Bearer $TOKEN"            # 401 (revoked)
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/balance                                              # 401 (no token)
```

### Level 5: DB assertions
```bash
NODE_ENV=stage node -e "const db=require('./src/config/db');console.log(db.prepare('PRAGMA table_info(transactions)').all().map(c=>c.name));console.log(db.prepare('SELECT id,active,verified,password_hash IS NOT NULL hash FROM users').all());console.log(db.prepare('SELECT * FROM team_members').all())"
```

---

## ACCEPTANCE CRITERIA

- [ ] `transactions` and `vaults` carry a nullable `team_id`; `team_id` is injected from context, never accepted from the request body.
- [ ] `?team_id=T` switches context on `/transactions`, `/vaults`, `/balance`; omitted = personal `(user_id AND team_id IS NULL)`.
- [ ] Membership enforced: non-member `team_id` → `403`; only members read/write team data.
- [ ] Balance (`total`/`available`/vaults) and the `available ≥ 0` invariant are computed per context; personal and team are independent and non-leaking.
- [ ] `teams` + `team_members` CRUD/management works (create team auto-adds owner; add/remove members; list my teams).
- [ ] Categories are team-scoped like transactions/vaults: `?team_id=T` creates/lists/updates that team's categories; personal categories (`team_id NULL`) never appear in team context and vice-versa.
- [ ] Phase B: `POST /auth/login` issues a JWT only for active+verified users; `POST /auth/logout` revokes the session (token dead immediately); `AUTH_BYPASS` works in stage and is inert in prod.
- [ ] Migrate + seed are idempotent and upgrade an existing DB via `ALTER` guards.
- [ ] All `node --check` and Level 2 load checks pass; curl flows return expected codes.
- [ ] ADR-005 written, ADR-003 → Accepted, PRD/ARCHITECTURE/CLAUDE updated.

## COMPLETION CHECKLIST

- [ ] Phase A tasks complete + validated before Phase B started.
- [ ] All validation levels pass with zero errors.
- [ ] No `entity.method(req.userId, …)` call sites remain (all pass `scope`/`req.context`).
- [ ] Manual curl flows (A + B) confirm context isolation, 403/401/400 behaviors, real logout.
- [ ] Docs/ADRs updated.
- [ ] Atomic commits per phase (`feat:`), conventional tags.

## NOTES

**Design decisions / trade-offs:**
- **Context object over a third positional arg.** Replacing `userId` with `scope = { userId, teamId }` keeps every model method signature uniform (even non-team entities), at the cost of touching all call sites once. Cleaner than threading an optional `teamId` everywhere.
- **`team_id` from context only.** Prevents forging a team row by posting `team_id` in the body — the single most important isolation guarantee alongside the `team_members` check.
- **Membership is the authorization, not `team_id`.** `resolveContext` verifies `team_members` on every team-scoped request; a row's `team_id` alone never grants access.
- **Vault balance is context-independent given a vault id**, but the vault is only *reachable* within its own context (controller `findById(scope, id)`), so cross-context access 404s before any math.
- **Migration pragmatism.** Data is disposable (product owner confirmed), so there's no ALTER/upgrade machinery — fresh DBs get the full shape from `schema.sql`; recreate with `rm -f data/*.db*` + migrate + seed.
- **Categories are team-scoped** (revised decision): same `teamScoped` treatment as transactions/vaults — personal and team category sets are disjoint, so a team manages its own categories and they're never shared with personal. Team transactions reference team categories. Seeded defaults remain personal.
- **Auth boundary unchanged (ADR-001).** Phase B touches only `src/middleware/auth.js` + new `/auth` routes + env; routes/hooks/queries never read identity except via `req.userId` / `req.context`.

**Open risks:**
- The `scope` refactor is broad — a missed call site silently scopes wrong. The Level 2 load check + curl isolation tests are the safety net (no unit tests).
- `foreign_keys = ON` means seed/insert ordering matters (users → teams → team_members).
- `AUTH_BYPASS` foot-gun: inert outside `stage` — enforced at boot (env.js throws in prod) AND in middleware.

**Self-review hardening (2026-06-27) — applied to this plan:**
1. `isMember`/`teamExists` exclude soft-deleted teams; `resolveContext` returns 404 (no/deleted team) vs 403 (not a member).
2. Teams: added member-only `GET /:id` and `getOne` (the generated one is owner-scoped, hiding teams from non-owner members); `addMember` unknown email → 404; owner guard via `roleOf`; documented team-deletion non-cascade (orphaned-but-inaccessible, POC-accepted).
3. Phase A `seed.js` must NOT `require('bcryptjs')` (not installed until Phase B) — the hash moves to the Phase B seed task.
4. Session `expires_at` derived from the JWT's own `exp` (insert session → sign with `jti` → `setExpiry`), eliminating ad-hoc `'7d'` parsing and row/token drift.
5. `AUTH_BYPASS` fails closed at boot (env.js throws if bypass && prod) plus the middleware `=== 'stage'` guard.
6. Corrected the SQLite FK claim — forward refs are fine at `CREATE`; ordering only matters at INSERT/seed.
7. Middleware always sets `req.sessionId` so `logout` can revoke without re-decoding.

**Confidence score (one-pass): 8/10** — design fully specified, pattern-aligned, and self-review-hardened against the real isolation/auth edge cases. The residual risk is the breadth of the `scope` refactor with no automated tests; the per-task `node --check` + curl isolation flow is the mitigation.
