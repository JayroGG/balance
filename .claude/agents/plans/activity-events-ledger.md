# Feature: Activity events ledger + `GET /events` feed

The following plan should be complete, but validate documentation and codebase patterns and task
sanity before you start implementing. Pay special attention to naming of existing utils, models,
and hook constants. Import from the right files (cross-entity = direct `db/model.js` imports).

## Feature Description

An **append-only `events` ledger** that records every meaningful mutation (transactions, vaults,
shopping lists/items, team management) with actor, context, and a display snapshot — plus a
read-only **`GET /events`** feed endpoint, context-scoped like every other financial resource.
This is the activity log for the mobile app ("Ana added an expense of 12.50", "Luis checked Milk
off Groceries") and the designed seam for **remote push notifications later**: push becomes a
delivery channel that reads the same ledger (see ADR-009), not a redesign.

## User Story

As a team member sharing finances,
I want to see a feed of what my teammates did (transactions, vault moves, list checkouts),
So that I stay aware of shared money activity without real-time push infrastructure.

## Problem Statement

Team mutations are invisible to other members unless they diff the data themselves. The main
incentive is "notify me when another user books a transaction" — but remote push requires a paid
Apple Developer account. The events ledger delivers the awareness value now (polled feed +
client-side local notifications) and is the prerequisite for push later either way.

## Solution Statement

A new `events` table (append-only, immutable — same species as `vault_history`), written from the
**after-hooks** (`CREATE`/`UPDATE`/`DESTROY`) of existing entities and from the custom controllers
(allocate/withdraw, checkout, team management). One read endpoint `GET /events` mounted with
`context: true`, scoped exactly like transactions (`?team_id=` → team feed; omitted → personal),
newest-first, with `since_id`/`limit` for incremental polling.

## Feature Metadata

**Feature Type**: New Capability
**Estimated Complexity**: Medium
**Primary Systems Affected**: schema, new `events` entity, hooks of transactions/vaults/shopping-lists/shopping-list-items, vaults + shopping-lists + teams controllers, app wiring, test harness
**Dependencies**: none new (better-sqlite3, express — already present)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ THESE BEFORE IMPLEMENTING

- `src/db/schema.sql` (lines 90-100) — `vault_history`: the append-only-ledger table shape to mirror (no `updated_at`/`deleted_at`)
- `src/utils/modelGenerator/index.js` (lines 34-50) — `scopeClause`/`rowScope`: the context-scoping SQL the events `listFeed` must replicate (team / personal / admin / admin `targetUserId`)
- `src/utils/restGenerator/handlers/createHandler.js` (lines 14-15), `updateHandler.js` (lines 17-18), `destroyHandler.js` (lines 12-14) — where the after-hooks (`CREATE`/`UPDATE`/`DESTROY`) fire and what payload they receive (`record`, `previous`, `req`)
- `src/constants/hooks.js` — hook type constants (already includes `CREATE`, `UPDATE`, `DESTROY`)
- `src/entities/transactions/http/hooks.js` (lines 29-57) — the switch shape to extend; note it currently only handles `BEFORE_*` cases
- `src/entities/vaults/http/controller.js` (lines 39-71) — `allocate`/`withdraw`: log calls go right after `history.add(...)`; `vault` is in scope with `team_id` and `name`
- `src/entities/vaults/http/hooks.js` — extend with `CREATE`/`DESTROY` cases
- `src/entities/vaults/db/history.js` — minimal append-only db module style (`add`, positional insert)
- `src/entities/shopping-lists/http/controller.js` (lines 15-18, 20-54) — `commit` db.transaction (event insert goes INSIDE it) and the manual `transactionHooks({ type: BEFORE_CREATE, ..., req: { context: txScope } })` call — see GOTCHA below
- `src/entities/shopping-lists/http/hooks.js` — extend with `CREATE`/`DESTROY` cases (DESTROY already cascades items)
- `src/entities/shopping-list-items/http/hooks.js` (lines 12-19, 37-75) — items have **no `team_id`**; the parent list is resolved via `ShoppingListModel.findById(req.context, ...)` (already imported in this file)
- `src/entities/shopping-list-items/db/model.js` — the sanctioned **hand-written model** precedent (events model is hand-written too, for the same reason: its scoping/ordering doesn't fit `modelGenerator`)
- `src/entities/teams/http/controller.js` (lines 45-59, 62-80, 83-97, 112-124) — `addMember`/`changeRole`/`update`/`removeMember`: log call sites; note teams routes mount **without** `resolveContext`, so use `req.userId` + the `teamId` param directly
- `src/entities/balance/http/routes.js` + `src/entities/balance/index.js` — the read-only entity pattern (custom `GET /` route, no restGenerator, `Entity = { routes }`)
- `src/middleware/resolveContext.js` — how `req.context` gets `teamId`/`role`/`isAdmin`/`targetUserId`; membership 403 happens here, so the feed route needs no extra gate
- `src/app.js` (lines 39-50) — the `routes[]` array; events mounts with `context: true`
- `src/entities/index.js` — entity registry to extend
- `test/helpers/db.js` (lines 12-15) — `TABLES` wipe list (add `events`), `seedUser`
- `test/integration-test/shopping-lists/shopping-lists.test.js` — integration test style: `wipeAll` + `seedUser` + `login` + `api(token)` per test, multi-user team scenarios
- `src/db/migrate.js` — `CREATE TABLE IF NOT EXISTS` re-run covers new tables; **no ALTER needed** (schema.sql is also applied on server boot, so deploys pick the table up automatically)

### New Files to Create

- `src/entities/events/constants.js` — `ENTITY_NAME = 'events'`
- `src/entities/events/db/fields.js` — `{ filterFields: ['entity', 'action'] }` (documentation/consistency; model is hand-written)
- `src/entities/events/db/model.js` — `EventModel = { log, listFeed }`
- `src/entities/events/http/routes.js` — custom `GET /` only (mirror balance)
- `src/entities/events/index.js` — `Entity = { model: EventModel, routes }`
- `test/integration-test/events/events.test.js` — integration suite
- `.claude/ADR/ADR-009-activity-events-ledger.md` — decision record (+ index row in `.claude/ADR/README.md`)

> `docs/react-native-activity-feed-update.md` (the RN agent's request/contract) already exists —
> written at planning time. If implementation deviates from it, **update that brief** in the docs task.

### Patterns to Follow

**Append-only ledger insert** (mirror `src/entities/vaults/db/history.js:5-8`):

```js
const log = ({ userId, teamId, entity, entityId, action, summary }) =>
  db.prepare(
    `INSERT INTO events (user_id, team_id, entity, entity_id, action, summary)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(userId, teamId ?? null, entity, entityId, action, summary ? JSON.stringify(summary) : null);
```

**Context scope SQL** (replicate `modelGenerator` `scopeClause`, `src/utils/modelGenerator/index.js:34-46`, with an `e.` alias):

```js
// team feed: e.team_id = ?           (membership already verified by resolveContext)
// personal:  e.user_id = ? AND e.team_id IS NULL
// admin + teamId       -> team feed of any team
// admin + targetUserId -> that user's personal feed (?user_id=)
```

**Error shape**: `Object.assign(new Error(msg), { status })` / `e.status = 400` — as everywhere.

**Cross-entity import rule**: `require('../../events/db/model')` — never via the entity `index.js`.

**Hook switch extension** (transactions example — same shape for the others):

```js
case CREATE:
  EventModel.log({ userId: req.userId, teamId: record.team_id ?? null,
    entity: 'transaction', entityId: record.id, action: 'created',
    summary: { type: record.type, amount: record.amount, description: record.description } });
  return;
```

---

## DESIGN (locked for this plan)

### Schema

```sql
-- Append-only activity ledger (ADR-009). Immutable: no updated_at/deleted_at, no edits.
-- summary is a JSON display snapshot; amounts inside it are DECIMALS (client-ready).
CREATE TABLE IF NOT EXISTS events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),   -- actor (who did it; admin acts as themselves)
  team_id    INTEGER REFERENCES teams(id),            -- NULL = personal context
  entity     TEXT    NOT NULL,
  entity_id  INTEGER NOT NULL,
  action     TEXT    NOT NULL,
  summary    TEXT,
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_events_team ON events(team_id);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
```

### Event catalog (MVP)

| entity | action | emitted from | summary |
|---|---|---|---|
| `transaction` | `created` / `updated` / `deleted` | transactions hooks `CREATE`/`UPDATE`/`DESTROY` | `{ type, amount, description }` (post-write `record`; on `updated` use the new `record`) |
| `vault` | `created` / `deleted` | vaults hooks `CREATE`/`DESTROY` | `{ name }` |
| `vault` | `allocated` / `withdrawn` | vaults controller, after `history.add` | `{ name, amount }` (`toDecimal(amountCents)`) |
| `shopping_list` | `created` / `deleted` | lists hooks `CREATE`/`DESTROY` | `{ name }` |
| `shopping_list` | `checked_out` | checkout controller, **inside** the atomic `commit` | `{ name, amount, transaction_id }` |
| `shopping_list_item` | `created` / `updated` / `deleted` | item hooks `CREATE`/`UPDATE`/`DESTROY` | `{ list_id, name, checked }` (`checked: !!record.checked`) |
| `team` | `updated` | teams controller `update` | the applied patch, e.g. `{ name?, color? }` |
| `team` | `member_added` / `member_removed` / `role_changed` | teams controller | `{ user_id }` (+ `role` for added/changed); `entity_id` = **team id** |

**Deliberate omissions** (note in ADR, trivial to add later): categories CRUD (low-value noise),
vault rename (`UPDATE`), list rename (`UPDATE`), team create/delete (no audience: create precedes
membership, delete removes feed access).

**Actor/context rules:**
- `user_id` (actor) = `req.userId` — always the human who acted, admin included.
- `team_id` = the **affected record's** `team_id` (`record.team_id ?? null`), not the caller's
  active context — they match for generated handlers, but the record is authoritative (checkout
  books into the list's own context). For items: the **parent list's** `team_id`. For team
  management: the `teamId` route param.
- Accepted edge case (record in ADR): an admin editing another user's *personal* data logs an
  event keyed to the admin (actor) — the target user's personal feed won't show it. Personal
  feeds are "my own actions" by design.

**Failure semantics:** `EventModel.log` is a plain synchronous insert with **no try/catch** —
fail-loud (an insert failure means the DB is broken; swallowing it would hide real corruption).
The checkout event participates in the existing `db.transaction`, so event + expense + freeze
land atomically.

### `GET /events` contract

Mounted with `context: true` — `?team_id=` switches context exactly like `/transactions`
(membership 403 / not-found 404 come from `resolveContext`; guests may read — reads are open to
all roles per ADR-005; admin `?user_id=` personal targeting works via `targetUserId`).

Query params (beyond `team_id`):
- `entity`, `action` — optional equality filters.
- `since_id` — optional; only events with `id > since_id` (incremental poll / unread count).
- `limit` — optional; default **50**, max **200**.
- `since_id`/`limit` must be positive integers → else `400` (boundary validation only).

Response `200`, newest first (`ORDER BY e.id DESC`), `summary` parsed back to an object,
`actor_email` joined from `users`:

```json
[
  { "id": 42, "user_id": 2, "actor_email": "ana@test.local", "team_id": 5,
    "entity": "transaction", "entity_id": 77, "action": "created",
    "summary": { "type": "expense", "amount": 12.5, "description": "Pizza" },
    "created_at": "2026-07-14T18:00:00Z" }
]
```

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation — table + events entity (write + read paths)
### Phase 2: Emitters — wire hooks and controllers
### Phase 3: Integration — registry, app mount, test harness
### Phase 4: Testing & docs — integration suite, ADR-009, doc set, RN brief sync

---

## STEP-BY-STEP TASKS

### UPDATE `src/db/schema.sql`

- **IMPLEMENT**: Append the `events` DDL + two indexes from DESIGN above, after `shopping_list_items`.
- **PATTERN**: `vault_history` block (`src/db/schema.sql:90-100`) — comment style included.
- **GOTCHA**: No `updated_at`/`deleted_at` — immutable ledger. `migrate.js` needs **no change** (new table, `IF NOT EXISTS`).
- **VALIDATE**: `cd /Users/jayro/Dev/Node/Projects/balance && NODE_ENV=stage npm run migrate && sqlite3 data/balance.stage.db '.schema events'`

### CREATE `src/entities/events/constants.js`

- **IMPLEMENT**: `ENTITY_NAME = 'events'`.
- **PATTERN**: `src/entities/transactions/constants.js` (verbatim shape).
- **VALIDATE**: `node -e "console.log(require('./src/entities/events/constants').ENTITY_NAME)"`

### CREATE `src/entities/events/db/fields.js`

- **IMPLEMENT**: `{ filterFields: ['entity', 'action'] }` with a comment that the model is hand-written (scoped + ordered feed doesn't fit `modelGenerator`) and this file documents the query surface.
- **PATTERN**: `src/entities/shopping-list-items/db/fields.js`.
- **VALIDATE**: `node -e "require('./src/entities/events/db/fields')"`

### CREATE `src/entities/events/db/model.js`

- **IMPLEMENT**: Hand-written `EventModel`:
  - `log({ userId, teamId, entity, entityId, action, summary })` — insert per Patterns above. Synchronous, no try/catch.
  - `listFeed(scope, { entity, action, since_id, limit })` — build WHERE from the scope rules in DESIGN (replicate `scopeClause` semantics with `e.` alias), add optional `e.entity = ?` / `e.action = ?` / `e.id > ?`, `JOIN users u ON u.id = e.user_id`, select `e.*, u.email AS actor_email`, `ORDER BY e.id DESC LIMIT ?`. Parse `summary` with `JSON.parse` when non-null. **No `deleted_at` filter** (column doesn't exist).
- **PATTERN**: hand-written model: `src/entities/shopping-list-items/db/model.js`; scope SQL: `src/utils/modelGenerator/index.js:34-46`; append-only insert: `src/entities/vaults/db/history.js:5-8`.
- **IMPORTS**: only `require('../../../config/db')` (+ fields for `filterFields` export if desired). Zero circular-dep risk — every emitter imports this file.
- **GOTCHA**: `summary` amounts are **decimals** (callers pass display-ready values); no `moneyFields` machinery here.
- **VALIDATE**: `node -e "const {EventModel}=require('./src/entities/events/db/model'); console.log(typeof EventModel.log, typeof EventModel.listFeed)"`

### CREATE `src/entities/events/http/routes.js`

- **IMPLEMENT**: Router with a single `GET /`: parse `entity`, `action`, `since_id`, `limit` from `req.query`; validate `since_id`/`limit` as positive integers (`400` via `Object.assign(new Error(...), { status: 400 })`), clamp `limit` to `Math.min(limit ?? 50, 200)`; respond `res.json(EventModel.listFeed(req.context, { ... }))`.
- **PATTERN**: `src/entities/balance/http/routes.js` (read-only entity — no restGenerator, no controller file needed for one handler).
- **GOTCHA**: No RBAC gate — reads are open to all roles; `resolveContext` already 403s non-members. Do **not** mount `restGenerator` (would expose POST/PUT/DELETE on an immutable ledger).
- **VALIDATE**: `node -e "require('./src/entities/events/http/routes')"`

### CREATE `src/entities/events/index.js`

- **IMPLEMENT**: `Entity = { model: EventModel, routes }`.
- **PATTERN**: `src/entities/shopping-lists/index.js`.
- **VALIDATE**: `node -e "require('./src/entities/events')"`

### UPDATE `src/entities/index.js` + `src/app.js`

- **IMPLEMENT**: Register `EventsEntity` in the registry; add `{ path: '/events', route: EventsEntity.routes, context: true }` to the `routes[]` array in `app.js`.
- **PATTERN**: `src/app.js:39-47` (shopping-lists rows).
- **VALIDATE**: `node -e "require('./src/app')" && echo app-loads`

### UPDATE `src/entities/transactions/http/hooks.js`

- **IMPLEMENT**: Import `CREATE`, `UPDATE`, `DESTROY` constants + `{ EventModel } = require('../../events/db/model')`. Add the three cases logging `transaction` events per the catalog (`UPDATE` case logs the new `record`; `DESTROY` logs the deleted `record`).
- **PATTERN**: hook-case shape in Patterns above; existing switch `src/entities/transactions/http/hooks.js:29-57`.
- **GOTCHA**: The checkout controller invokes this hook **manually with only `BEFORE_CREATE`** and a fake `req = { context: txScope }` that has **no `userId`** (`src/entities/shopping-lists/http/controller.js:50`). The after-cases never fire on that path — correct (checkout logs its own `checked_out` event; no double logging). Do not "fix" that call site.
- **VALIDATE**: `npm test -- --runInBand test/integration-test/balance` (existing invariants still green)

### UPDATE `src/entities/vaults/http/hooks.js` + `src/entities/vaults/http/controller.js`

- **IMPLEMENT**:
  - hooks: add `CREATE` (`vault` / `created` / `{ name: record.name }`) and `DESTROY` (`deleted`) cases.
  - controller: after each `history.add(...)` (`controller.js:51` and `:68`), log `allocated` / `withdrawn` with `teamId: vault.team_id ?? null`, `summary: { name: vault.name, amount: toDecimal(amountCents) }` (`toDecimal` already imported).
- **PATTERN**: existing hooks switch `src/entities/vaults/http/hooks.js:6-22`.
- **VALIDATE**: `npm test -- --runInBand test/integration-test/balance`

### UPDATE `src/entities/shopping-lists/http/hooks.js` + `http/controller.js`

- **IMPLEMENT**:
  - hooks: add `CREATE` (`shopping_list` / `created` / `{ name: record.name }`) and extend the existing `DESTROY` case (after the cascade line) with a `deleted` event.
  - controller: inside the `commit` db.transaction (`controller.js:15-18`), after `markPurchased`, log `checked_out` with `userId` = the **caller's** id, `teamId: list.team_id ?? null`, `entityId: listId`, `summary: { name: list.name, amount: Number(amount), transaction_id: tx.id }`. Thread the needed values (`req.userId`, `list`) into `commit`'s parameters.
- **GOTCHA**: The event must be **inside** the transaction (atomic with expense + freeze). Actor is `req.userId`, but the expense's `txScope.userId` is `list.user_id` — don't conflate them.
- **VALIDATE**: `npm test -- --runInBand test/integration-test/shopping-lists`

### UPDATE `src/entities/shopping-list-items/http/hooks.js`

- **IMPLEMENT**: Add `CREATE`/`UPDATE`/`DESTROY` cases. Resolve the parent list for `team_id`: `const list = ShoppingListModel.findById(req.context, record.list_id)` (import already present). Log `shopping_list_item` events with `summary: { list_id: record.list_id, name: record.name, checked: !!record.checked }`.
- **GOTCHA**: After-hooks receive `record` only — the `requireList` result from the BEFORE case is out of scope; re-resolve. `record.checked` is `0/1` from SQLite — normalize with `!!`.
- **VALIDATE**: `npm test -- --runInBand test/integration-test/shopping-lists`

### UPDATE `src/entities/teams/http/controller.js`

- **IMPLEMENT**: Import `{ EventModel } = require('../../events/db/model')`. Log after each successful mutation:
  - `addMember` (after `members.addMember`): `team` / `member_added` / `entityId: teamId` / `{ user_id: targetId, role }`
  - `changeRole` (after `members.setRole`): `role_changed` / `{ user_id: targetId, role }`
  - `removeMember` (after `members.removeMember`): `member_removed` / `{ user_id: targetId }`
  - `update` (after `TeamModel.updateById`): `updated` / summary = the `patch` object
  - All with `userId: req.userId, teamId`.
- **GOTCHA**: Teams routes mount **without** `resolveContext` — there is no `req.context` here; pass `teamId` explicitly. Do not log team create/delete (deliberate omission).
- **VALIDATE**: `npm test -- --runInBand test/integration-test/teams`

### UPDATE `test/helpers/db.js`

- **IMPLEMENT**: Add `'events'` as the **first** entry of `TABLES` (references `users` + `teams`; child→parent order).
- **VALIDATE**: `npm test -- --runInBand test/integration-test/auth`

### CREATE `test/integration-test/events/events.test.js`

- **IMPLEMENT**: Integration suite per TESTING STRATEGY below.
- **PATTERN**: `test/integration-test/shopping-lists/shopping-lists.test.js` (header comment, `wipeAll`+`seedUser`+`login` per test, multi-user team blocks).
- **VALIDATE**: `npm test -- --runInBand test/integration-test/events`

### CREATE `.claude/ADR/ADR-009-activity-events-ledger.md` + UPDATE `.claude/ADR/README.md`

- **IMPLEMENT**: ADR: append-only actor-keyed events ledger written from after-hooks/controllers; polled feed as MVP; **north star = remote push via Expo Push Service** (expo-notifications + `expo-server-sdk`, APNs `.p8` via EAS — blocked only by the paid Apple Developer account; OneSignal rejected as redundant on Expo). Record: decimals-in-summary, fail-loud logging, checkout atomicity, deliberate omissions, admin-personal-edit edge case, events survive team emptiness checks (`isEmpty` unchanged — events don't block team deletion). Add index row (status Accepted).
- **PATTERN**: `.claude/ADR/ADR-008-shopping-lists-checkout.md` + `ADR-000-template.md`.
- **VALIDATE**: `grep -c 'ADR-009' .claude/ADR/README.md` → `1`

### UPDATE `PRD.md`, `ARCHITECTURE.md`, `CLAUDE.md`, `README.md`, RN brief

- **IMPLEMENT**:
  - `PRD.md`: locked-decisions row; `events` in §5 Data Model; new §6c-style section "Activity events (ADR-009)"; `GET /events` in §7 API surface.
  - `ARCHITECTURE.md`: `events` in the Mermaid ER diagram + directory/file map row.
  - `CLAUDE.md`: architecture bullet ("Activity events (ADR-009): …") + key-files row.
  - `README.md`: endpoint row.
  - `docs/react-native-activity-feed-update.md`: written at planning time as the FE request — **verify it matches what shipped**; fix any contract drift and flip its status line from "planned contract" to "work done".
- **VALIDATE**: `grep -l '/events' PRD.md README.md CLAUDE.md ARCHITECTURE.md docs/react-native-activity-feed-update.md`

---

## TESTING STRATEGY

### Integration Tests (`test/integration-test/events/events.test.js`)

- **Personal feed lifecycle**: create/update/delete a transaction → 3 events newest-first; assert `entity`, `action`, `actor_email`, decimal `summary.amount`, `team_id: null`.
- **Vaults**: create vault, allocate, withdraw, delete → `created`/`allocated`/`withdrawn`/`deleted`; allocate summary carries decimal amount + vault name.
- **Shopping flow**: list created → item created → item checked (`updated`, `checked: true`) → checkout (`checked_out` with `transaction_id`) → purchased-list delete blocked? (no — delete allowed; assert `deleted` event and cascade unaffected).
- **Checkout atomicity**: failing checkout (insufficient available) logs **no** event (assert feed length unchanged).
- **Team scoping**: owner + member + guest team; member's transaction appears in everyone's `?team_id=` feed with the member as actor; does **not** appear in anyone's personal feed; guest can `GET /events?team_id=`; non-member gets `403`; guest `POST /events` → 404 (route doesn't exist).
- **Membership events**: add member, change role, remove member → three `team` events with target `user_id` in summary.
- **Query params**: `?entity=transaction`, `?action=created`, `?since_id=` returns only newer ids, `?limit=1` returns 1, `?limit=0`/`?since_id=abc` → `400`.
- **Checkout context**: shared-list checkout by a member books the event into the **list's team feed**, actor = the member.

### Edge Cases

- Event `summary` for a transaction without description (`description: null` passes through).
- Admin acting in a team (`?team_id=`) logs with the admin as actor and shows in the team feed.
- `since_id` beyond latest → `[]`.

## VALIDATION COMMANDS

### Level 1: Syntax
`node -e "require('./src/app')" && echo OK` (no linter at POC stage)

### Level 2/3: Full suite
`npm test` — zero regressions across auth, RBAC, balance, teams, shopping-lists + the new events suite.

### Level 4: Manual
```bash
NODE_ENV=stage npm run migrate && NODE_ENV=stage npm start &
TOKEN=$(curl -s localhost:$PORT/auth/login -H 'content-type: application/json' -d '{"email":"...","password":"..."}' | jq -r .token)
curl -s localhost:$PORT/transactions -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"type":"income","amount":100}'
curl -s "localhost:$PORT/events?limit=5" -H "Authorization: Bearer $TOKEN" | jq .
```

## ACCEPTANCE CRITERIA

- [ ] Every catalog row emits exactly one event with correct actor, `team_id`, and summary
- [ ] `GET /events` scopes personal/team/admin identically to `/transactions`; guests read, non-members 403
- [ ] Feed is newest-first; `since_id`/`limit`/`entity`/`action` behave per contract
- [ ] Checkout event is atomic with the expense + freeze; failed checkout logs nothing
- [ ] No write routes exist on `/events`
- [ ] `npm test` fully green; new suite covers the scenarios above
- [ ] ADR-009 + PRD/ARCHITECTURE/CLAUDE/README updated; RN brief verified against shipped contract

## COMPLETION CHECKLIST

- [ ] Tasks executed top-to-bottom, each validation run immediately
- [ ] Full `npm test` pass
- [ ] Manual curl walkthrough confirms feed output shape (incl. `actor_email`, parsed `summary`)
- [ ] Commits: `feat: activity events ledger + /events feed`, `test: integration suite for activity events`, `docs: ADR-009 activity events; update PRD/ARCHITECTURE/CLAUDE/README + RN brief` (atomic, conventional)

## NOTES

- **Why hand-written model**: the feed needs `ORDER BY id DESC`, `LIMIT`, `id > since_id`, and a users JOIN — none of which `modelGenerator.findAll` supports; adding them there would bloat a shared util for one consumer. Precedent: `shopping-list-items` model.
- **Why after-hooks, not BEFORE_***: events must record what actually landed (post-write `record`, decimal-formatted) and must not fire when validation rejects the write.
- **Push later**: add a `push_tokens` entity + a sender that POSTs to Expo's push API wherever `EventModel.log` is called (or a tiny dispatcher wrapping it). Nothing in this design needs to change.

**Confidence Score**: 9/10 for one-pass implementation success.
