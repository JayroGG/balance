# balance

A single-user REST API for personal financial records — track **incomings** and **expenses** with full CRUD + soft deletion, allocate income into **savings vaults**, and query **balance business logic** (total net worth, spendable, per-vault).

> Status: POC. See [`PRD.md`](./PRD.md) for requirements/decisions, [`ARCHITECTURE.md`](./ARCHITECTURE.md) for diagrams and the file map, and [`CLAUDE.md`](./CLAUDE.md) for conventions.

## Tech stack

Node.js (CommonJS) · Express · SQLite (`better-sqlite3`) · `dotenv` for environment config.

## Setup

```bash
npm install
cp .env.example .env.stage   # then edit values (PORT, DB_PATH, …)
```

Environments are separated from the start. `NODE_ENV` selects the config file (`.env.stage` or `.env.prod`) and each uses its own DB file.

## Run

```bash
# stage (default)
NODE_ENV=stage npm run migrate   # create tables from schema.sql
NODE_ENV=stage npm run seed      # seed user_id=1 + default categories
NODE_ENV=stage npm start         # start the API

# prod
NODE_ENV=prod npm start
```

## Money & conventions

- Amounts in requests/responses are **decimals** (e.g. `19.99`); stored internally as integer **cents**.
- Everything is **soft-deleted** (`deleted_at`); deleted resources return `404`.
- Amounts are positive; `type` (`income`/`expense`) carries the sign. An `expense` cannot be tagged to a vault.

## Vaults & balance

Allocate income to a vault by tagging it with a `vault_id`; withdraw by detaching it (back to spendable). The balance endpoint reports:

- `total` — net worth (`income − expense`), unaffected by vault moves.
- `available` — spendable (`total − money in vaults`).
- `vaults[]` — each vault's balance.

## Endpoints

```
# Transactions (CRUD + soft delete)
GET    /transactions            ?type= &vault_id= &category_id=
POST   /transactions            { type, amount, category_id?, vault_id?, description?, occurred_at? }
GET    /transactions/:id
PUT    /transactions/:id
DELETE /transactions/:id

# Categories (CRUD + soft delete)
GET/POST /categories ; GET/PUT/DELETE /categories/:id

# Vaults (CRUD + soft delete) + actions
GET/POST /vaults ; GET/PUT/DELETE /vaults/:id
GET    /vaults/:id/history
POST   /vaults/:id/allocate      { transaction_id }
POST   /vaults/:id/withdraw      { transaction_id }

# Balance
GET    /balance                  { total, available, vaults:[{id,name,balance,target?}], currency }
```

## Roadmap

- Phase 2: DB-backed hashed authentication (multi-user).
- Phase 3: partial vault withdrawals, multi-currency, budgets, recurring transactions, reporting.
