# Feature: Phase 1 — Full API Implementation

The following plan is complete. Validate task logic and file paths before starting. Since this is greenfield, the patterns defined here ARE the project conventions.

## Feature Description

Build the entire `balance` REST API from scratch: dependency installation, environment config, SQLite schema + migration + seed, all middleware, four feature modules (categories, vaults, transactions, balance), and Express wiring. No source files exist yet — every file in `src/` is new.

## User Story

As a single user of the balance API  
I want CRUD endpoints for income, expenses, categories, and savings vaults plus a balance summary  
So that I can track personal finances with correct net worth, vault, and spendable figures

## Problem Statement

`package.json` exists but has no dependencies and no scripts. `src/` does not exist. The API cannot run.

## Solution Statement

Implement the full layered architecture documented in `ARCHITECTURE.md` and `PRD.md`: config → DB → middleware → modules → wiring. Every layer is thin and single-responsibility. No ORMs, no test runner, no linter — minimal POC.

## Feature Metadata

**Feature Type**: New Capability  
**Estimated Complexity**: High (many files, all greenfield)  
**Primary Systems Affected**: entire project  
**Dependencies**: `express`, `better-sqlite3`, `dotenv`

---

## CONTEXT REFERENCES

### Relevant Codebase Files — READ BEFORE IMPLEMENTING

- `PRD.md` (§5 Data Model, §6 Vault & Balance Model, §7 API Surface) — source of truth for schema, invariants, and endpoint contracts
- `ARCHITECTURE.md` (Directory Map, ER diagram, Request lifecycle) — layer structure and file locations
- `CLAUDE.md` (Money, Soft deletion, Invariants) — conventions enforced throughout

### New Files to Create

```
package.json                          (update — add deps + scripts)
.env.example
.env.stage
src/config/env.js
src/config/db.js
src/db/schema.sql
src/db/migrate.js
src/db/seed.js
src/middleware/auth.js
src/middleware/errorHandler.js
src/middleware/validate.js
src/lib/money.js
src/modules/categories/categories.repository.js
src/modules/categories/categories.service.js
src/modules/categories/categories.controller.js
src/modules/categories/categories.route.js
src/modules/vaults/vaults.repository.js
src/modules/vaults/vaults.service.js
src/modules/vaults/vaults.controller.js
src/modules/vaults/vaults.route.js
src/modules/transactions/transactions.repository.js
src/modules/transactions/transactions.service.js
src/modules/transactions/transactions.controller.js
src/modules/transactions/transactions.route.js
src/modules/balance/balance.repository.js
src/modules/balance/balance.service.js
src/modules/balance/balance.controller.js
src/modules/balance/balance.route.js
src/app.js
src/server.js
data/.gitkeep
```

### Patterns to Follow

**Layering rule**: controllers handle HTTP + boundary validation + money conversion; services hold business logic + invariants; repositories own SQL. No SQL outside repositories, no HTTP logic outside controllers.

**Error throwing**: services throw plain `Error` objects with a `.status` property set. Controllers catch and forward to `next(e)`. The central `errorHandler` middleware formats the JSON response.

```js
// service error pattern
const err = new Error('Not found');
err.status = 404;
throw err;
```

**Repository pattern**: synchronous `better-sqlite3` calls. Each function accepts `userId` as the first argument. Soft delete = set `deleted_at`; all reads filter `deleted_at IS NULL`.

**Money conversion**: `toCents()` on incoming request body values; `toDecimal()` on outgoing response values. Done at the controller boundary only.

**Naming**: files follow `<module>.<layer>.js` (e.g., `categories.repository.js`). Route files export an Express Router.

**CommonJS**: `require`/`module.exports` everywhere. No ES module syntax.

---

## IMPLEMENTATION PLAN

### Phase 1: Foundation (deps, env, DB, shared utilities)

- Install npm deps + update package.json scripts
- Create env files and config module
- Create DB connection module
- Create schema.sql + migrate + seed
- Create middleware (auth, errorHandler, validate)
- Create money lib

### Phase 2: Feature Modules

- Categories module (simplest — no special invariants)
- Vaults module (with allocate/withdraw actions and history)
- Transactions module (vault_id constraint, query filters)
- Balance module (aggregate read-only)

### Phase 3: Wiring + Validation

- app.js and server.js
- Boot sequence: config → migrate (idempotent) → seed (idempotent) → listen
- Manual endpoint validation

---

## STEP-BY-STEP TASKS

---

### TASK 1 — UPDATE `package.json`

- **ADD** `dependencies`: `"express": "^4.19.2"`, `"better-sqlite3": "^9.6.0"`, `"dotenv": "^16.4.5"`
- **ADD** `scripts`:
  - `"start": "node src/server.js"`
  - `"migrate": "node src/db/migrate.js"`
  - `"seed": "node src/db/seed.js"`
- **UPDATE** `"main"` to `"src/server.js"`
- **VALIDATE**: `cat package.json | grep -E '"express"|"better-sqlite3"|"dotenv"|"start"|"migrate"|"seed"'`

---

### TASK 2 — `npm install`

- **RUN**: `npm install`
- **VALIDATE**: `ls node_modules | grep -E '^express$|^better-sqlite3$|^dotenv$'`

---

### TASK 3 — CREATE `.env.example` and `.env.stage`

**`.env.example`**:
```
NODE_ENV=stage
PORT=3000
DB_PATH=./data/balance.stage.db
CURRENCY=USD
```

**`.env.stage`** (same content, used locally, gitignored):
```
NODE_ENV=stage
PORT=3000
DB_PATH=./data/balance.stage.db
CURRENCY=USD
```

- **ALSO** create `data/.gitkeep` so the `data/` directory exists
- **VALIDATE**: `ls .env.example .env.stage data/.gitkeep`

---

### TASK 4 — CREATE `src/config/env.js`

Load `.env.<NODE_ENV>` using dotenv, validate required vars, export config object.

```js
'use strict';
require('dotenv').config({ path: `.env.${process.env.NODE_ENV || 'stage'}` });

const required = ['PORT', 'DB_PATH', 'CURRENCY'];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required env var: ${key}`);
}

module.exports = {
  port: parseInt(process.env.PORT, 10),
  dbPath: process.env.DB_PATH,
  currency: process.env.CURRENCY,
  nodeEnv: process.env.NODE_ENV || 'stage',
};
```

- **VALIDATE**: `NODE_ENV=stage node -e "const c = require('./src/config/env'); console.log(c)"`

---

### TASK 5 — CREATE `src/config/db.js`

Open a `better-sqlite3` connection using `config.dbPath`. Enable WAL mode and foreign keys.

```js
'use strict';
const Database = require('better-sqlite3');
const path = require('path');
const config = require('./env');

const db = new Database(path.resolve(config.dbPath));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

module.exports = db;
```

- **GOTCHA**: `path.resolve` is required because `DB_PATH` is relative (`./data/...`) and the process may be invoked from any directory.
- **VALIDATE**: `NODE_ENV=stage node -e "const db = require('./src/config/db'); console.log(db.open)"` (should print `true`)

---

### TASK 6 — CREATE `src/db/schema.sql`

Full DDL. All tables use `IF NOT EXISTS`. All monetary amounts are `INTEGER` (cents). Timestamps are `TEXT` in ISO-8601 format (SQLite has no native datetime type). Soft delete via nullable `deleted_at`.

```sql
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  email         TEXT    NOT NULL UNIQUE,
  password_hash TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at    TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  name       TEXT    NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('income', 'expense', 'both')),
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_categories_user ON categories(user_id);

CREATE TABLE IF NOT EXISTS vaults (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  name          TEXT    NOT NULL,
  target_amount INTEGER,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS idx_vaults_user ON vaults(user_id);

CREATE TABLE IF NOT EXISTS transactions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  type        TEXT    NOT NULL CHECK (type IN ('income', 'expense')),
  amount      INTEGER NOT NULL CHECK (amount > 0),
  category_id INTEGER REFERENCES categories(id),
  vault_id    INTEGER REFERENCES vaults(id),
  description TEXT,
  occurred_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%d', 'now')),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  deleted_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_transactions_user    ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_vault   ON transactions(vault_id);
CREATE INDEX IF NOT EXISTS idx_transactions_category ON transactions(category_id);

CREATE TABLE IF NOT EXISTS vault_history (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  vault_id       INTEGER NOT NULL REFERENCES vaults(id),
  transaction_id INTEGER NOT NULL REFERENCES transactions(id),
  action         TEXT    NOT NULL CHECK (action IN ('allocate', 'withdraw')),
  amount         INTEGER NOT NULL,
  created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_vault_history_vault ON vault_history(vault_id);
```

- **VALIDATE**: `node -e "const fs=require('fs'); console.log(fs.readFileSync('./src/db/schema.sql','utf8').includes('vault_history'))"`

---

### TASK 7 — CREATE `src/db/migrate.js`

Read `schema.sql` and execute it. Idempotent (all DDL uses `IF NOT EXISTS`).

```js
'use strict';
const fs = require('fs');
const path = require('path');
const db = require('../config/db');

const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
db.exec(sql);
console.log('Migration complete.');
```

- **VALIDATE**: `NODE_ENV=stage node src/db/migrate.js` (should print "Migration complete." and create `data/balance.stage.db`)

---

### TASK 8 — CREATE `src/db/seed.js`

Insert user_id=1 and a set of default categories. Idempotent — use `INSERT OR IGNORE`.

```js
'use strict';
const db = require('../config/db');

db.prepare(
  `INSERT OR IGNORE INTO users (id, email) VALUES (1, 'user@balance.local')`
).run();

const defaultCategories = [
  { name: 'Salary',      kind: 'income'  },
  { name: 'Freelance',   kind: 'income'  },
  { name: 'Food',        kind: 'expense' },
  { name: 'Transport',   kind: 'expense' },
  { name: 'Health',      kind: 'expense' },
  { name: 'Utilities',   kind: 'expense' },
  { name: 'Other',       kind: 'both'    },
];

const insert = db.prepare(
  `INSERT OR IGNORE INTO categories (id, user_id, name, kind)
   VALUES (?, 1, ?, ?)`
);

defaultCategories.forEach((cat, i) => insert.run(i + 1, cat.name, cat.kind));

console.log('Seed complete.');
```

- **VALIDATE**: `NODE_ENV=stage node src/db/seed.js` then `NODE_ENV=stage node -e "const db=require('./src/config/db'); console.log(db.prepare('SELECT count(*) as n FROM categories').get())"` (should show n: 7)

---

### TASK 9 — CREATE `src/middleware/auth.js`

POC: injects `req.userId = 1`. Swap for real auth in Phase 2.

```js
'use strict';
module.exports = (req, res, next) => {
  req.userId = 1;
  next();
};
```

- **VALIDATE**: `node -e "const m=require('./src/middleware/auth'); const req={}; m(req,{},()=>{}); console.log(req.userId)"` (should print `1`)

---

### TASK 10 — CREATE `src/middleware/errorHandler.js`

Central error middleware. Reads `err.status` (set by services) or falls back to 500.

```js
'use strict';
module.exports = (err, req, res, next) => { // eslint-disable-line no-unused-vars
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
};
```

- **VALIDATE**: `node -e "const m=require('./src/middleware/errorHandler')"` (no error)

---

### TASK 11 — CREATE `src/middleware/validate.js`

Boundary validation helpers. Export named functions used by controllers.

```js
'use strict';

function requireFields(...fields) {
  return (req, res, next) => {
    for (const field of fields) {
      if (req.body[field] === undefined || req.body[field] === null || req.body[field] === '') {
        return res.status(400).json({ error: `Missing required field: ${field}` });
      }
    }
    next();
  };
}

module.exports = { requireFields };
```

- **VALIDATE**: `node -e "const {requireFields}=require('./src/middleware/validate'); console.log(typeof requireFields)"` (should print `function`)

---

### TASK 12 — CREATE `src/lib/money.js`

Decimal ↔ cents conversion. Used at controller boundaries only.

```js
'use strict';

const toCents = (decimal) => Math.round(Number(decimal) * 100);
const toDecimal = (cents) => cents / 100;

module.exports = { toCents, toDecimal };
```

- **VALIDATE**: `node -e "const {toCents,toDecimal}=require('./src/lib/money'); console.log(toCents(19.99), toDecimal(1999))"` (should print `1999 19.99`)

---

### TASK 13 — CREATE `src/modules/categories/categories.repository.js`

All SQL for categories. Receives and returns raw cents. Filters `deleted_at IS NULL` on every read.

```js
'use strict';
const db = require('../../config/db');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const findAll = (userId) =>
  db.prepare(`SELECT * FROM categories WHERE user_id = ? AND deleted_at IS NULL`).all(userId);

const findById = (userId, id) =>
  db.prepare(`SELECT * FROM categories WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId);

const create = (userId, { name, kind }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO categories (user_id, name, kind) VALUES (?, ?, ?)`
  ).run(userId, name, kind);
  return findById(userId, lastInsertRowid);
};

const update = (userId, id, fields) => {
  const sets = [];
  const values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.kind !== undefined) { sets.push('kind = ?'); values.push(fields.kind); }
  if (sets.length === 0) return findById(userId, id);
  sets.push(`updated_at = ${NOW}`);
  values.push(id, userId);
  db.prepare(
    `UPDATE categories SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(...values);
  return findById(userId, id);
};

const softDelete = (userId, id) =>
  db.prepare(
    `UPDATE categories SET deleted_at = ${NOW} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(id, userId);

module.exports = { findAll, findById, create, update, softDelete };
```

- **VALIDATE**: `node -e "const r=require('./src/modules/categories/categories.repository'); console.log(typeof r.findAll)"` (should print `function`)

---

### TASK 14 — CREATE `src/modules/categories/categories.service.js`

Business logic and invariants for categories.

```js
'use strict';
const repo = require('./categories.repository');

const VALID_KINDS = ['income', 'expense', 'both'];

const assertKind = (kind) => {
  if (!VALID_KINDS.includes(kind)) {
    const e = new Error(`kind must be one of: ${VALID_KINDS.join(', ')}`);
    e.status = 400;
    throw e;
  }
};

const assertExists = (cat) => {
  if (!cat) { const e = new Error('Category not found'); e.status = 404; throw e; }
  return cat;
};

const list = (userId) => repo.findAll(userId);

const get = (userId, id) => assertExists(repo.findById(userId, id));

const create = (userId, { name, kind }) => {
  assertKind(kind);
  return repo.create(userId, { name, kind });
};

const update = (userId, id, fields) => {
  assertExists(repo.findById(userId, id));
  if (fields.kind !== undefined) assertKind(fields.kind);
  return repo.update(userId, id, fields);
};

const remove = (userId, id) => {
  assertExists(repo.findById(userId, id));
  repo.softDelete(userId, id);
};

module.exports = { list, get, create, update, remove };
```

- **VALIDATE**: `node -e "const s=require('./src/modules/categories/categories.service'); console.log(typeof s.list)"` (should print `function`)

---

### TASK 15 — CREATE `src/modules/categories/categories.controller.js`

HTTP handling. Calls service, handles errors with `next(e)`. No money conversion needed for categories (no amounts).

```js
'use strict';
const svc = require('./categories.service');

const list = (req, res, next) => {
  try { res.json(svc.list(req.userId)); } catch (e) { next(e); }
};

const get = (req, res, next) => {
  try { res.json(svc.get(req.userId, Number(req.params.id))); } catch (e) { next(e); }
};

const create = (req, res, next) => {
  try { res.status(201).json(svc.create(req.userId, req.body)); } catch (e) { next(e); }
};

const update = (req, res, next) => {
  try { res.json(svc.update(req.userId, Number(req.params.id), req.body)); } catch (e) { next(e); }
};

const remove = (req, res, next) => {
  try { svc.remove(req.userId, Number(req.params.id)); res.status(204).send(); } catch (e) { next(e); }
};

module.exports = { list, get, create, update, remove };
```

---

### TASK 16 — CREATE `src/modules/categories/categories.route.js`

Mount routes. Use `validate.requireFields` on POST.

```js
'use strict';
const { Router } = require('express');
const ctrl = require('./categories.controller');
const { requireFields } = require('../../middleware/validate');

const router = Router();

router.get('/',     ctrl.list);
router.post('/',    requireFields('name', 'kind'), ctrl.create);
router.get('/:id',  ctrl.get);
router.put('/:id',  ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
```

- **VALIDATE**: `node -e "const r=require('./src/modules/categories/categories.route'); console.log(r.stack.length)"` (should be ≥ 5)

---

### TASK 17 — CREATE `src/modules/vaults/vaults.repository.js`

All SQL for vaults. Also exposes `vault_history` writes. Amounts are cents.

```js
'use strict';
const db = require('../../config/db');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const findAll = (userId) =>
  db.prepare(`SELECT * FROM vaults WHERE user_id = ? AND deleted_at IS NULL`).all(userId);

const findById = (userId, id) =>
  db.prepare(`SELECT * FROM vaults WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId);

const create = (userId, { name, target_amount }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO vaults (user_id, name, target_amount) VALUES (?, ?, ?)`
  ).run(userId, name, target_amount ?? null);
  return findById(userId, lastInsertRowid);
};

const update = (userId, id, fields) => {
  const sets = [];
  const values = [];
  if (fields.name !== undefined) { sets.push('name = ?'); values.push(fields.name); }
  if (fields.target_amount !== undefined) { sets.push('target_amount = ?'); values.push(fields.target_amount); }
  if (sets.length === 0) return findById(userId, id);
  sets.push(`updated_at = ${NOW}`);
  values.push(id, userId);
  db.prepare(
    `UPDATE vaults SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(...values);
  return findById(userId, id);
};

const softDelete = (userId, id) =>
  db.prepare(
    `UPDATE vaults SET deleted_at = ${NOW} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(id, userId);

const getHistory = (userId, vaultId) =>
  db.prepare(
    `SELECT * FROM vault_history WHERE user_id = ? AND vault_id = ? ORDER BY created_at DESC`
  ).all(userId, vaultId);

const addHistory = (userId, vaultId, transactionId, action, amount) =>
  db.prepare(
    `INSERT INTO vault_history (user_id, vault_id, transaction_id, action, amount) VALUES (?, ?, ?, ?, ?)`
  ).run(userId, vaultId, transactionId, action, amount);

module.exports = { findAll, findById, create, update, softDelete, getHistory, addHistory };
```

---

### TASK 18 — CREATE `src/modules/vaults/vaults.service.js`

Business logic for vaults including allocate and withdraw. Depends on transactions repository — import it directly (cross-module repo access is acceptable in this simple layered architecture).

```js
'use strict';
const vaultRepo = require('./vaults.repository');
const txnRepo = require('../transactions/transactions.repository');
const { toCents, toDecimal } = require('../../lib/money');

const assertVaultExists = (userId, id) => {
  const vault = vaultRepo.findById(userId, id);
  if (!vault) { const e = new Error('Vault not found'); e.status = 404; throw e; }
  return vault;
};

const formatVault = (v) => ({
  ...v,
  target_amount: v.target_amount !== null ? toDecimal(v.target_amount) : null,
});

const list = (userId) => vaultRepo.findAll(userId).map(formatVault);

const get = (userId, id) => {
  const v = vaultRepo.findById(userId, id);
  if (!v) { const e = new Error('Vault not found'); e.status = 404; throw e; }
  return formatVault(v);
};

const create = (userId, { name, target_amount }) => {
  const targetCents = target_amount !== undefined && target_amount !== null
    ? toCents(target_amount)
    : null;
  return formatVault(vaultRepo.create(userId, { name, target_amount: targetCents }));
};

const update = (userId, id, fields) => {
  assertVaultExists(userId, id);
  const mapped = { ...fields };
  if (fields.target_amount !== undefined && fields.target_amount !== null) {
    mapped.target_amount = toCents(fields.target_amount);
  }
  return formatVault(vaultRepo.update(userId, id, mapped));
};

const remove = (userId, id) => {
  assertVaultExists(userId, id);
  vaultRepo.softDelete(userId, id);
};

const getHistory = (userId, id) => {
  assertVaultExists(userId, id);
  return vaultRepo.getHistory(userId, id).map(h => ({ ...h, amount: toDecimal(h.amount) }));
};

const allocate = (userId, vaultId, transactionId) => {
  const vault = assertVaultExists(userId, vaultId);
  const txn = txnRepo.findById(userId, transactionId);
  if (!txn) { const e = new Error('Transaction not found'); e.status = 404; throw e; }
  if (txn.type !== 'income') {
    const e = new Error('Only income transactions can be allocated to a vault');
    e.status = 400; throw e;
  }
  // If moving from another vault, log a withdraw from the old vault first
  if (txn.vault_id && txn.vault_id !== vaultId) {
    vaultRepo.addHistory(userId, txn.vault_id, transactionId, 'withdraw', txn.amount);
  }
  txnRepo.setVaultId(userId, transactionId, vaultId);
  vaultRepo.addHistory(userId, vaultId, transactionId, 'allocate', txn.amount);
  return formatVault(vaultRepo.findById(userId, vaultId));
};

const withdraw = (userId, vaultId, transactionId) => {
  assertVaultExists(userId, vaultId);
  const txn = txnRepo.findById(userId, transactionId);
  if (!txn) { const e = new Error('Transaction not found'); e.status = 404; throw e; }
  if (txn.vault_id !== vaultId) {
    const e = new Error('Transaction is not allocated to this vault');
    e.status = 400; throw e;
  }
  txnRepo.setVaultId(userId, transactionId, null);
  vaultRepo.addHistory(userId, vaultId, transactionId, 'withdraw', txn.amount);
  return formatVault(vaultRepo.findById(userId, vaultId));
};

module.exports = { list, get, create, update, remove, getHistory, allocate, withdraw };
```

---

### TASK 19 — CREATE `src/modules/vaults/vaults.controller.js`

```js
'use strict';
const svc = require('./vaults.service');

const list = (req, res, next) => {
  try { res.json(svc.list(req.userId)); } catch (e) { next(e); }
};

const get = (req, res, next) => {
  try { res.json(svc.get(req.userId, Number(req.params.id))); } catch (e) { next(e); }
};

const create = (req, res, next) => {
  try { res.status(201).json(svc.create(req.userId, req.body)); } catch (e) { next(e); }
};

const update = (req, res, next) => {
  try { res.json(svc.update(req.userId, Number(req.params.id), req.body)); } catch (e) { next(e); }
};

const remove = (req, res, next) => {
  try { svc.remove(req.userId, Number(req.params.id)); res.status(204).send(); } catch (e) { next(e); }
};

const history = (req, res, next) => {
  try { res.json(svc.getHistory(req.userId, Number(req.params.id))); } catch (e) { next(e); }
};

const allocate = (req, res, next) => {
  try { res.json(svc.allocate(req.userId, Number(req.params.id), Number(req.body.transaction_id))); } catch (e) { next(e); }
};

const withdraw = (req, res, next) => {
  try { res.json(svc.withdraw(req.userId, Number(req.params.id), Number(req.body.transaction_id))); } catch (e) { next(e); }
};

module.exports = { list, get, create, update, remove, history, allocate, withdraw };
```

---

### TASK 20 — CREATE `src/modules/vaults/vaults.route.js`

```js
'use strict';
const { Router } = require('express');
const ctrl = require('./vaults.controller');
const { requireFields } = require('../../middleware/validate');

const router = Router();

router.get('/',                   ctrl.list);
router.post('/',                  requireFields('name'), ctrl.create);
router.get('/:id',                ctrl.get);
router.put('/:id',                ctrl.update);
router.delete('/:id',             ctrl.remove);
router.get('/:id/history',        ctrl.history);
router.post('/:id/allocate',      requireFields('transaction_id'), ctrl.allocate);
router.post('/:id/withdraw',      requireFields('transaction_id'), ctrl.withdraw);

module.exports = router;
```

- **VALIDATE**: `node -e "const r=require('./src/modules/vaults/vaults.route'); console.log(r.stack.length)"` (should be ≥ 8)

---

### TASK 21 — CREATE `src/modules/transactions/transactions.repository.js`

Includes `setVaultId` used by vaults service. Supports optional query filters.

```js
'use strict';
const db = require('../../config/db');

const NOW = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

const findAll = (userId, filters = {}) => {
  const conditions = ['user_id = ?', 'deleted_at IS NULL'];
  const values = [userId];
  if (filters.type)        { conditions.push('type = ?');        values.push(filters.type); }
  if (filters.vault_id)    { conditions.push('vault_id = ?');    values.push(Number(filters.vault_id)); }
  if (filters.category_id) { conditions.push('category_id = ?'); values.push(Number(filters.category_id)); }
  return db.prepare(`SELECT * FROM transactions WHERE ${conditions.join(' AND ')} ORDER BY occurred_at DESC`).all(...values);
};

const findById = (userId, id) =>
  db.prepare(`SELECT * FROM transactions WHERE id = ? AND user_id = ? AND deleted_at IS NULL`).get(id, userId);

const create = (userId, { type, amount, category_id, vault_id, description, occurred_at }) => {
  const { lastInsertRowid } = db.prepare(
    `INSERT INTO transactions (user_id, type, amount, category_id, vault_id, description, occurred_at)
     VALUES (?, ?, ?, ?, ?, ?, COALESCE(?, strftime('%Y-%m-%d', 'now')))`
  ).run(userId, type, amount, category_id ?? null, vault_id ?? null, description ?? null, occurred_at ?? null);
  return findById(userId, lastInsertRowid);
};

const update = (userId, id, fields) => {
  const sets = [];
  const values = [];
  if (fields.type        !== undefined) { sets.push('type = ?');        values.push(fields.type); }
  if (fields.amount      !== undefined) { sets.push('amount = ?');      values.push(fields.amount); }
  if (fields.category_id !== undefined) { sets.push('category_id = ?'); values.push(fields.category_id); }
  if (fields.vault_id    !== undefined) { sets.push('vault_id = ?');    values.push(fields.vault_id); }
  if (fields.description !== undefined) { sets.push('description = ?'); values.push(fields.description); }
  if (fields.occurred_at !== undefined) { sets.push('occurred_at = ?'); values.push(fields.occurred_at); }
  if (sets.length === 0) return findById(userId, id);
  sets.push(`updated_at = ${NOW}`);
  values.push(id, userId);
  db.prepare(
    `UPDATE transactions SET ${sets.join(', ')} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(...values);
  return findById(userId, id);
};

const softDelete = (userId, id) =>
  db.prepare(
    `UPDATE transactions SET deleted_at = ${NOW} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(id, userId);

const setVaultId = (userId, id, vaultId) =>
  db.prepare(
    `UPDATE transactions SET vault_id = ?, updated_at = ${NOW} WHERE id = ? AND user_id = ? AND deleted_at IS NULL`
  ).run(vaultId, id, userId);

module.exports = { findAll, findById, create, update, softDelete, setVaultId };
```

---

### TASK 22 — CREATE `src/modules/transactions/transactions.service.js`

Key invariants:
- `amount` must be a positive number
- `expense` transactions must have `vault_id = null`
- `vault_id` (if provided) must reference an active vault

```js
'use strict';
const repo = require('./transactions.repository');
const vaultRepo = require('../vaults/vaults.repository');
const { toCents, toDecimal } = require('../../lib/money');

const VALID_TYPES = ['income', 'expense'];

const formatTxn = (t) => ({ ...t, amount: toDecimal(t.amount) });

const assertType = (type) => {
  if (!VALID_TYPES.includes(type)) {
    const e = new Error(`type must be income or expense`); e.status = 400; throw e;
  }
};

const assertVaultAllowed = (userId, type, vaultId) => {
  if (type === 'expense' && vaultId) {
    const e = new Error('Expense transactions cannot be assigned to a vault'); e.status = 400; throw e;
  }
  if (vaultId) {
    const vault = vaultRepo.findById(userId, vaultId);
    if (!vault) { const e = new Error('Vault not found'); e.status = 404; throw e; }
  }
};

const list = (userId, filters) =>
  repo.findAll(userId, filters).map(formatTxn);

const get = (userId, id) => {
  const t = repo.findById(userId, id);
  if (!t) { const e = new Error('Transaction not found'); e.status = 404; throw e; }
  return formatTxn(t);
};

const create = (userId, body) => {
  const { type, amount, category_id, vault_id, description, occurred_at } = body;
  assertType(type);
  assertVaultAllowed(userId, type, vault_id);
  const amountCents = toCents(amount);
  if (amountCents <= 0) { const e = new Error('amount must be positive'); e.status = 400; throw e; }
  return formatTxn(repo.create(userId, { type, amount: amountCents, category_id, vault_id, description, occurred_at }));
};

const update = (userId, id, body) => {
  const existing = get(userId, id);
  const resolvedType = body.type ?? existing.type;
  const resolvedVaultId = body.vault_id !== undefined ? body.vault_id : existing.vault_id;
  assertType(resolvedType);
  assertVaultAllowed(userId, resolvedType, resolvedVaultId);
  const mapped = { ...body };
  if (body.amount !== undefined) mapped.amount = toCents(body.amount);
  if (mapped.amount !== undefined && mapped.amount <= 0) {
    const e = new Error('amount must be positive'); e.status = 400; throw e;
  }
  return formatTxn(repo.update(userId, id, mapped));
};

const remove = (userId, id) => {
  get(userId, id);
  repo.softDelete(userId, id);
};

module.exports = { list, get, create, update, remove };
```

---

### TASK 23 — CREATE `src/modules/transactions/transactions.controller.js`

Pass `req.query` as filters to `list`.

```js
'use strict';
const svc = require('./transactions.service');

const list = (req, res, next) => {
  try { res.json(svc.list(req.userId, req.query)); } catch (e) { next(e); }
};

const get = (req, res, next) => {
  try { res.json(svc.get(req.userId, Number(req.params.id))); } catch (e) { next(e); }
};

const create = (req, res, next) => {
  try { res.status(201).json(svc.create(req.userId, req.body)); } catch (e) { next(e); }
};

const update = (req, res, next) => {
  try { res.json(svc.update(req.userId, Number(req.params.id), req.body)); } catch (e) { next(e); }
};

const remove = (req, res, next) => {
  try { svc.remove(req.userId, Number(req.params.id)); res.status(204).send(); } catch (e) { next(e); }
};

module.exports = { list, get, create, update, remove };
```

---

### TASK 24 — CREATE `src/modules/transactions/transactions.route.js`

```js
'use strict';
const { Router } = require('express');
const ctrl = require('./transactions.controller');
const { requireFields } = require('../../middleware/validate');

const router = Router();

router.get('/',     ctrl.list);
router.post('/',    requireFields('type', 'amount'), ctrl.create);
router.get('/:id',  ctrl.get);
router.put('/:id',  ctrl.update);
router.delete('/:id', ctrl.remove);

module.exports = router;
```

---

### TASK 25 — CREATE `src/modules/balance/balance.repository.js`

Two queries: one for totals, one for per-vault balances. Returns raw cents.

```js
'use strict';
const db = require('../../config/db');

const getBalance = (userId) => {
  const totals = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense
    FROM transactions
    WHERE user_id = ? AND deleted_at IS NULL
  `).get(userId);

  const vaults = db.prepare(`
    SELECT
      v.id,
      v.name,
      v.target_amount,
      COALESCE(SUM(t.amount), 0) AS balance
    FROM vaults v
    LEFT JOIN transactions t
      ON t.vault_id = v.id AND t.deleted_at IS NULL
    WHERE v.user_id = ? AND v.deleted_at IS NULL
    GROUP BY v.id
    ORDER BY v.name
  `).all(userId);

  return { totals, vaults };
};

module.exports = { getBalance };
```

---

### TASK 26 — CREATE `src/modules/balance/balance.service.js`

Compute the three figures. Convert cents to decimals. Read currency from config.

```js
'use strict';
const repo = require('./balance.repository');
const { toDecimal } = require('../../lib/money');
const { currency } = require('../../config/env');

const get = (userId) => {
  const { totals, vaults } = repo.getBalance(userId);
  const total = totals.total_income - totals.total_expense;
  const vaultTotal = vaults.reduce((sum, v) => sum + v.balance, 0);
  const available = total - vaultTotal;

  return {
    total: toDecimal(total),
    available: toDecimal(available),
    vaults: vaults.map(v => ({
      id: v.id,
      name: v.name,
      balance: toDecimal(v.balance),
      target: v.target_amount !== null ? toDecimal(v.target_amount) : null,
    })),
    currency,
  };
};

module.exports = { get };
```

---

### TASK 27 — CREATE `src/modules/balance/balance.controller.js`

```js
'use strict';
const svc = require('./balance.service');

const get = (req, res, next) => {
  try { res.json(svc.get(req.userId)); } catch (e) { next(e); }
};

module.exports = { get };
```

---

### TASK 28 — CREATE `src/modules/balance/balance.route.js`

```js
'use strict';
const { Router } = require('express');
const ctrl = require('./balance.controller');

const router = Router();
router.get('/', ctrl.get);

module.exports = router;
```

---

### TASK 29 — CREATE `src/app.js`

Wire Express: parse JSON, auth middleware, mount routers, error handler last.

```js
'use strict';
const express = require('express');
const auth = require('./middleware/auth');
const errorHandler = require('./middleware/errorHandler');

const categoriesRouter    = require('./modules/categories/categories.route');
const vaultsRouter        = require('./modules/vaults/vaults.route');
const transactionsRouter  = require('./modules/transactions/transactions.route');
const balanceRouter       = require('./modules/balance/balance.route');

const app = express();

app.use(express.json());
app.use(auth);

app.use('/categories',   categoriesRouter);
app.use('/vaults',       vaultsRouter);
app.use('/transactions', transactionsRouter);
app.use('/balance',      balanceRouter);

app.use(errorHandler);

module.exports = app;
```

- **VALIDATE**: `NODE_ENV=stage node -e "const app=require('./src/app'); console.log(typeof app)"` (should print `function`)

---

### TASK 30 — CREATE `src/server.js`

Boot sequence: load config → ensure DB exists (migrate is idempotent) → seed → listen.

```js
'use strict';
const fs = require('fs');
const path = require('path');
const config = require('./config/env');

// Ensure data directory exists before opening DB
const dataDir = path.dirname(path.resolve(config.dbPath));
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = require('./config/db');
const app = require('./app');

// Idempotent migrate on every boot
const schema = fs.readFileSync(path.join(__dirname, 'db', 'schema.sql'), 'utf8');
db.exec(schema);

// Idempotent seed
db.prepare(`INSERT OR IGNORE INTO users (id, email) VALUES (1, 'user@balance.local')`).run();

app.listen(config.port, () => {
  console.log(`balance API running on port ${config.port} [${config.nodeEnv}]`);
});
```

- **GOTCHA**: `server.js` inlines the critical migrate+seed so the server is always self-healing. The standalone `migrate.js` / `seed.js` scripts remain for manual use.
- **VALIDATE**: `NODE_ENV=stage node src/server.js` (should print the startup message; Ctrl-C to stop)

---

## VALIDATION COMMANDS

Run in order after all files are created.

### Level 1: Syntax check all files

```bash
node --check src/config/env.js
node --check src/config/db.js
node --check src/db/migrate.js
node --check src/db/seed.js
node --check src/middleware/auth.js
node --check src/middleware/errorHandler.js
node --check src/middleware/validate.js
node --check src/lib/money.js
node --check src/modules/categories/categories.repository.js
node --check src/modules/categories/categories.service.js
node --check src/modules/categories/categories.controller.js
node --check src/modules/categories/categories.route.js
node --check src/modules/vaults/vaults.repository.js
node --check src/modules/vaults/vaults.service.js
node --check src/modules/vaults/vaults.controller.js
node --check src/modules/vaults/vaults.route.js
node --check src/modules/transactions/transactions.repository.js
node --check src/modules/transactions/transactions.service.js
node --check src/modules/transactions/transactions.controller.js
node --check src/modules/transactions/transactions.route.js
node --check src/modules/balance/balance.repository.js
node --check src/modules/balance/balance.service.js
node --check src/modules/balance/balance.controller.js
node --check src/modules/balance/balance.route.js
node --check src/app.js
node --check src/server.js
```

### Level 2: DB bootstrap

```bash
NODE_ENV=stage node src/db/migrate.js
NODE_ENV=stage node src/db/seed.js
```

### Level 3: Server boots

```bash
NODE_ENV=stage node src/server.js &
sleep 1
curl -s http://localhost:3000/balance | node -e "const d=require('fs').readFileSync(0,'utf8'); const j=JSON.parse(d); console.log('total:', j.total, 'currency:', j.currency)"
kill %1
```

### Level 4: Manual endpoint smoke tests (run server first: `NODE_ENV=stage node src/server.js`)

```bash
# Create a category
curl -s -X POST http://localhost:3000/categories \
  -H 'Content-Type: application/json' \
  -d '{"name":"Salary","kind":"income"}' | node -e "process.stdin.pipe(process.stdout)"

# Create an income transaction
curl -s -X POST http://localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{"type":"income","amount":2000,"description":"Monthly pay"}' | node -e "process.stdin.pipe(process.stdout)"

# Create an expense
curl -s -X POST http://localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{"type":"expense","amount":100,"description":"Groceries"}' | node -e "process.stdin.pipe(process.stdout)"

# Check balance (expect total:1900, available:1900, vaults:[])
curl -s http://localhost:3000/balance | node -e "process.stdin.pipe(process.stdout)"

# Create a vault
curl -s -X POST http://localhost:3000/vaults \
  -H 'Content-Type: application/json' \
  -d '{"name":"Emergency Fund","target_amount":500}' | node -e "process.stdin.pipe(process.stdout)"

# Allocate income txn (id=1) to vault (id=1)
curl -s -X POST http://localhost:3000/vaults/1/allocate \
  -H 'Content-Type: application/json' \
  -d '{"transaction_id":1}' | node -e "process.stdin.pipe(process.stdout)"

# Check balance (expect total:1900, available:-100+vault, vaults:[{balance:2000}])
# total=1900, vaultBalance=2000, available=1900-2000=-100
curl -s http://localhost:3000/balance | node -e "process.stdin.pipe(process.stdout)"

# Withdraw from vault
curl -s -X POST http://localhost:3000/vaults/1/withdraw \
  -H 'Content-Type: application/json' \
  -d '{"transaction_id":1}' | node -e "process.stdin.pipe(process.stdout)"

# Check balance again (expect total:1900, available:1900)
curl -s http://localhost:3000/balance | node -e "process.stdin.pipe(process.stdout)"

# Vault history
curl -s http://localhost:3000/vaults/1/history | node -e "process.stdin.pipe(process.stdout)"

# Error cases
curl -s -X POST http://localhost:3000/transactions \
  -H 'Content-Type: application/json' \
  -d '{"type":"expense","amount":50,"vault_id":1}' | node -e "process.stdin.pipe(process.stdout)"
# Expect: 400, expense cannot be assigned to a vault

curl -s http://localhost:3000/transactions/9999 | node -e "process.stdin.pipe(process.stdout)"
# Expect: 404
```

---

## ACCEPTANCE CRITERIA

- [ ] `npm install` succeeds; `node_modules` contains express, better-sqlite3, dotenv
- [ ] `NODE_ENV=stage npm run migrate` creates `data/balance.stage.db` with all 5 tables
- [ ] `NODE_ENV=stage npm run seed` populates user_id=1 and 7 default categories
- [ ] `NODE_ENV=stage npm start` boots without errors
- [ ] All 5 CRUD + soft-delete route groups respond correctly
- [ ] Allocate and withdraw update `vault_id` on transactions and log `vault_history` rows
- [ ] `GET /balance` returns correct `total`, `available`, and `vaults[]` figures
- [ ] Expense + vault_id → 400
- [ ] Soft-deleted resource → 404
- [ ] Missing required field on POST → 400
- [ ] Money: all amounts in API responses are decimals; stored as cents

---

## COMPLETION CHECKLIST

- [ ] All 30 tasks completed in order
- [ ] All `node --check` syntax validations pass
- [ ] Server boots cleanly
- [ ] Balance math smoke test passes
- [ ] Allocate/withdraw/history smoke test passes
- [ ] Error case tests return correct status codes

---

## NOTES

- **Cross-module repo access**: `vaults.service.js` imports `transactions.repository.js` directly for the allocate/withdraw actions. This is intentional — services may read across repo boundaries; only SQL belongs in repositories and only HTTP belongs in controllers.
- **server.js inlines migrate+seed**: intentional for self-healing boot. The standalone scripts remain for CI/manual use.
- **No transactions for allocate/withdraw**: SQLite with `better-sqlite3` supports synchronous transactions. If atomicity is needed (set vault_id + write history together), wrap in `db.transaction(fn)()`. The POC omits this since failures at this scale are recoverable.
- **Confidence score**: 9/10 — fully greenfield with no pattern ambiguity, all implementation details specified inline.
