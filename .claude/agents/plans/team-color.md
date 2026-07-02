# Feature: Team `color`

The following plan should be complete, but validate documentation and codebase patterns and task sanity before implementing. Pay special attention to naming of existing utils/models and import paths.

## Feature Description

Teams gain a persisted, nullable `color` — a normalized 6-digit hex string (`#RRGGBB`, uppercase, leading `#`). The mobile app (`balance-manager`) tints its whole UI with the active team's color; personal context uses the client default and needs nothing server-side. Full request contract: `/Users/jayro/Dev/ReactNative/Projects/balance-manager/docs/backend-team-color-request.md`.

## User Story

As a mobile app user switching between team contexts
I want each team to carry its own accent color from the backend
So that the app can tint the UI per team and a context switch is unmistakable on any device I log in from.

## Problem Statement

`teams` has no color field; the client would have to store colors locally per device, losing them across devices/users. The backend is the natural single source of truth for a team-level attribute.

## Solution Statement

Add a nullable `color TEXT` column; accept optional `color` on `POST /teams` (via the existing BEFORE_CREATE hook) and on the custom owner-gated `PUT /teams/:id` (extended from name-only to `{ name?, color? }`, `null` clears); validate/normalize in one shared helper; reads pick it up for free (`SELECT t.*` / `SELECT *`). One deviation from the request doc's assumption: instead of a purely manual `ALTER TABLE` for existing DBs, boot/migrate get an idempotent column guard so deployed stage/prod DBs upgrade themselves.

## Feature Metadata

**Feature Type**: Enhancement
**Estimated Complexity**: Low
**Primary Systems Affected**: `teams` entity, `src/db/schema.sql`, `src/db/migrate.js`, `src/server.js`, PRD, new contract doc
**Dependencies**: none (no new packages)

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ BEFORE IMPLEMENTING

- `/Users/jayro/Dev/ReactNative/Projects/balance-manager/docs/backend-team-color-request.md` — the full requested contract + acceptance curls; this plan implements it.
- `src/db/schema.sql` (lines 13–21) — `teams` DDL; `color` goes here. Note `CREATE TABLE IF NOT EXISTS` will NOT add the column to existing DBs — hence the guard tasks.
- `src/entities/teams/db/fields.js` — `create: ['name']` whitelist consumed by `modelGenerator.create` (`src/utils/modelGenerator/index.js:74-87` picks only `fields.create` keys that are `!== undefined`, so a merged `color: null` flows through and inserts `NULL`).
- `src/entities/teams/http/hooks.js` — `BEFORE_CREATE` validates `name`; color validation/normalization joins it here. Returning an object from a BEFORE_* hook merges into body (`src/utils/restGenerator/handlers/createHandler.js:11-13`).
- `src/entities/teams/http/controller.js` (lines 81–89) — the custom owner-gated `update` (name-only today) to extend; error style is `httpError(message, status)` (line 5).
- `src/entities/teams/db/model.js` (lines 30–34) — `rename(teamId, name)` to replace with a patch-based `updateById`; note the by-id (not user-scoped) convention and the `NOW` constant. `listForMember` (line 11) and `getById` (line 21) already `SELECT *` → `color` flows to reads for free.
- `src/entities/teams/http/routes.js` — custom `PUT /:id` (line 19) shadows the generated one; only generated `POST /` is live. No route changes needed.
- `src/server.js` (lines 13–18) — idempotent `db.exec(schema)` on boot; the column guard goes right after.
- `src/db/migrate.js` — same guard after `db.exec(sql)`.
- `src/middleware/errorHandler.js` (line 9) — errors render as `{ "error": message }`, matching the requested error shape.
- `PRD.md` §7 (lines 111–120) — teams API surface to update.
- `docs/react-native-rbac-and-team-management-update.md` — format reference for the work-done contract doc.

### New Files to Create

- `docs/react-native-team-color-update.md` — work-done contract doc for the mobile repo (see Task 8).

### Relevant Documentation

- None external. SQLite `ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS`; idempotency comes from checking `PRAGMA table_info(teams)` first.

### Patterns to Follow

**Validation in hooks / custom controller** — throw `Object.assign(new Error(msg), { status })`; hooks may return a partial body to merge:

```js
// hooks.js today
if (!body.name) { const e = new Error('Missing required field: name'); e.status = 400; throw e; }
```

**By-id team mutation** (`model.js:30-34`):

```js
const rename = (teamId, name) => {
  db.prepare(`UPDATE teams SET name = ?, updated_at = ${NOW} WHERE id = ? AND deleted_at IS NULL`)
    .run(name, teamId);
  return getById(teamId);
};
```

**Dynamic SET building** — mirror `modelGenerator.update` (`src/utils/modelGenerator/index.js:89-102`): pick `!== undefined` keys, map to `f = ?`, append `updated_at = ${NOW}`.

**Anti-patterns to avoid**: no back-compat `rename` shim once `updateById` replaces it; no RBAC changes (owner gating via `requireRole` stays as-is); no validation in `routes.js`.

---

## IMPLEMENTATION PLAN

Single phase — six small code edits in dependency order (schema → guard → fields → helper/hooks → model → controller), then docs.

**Design decisions:**

- `normalizeColor` lives in `http/hooks.js` (exported alongside `teamHooks`) — validation stays in the hooks file per convention, and the custom controller imports it from there. Not worth a new file.
- `TeamModel.rename` becomes `TeamModel.updateById(teamId, patch)` — no shim, only the controller calls it.
- `fields.create` and `fields.update` both gain `'color'`. The generated PUT is shadowed, but the arrays document the writable surface and it costs one word.
- Semantics: `undefined` = untouched; `null` = clear (valid on create too, stores `NULL`); string must match `/^#?[0-9A-Fa-f]{6}$/` → normalized to `#` + uppercase; anything else → `400 { "error": "color must be a hex color like #RRGGBB" }`.

---

## STEP-BY-STEP TASKS

### 1. UPDATE `src/db/schema.sql`

- **IMPLEMENT**: add `color TEXT` (nullable, after `name`) to the `teams` table:
  ```sql
  name       TEXT    NOT NULL,
  color      TEXT,
  ```
- **GOTCHA**: fresh DBs only; existing DBs are handled by Tasks 2–3.
- **VALIDATE**: `rm -f /tmp/fresh.db && sqlite3 /tmp/fresh.db < src/db/schema.sql && sqlite3 /tmp/fresh.db "SELECT color FROM teams LIMIT 0" && echo OK`

### 2. UPDATE `src/server.js`

- **IMPLEMENT**: after `db.exec(schema)` (line 15), add an idempotent column guard:
  ```js
  // schema.sql can't ALTER existing tables; add columns introduced after first deploy.
  if (!db.prepare(`PRAGMA table_info(teams)`).all().some((c) => c.name === 'color')) {
    db.exec(`ALTER TABLE teams ADD COLUMN color TEXT`);
  }
  ```
- **PATTERN**: matches the file's idempotent migrate/seed style (`src/server.js:13-18`).
- **VALIDATE**: covered by Level 4 step "existing-DB upgrade" below.

### 3. UPDATE `src/db/migrate.js`

- **IMPLEMENT**: same guard after `db.exec(sql)` (before the `console.log`).
- **GOTCHA**: two similar snippets beat a premature abstraction (house rule) — don't extract a helper.
- **VALIDATE**: `sqlite3 /tmp/old.db "CREATE TABLE teams (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL, created_at TEXT, updated_at TEXT, deleted_at TEXT);" && NODE_ENV=stage DB_PATH=/tmp/old.db npm run migrate && sqlite3 /tmp/old.db "SELECT color FROM teams LIMIT 0" && echo OK && rm -f /tmp/old.db /tmp/fresh.db`
  (works because `dotenv` does not override already-set env vars — inline `DB_PATH` wins over `.env.stage`. Note: `npm run migrate` on the schema's own DDL is idempotent, so the pre-created bare table is what exercises the ALTER.)

### 4. UPDATE `src/entities/teams/db/fields.js`

- **IMPLEMENT**: `create: ['name', 'color'],` and `update: ['name', 'color'],`
- **VALIDATE**: `node -e "const {fields}=require('./src/entities/teams/db/fields'); if(!fields.create.includes('color')||!fields.update.includes('color'))process.exit(1)" && echo OK`

### 5. UPDATE `src/entities/teams/http/hooks.js`

- **IMPLEMENT**: add + export `normalizeColor`; call it in `BEFORE_CREATE`:
  ```js
  // '#RRGGBB' normalized uppercase; leading '#' optional on input; null = no color.
  const normalizeColor = (color) => {
    if (color === null) return null;
    if (typeof color === 'string' && /^#?[0-9A-Fa-f]{6}$/.test(color)) {
      return `#${color.replace('#', '').toUpperCase()}`;
    }
    const e = new Error('color must be a hex color like #RRGGBB'); e.status = 400; throw e;
  };
  ```
  In the `BEFORE_CREATE` case, after the name check:
  ```js
  if (body.color !== undefined) return { color: normalizeColor(body.color) };
  return;
  ```
  Export: `module.exports = { teamHooks, normalizeColor };`
- **PATTERN**: BEFORE_* merge-return per `createHandler.js:11-13`; error style per existing hook.
- **GOTCHA**: keep the `typeof === 'string'` check — a numeric body value like `123456` must 400, and `regex.test(123456)` would coerce and wrongly pass.
- **VALIDATE**: `node -e "const {normalizeColor:n}=require('./src/entities/teams/http/hooks'); const a=(x,y)=>{if(x!==y)throw new Error(x+'!=='+y)}; a(n('7c3aed'),'#7C3AED'); a(n('#DC2626'),'#DC2626'); a(n(null),null); try{n('purple');process.exit(1)}catch(e){a(e.status,400)}; try{n('#ABC');process.exit(1)}catch(e){a(e.status,400)}; try{n(123456);process.exit(1)}catch(e){a(e.status,400)}; console.log('OK')"`

### 6. UPDATE `src/entities/teams/db/model.js`

- **IMPLEMENT**: replace `rename` with a patch-based update (same by-id convention):
  ```js
  const updateById = (teamId, patch) => {
    const sets = Object.keys(patch).map((f) => `${f} = ?`);
    db.prepare(
      `UPDATE teams SET ${sets.join(', ')}, updated_at = ${NOW} WHERE id = ? AND deleted_at IS NULL`
    ).run(...Object.values(patch), teamId);
    return getById(teamId);
  };
  ```
  Update the comment above it (it covers rename/softDeleteById) and the `TeamModel` spread: `listForMember, getById, listAll, updateById, softDeleteById`.
- **GOTCHA**: the controller guarantees a non-empty, pre-validated patch (keys ⊆ {name, color}) — no empty-SET guard needed here (trust internal guarantees).
- **VALIDATE**: `node -e "const {TeamModel}=require('./src/entities/teams/db/model'); if(typeof TeamModel.updateById!=='function'||TeamModel.rename)process.exit(1)" && echo OK` (needs `NODE_ENV=stage` implicit default + existing stage DB; if it errors on DB path, run with `DB_PATH=/tmp/fresh.db` from Task 1)

### 7. UPDATE `src/entities/teams/http/controller.js`

- **IMPLEMENT**: import the helper — `const { normalizeColor } = require('./hooks');` — and rewrite `update` (lines 81–89):
  ```js
  // Update name and/or color. Owner-only, by team_members role (any owner, not just the creator).
  const update = (req, res, next) => {
    try {
      const teamId = Number(req.params.id);
      requireRole(req, teamId, 'owner');
      const { name, color } = req.body;
      if (name === undefined && color === undefined) {
        throw httpError('Provide at least one field: name, color', 400);
      }
      if (name !== undefined && !name) throw httpError('Missing required field: name', 400);
      const patch = {};
      if (name !== undefined) patch.name = name;
      if (color !== undefined) patch.color = normalizeColor(color); // null clears
      res.json(TeamModel.updateById(teamId, patch));
    } catch (e) { next(e); }
  };
  ```
- **GOTCHA**: `require('./hooks')` from the controller is same-entity (not a cross-entity import) — allowed. No circular dep: hooks doesn't import the controller.
- **VALIDATE**: `node -e "require('./src/entities/teams/http/controller')" && echo OK` — then full behavior in Level 4.

### 8. UPDATE `PRD.md` + CREATE `docs/react-native-team-color-update.md`

- **IMPLEMENT** (PRD §7, lines 113–115): `POST /teams { name, color? }`; `PUT /teams/:id { name?, color? } (owner-only; color: null clears; at least one field)`.
- **IMPLEMENT** (contract doc): mirror the structure/tone of `docs/react-native-rbac-and-team-management-update.md`. Must cover, per the request doc's "What to send back":
  1. Final request/response shapes for `POST /teams` and `PUT /teams/:id` — accepted body, normalization (`#` optional, case-insensitive in → `#RRGGBB` uppercase out), error `400 { "error": "color must be a hex color like #RRGGBB" }`, and the PUT no-fields error `400 { "error": "Provide at least one field: name, color" }`.
  2. Confirmation `GET /teams` / `GET /teams/:id` return `color` (`"#RRGGBB"` or `null`) and that `color: null` clear-on-update works as specified.
  3. Deviations: none in the contract; one addition — boot/migrate auto-add the column (idempotent guard), so no manual step is strictly required.
  4. Migration note: existing dev DBs upgrade automatically on next `npm start` / `npm run migrate`; the manual one-off `ALTER TABLE teams ADD COLUMN color TEXT;` also works.
- **VALIDATE**: doc exists and covers all four numbered points; PRD lines render correctly.

---

## TESTING STRATEGY

No test framework at POC stage (locked decision) — validation is the helper micro-checks above plus a live end-to-end pass against a scratch DB (below).

### Edge Cases

- `color` omitted on create → row stores `NULL`, API returns `null`.
- `color: null` on create → `NULL` (valid).
- `"7c3aed"` (no `#`, lowercase) → `"#7C3AED"`.
- `"purple"`, `"#ABC"` (3-digit), `123456` (number) → `400` with the exact error message.
- `PUT` with only `color` → no "missing name" 400. `PUT {}` → 400. `PUT { color: null }` → clears.
- Existing pre-color DB boots and upgrades (guard), and re-boots cleanly (idempotent).

---

## VALIDATION COMMANDS

Run from `/Users/jayro/Dev/Node/Projects/balance`.

### Level 1: Syntax

`node --check` each edited JS file; Task 1 fresh-schema check.

### Level 2: Unit-ish

Task 5's `normalizeColor` micro-check; Task 6's model shape check.

### Level 3: Migration guard

Task 3's existing-DB `ALTER` check (also proves boot-guard logic since it's the same snippet).

### Level 4: Manual end-to-end (acceptance curls from the request doc)

Boot a scratch instance with auth bypass (inline vars override `.env.stage`; bypass authenticates as seeded user 1, who becomes owner of teams it creates — owner gating is exercised for real):

```bash
NODE_ENV=stage AUTH_BYPASS=true PORT=4123 DB_PATH=/tmp/color-e2e.db npm start &
API=http://localhost:4123

curl -s -X POST $API/teams -H 'Content-Type: application/json' -d '{"name":"Design","color":"7c3aed"}'   # .color == "#7C3AED"
curl -s -X POST $API/teams -H 'Content-Type: application/json' -d '{"name":"Bad","color":"purple"}'      # 400 {"error":"color must be a hex color like #RRGGBB"}
curl -s -X POST $API/teams -H 'Content-Type: application/json' -d '{"name":"Plain"}'                     # .color == null
curl -s -X PUT  $API/teams/1 -H 'Content-Type: application/json' -d '{"color":"#DC2626"}'                # .color == "#DC2626", no missing-name 400
curl -s -X PUT  $API/teams/1 -H 'Content-Type: application/json' -d '{"name":"Design+","color":"00ff00"}' # both applied, "#00FF00"
curl -s -X PUT  $API/teams/1 -H 'Content-Type: application/json' -d '{"color":null}'                     # .color == null
curl -s -X PUT  $API/teams/1 -H 'Content-Type: application/json' -d '{}'                                 # 400 at-least-one-field
curl -s $API/teams                                                                                        # every row carries color
curl -s $API/teams/1                                                                                      # detail carries color
```

Then the existing-DB upgrade: stop the server, `sqlite3` a copy of a pre-color DB (or the Task 3 `/tmp/old.db` recipe), boot pointing at it, confirm the guard adds the column and `GET /teams` works. Kill the server and `rm -f /tmp/color-e2e.db` when done.

### Level 5: Regression spot-check

With the scratch server up: create a category and a transaction, `GET /balance` — confirms untouched entities still work.

---

## ACCEPTANCE CRITERIA

- [ ] `teams.color` column exists on fresh AND pre-existing DBs (guard proven).
- [ ] `POST /teams` accepts optional `color`, normalizes to `#RRGGBB` uppercase, `400` on invalid.
- [ ] `PUT /teams/:id` accepts `{ name?, color? }`, at least one required, `color: null` clears, owner gating unchanged.
- [ ] `GET /teams` and `GET /teams/:id` return `color` (`"#RRGGBB"` or `null`).
- [ ] Error bodies match: `{ "error": "color must be a hex color like #RRGGBB" }`, status 400.
- [ ] All acceptance curls from the request doc pass verbatim.
- [ ] PRD §7 updated; `docs/react-native-team-color-update.md` created covering the four "what to send back" points.
- [ ] No changes to transactions/vaults/categories/balance/members behavior.

## COMPLETION CHECKLIST

- [ ] Tasks 1–8 done in order, each validation passed immediately.
- [ ] Level 4 end-to-end pass green, scratch artifacts cleaned up.
- [ ] Conventional commit (`feat: team color ...`) after validation.

## NOTES

- **Deviation from request doc (improvement)**: the doc assumed a manual `ALTER` for existing DBs; we add an idempotent guard in `server.js`/`migrate.js` instead so deployed Fly DBs (persistent volumes) upgrade on next deploy without a manual step. Record this in the contract doc.
- The generated `PUT /:id` remains shadowed by the custom route (`routes.js:19`) — adding `color` to `fields.update` is documentation-of-surface, not a live code path.
- No ARCHITECTURE.md change: its ER diagram doesn't model `teams` fields and no flow changes.

**Confidence score**: 9/10 for one-pass success — tiny surface, all touch points read and quoted, validation is fully scripted.
