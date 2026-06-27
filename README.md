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
- Amounts are positive; `type` (`income`/`expense`) carries the sign.

## Vaults & balance

Transactions are a pure ledger. Allocation is a **separate, amount-based** operation: `POST /vaults/:id/allocate { amount }` moves spendable money into a vault, `withdraw { amount }` returns it. Each appends a row to the append-only `vault_history` ledger (the source of truth for vault balances). The balance endpoint reports:

- `total` — net worth (`income − expense`), unaffected by vault moves.
- `available` — spendable (`total − money in vaults`); a hard `≥ 0` invariant.
- `vaults[]` — each vault's balance.

Any write that would push `available` below zero (overspending, or shrinking income whose money is vaulted) is rejected `400`; a vault deletes only at balance 0. See [`.claude/ADR/ADR-004-vault-allocation-model.md`](./.claude/ADR/ADR-004-vault-allocation-model.md).

## Endpoints

```
# Transactions (CRUD + soft delete)
GET    /transactions            ?type= &category_id=
POST   /transactions            { type, amount, category_id?, description?, occurred_at? }
GET    /transactions/:id
PUT    /transactions/:id
DELETE /transactions/:id

# Categories (CRUD + soft delete)
GET/POST /categories ; GET/PUT/DELETE /categories/:id

# Vaults (CRUD + soft delete) + actions
GET/POST /vaults ; GET/PUT/DELETE /vaults/:id   (DELETE requires balance = 0)
GET    /vaults/:id/history
POST   /vaults/:id/allocate      { amount }      (≤ available)
POST   /vaults/:id/withdraw      { amount }      (≤ vault balance)

# Balance
GET    /balance                  { total, available, vaults:[{id,name,balance,target?}], currency }
```

## Deployment (Fly.io)

The repo ships a `Dockerfile` and `fly.toml`. The SQLite file lives on a **persistent volume** (`/data`), and the app **scales to zero** when idle (wakes on the next request) — so it costs ~nothing while unused. Config (`PORT`, `DB_PATH`, `CURRENCY`, `NODE_ENV`) is set in `fly.toml [env]`.

First-time setup ([install flyctl](https://fly.io/docs/flyctl/install/) first):

```bash
fly auth login
fly launch --no-deploy            # adopts fly.toml; pick a unique app name + region
fly volumes create balance_data --region <your-region> --size 1   # match primary_region
fly deploy
```

- Keep it to a **single machine** (SQLite is one file on one volume) — `fly scale count 1`.
- `migrate` + `seed` run automatically on boot (both idempotent).
- Open it: `fly open` · logs: `fly logs` · shell: `fly ssh console`.
- Pushing to GitHub can auto-deploy if you connect the repo in Fly's dashboard.

## Roadmap

- Phase 2: DB-backed hashed authentication, then Auth0 + RBAC.
- Phase 3: multi-currency, budgets, recurring transactions, reporting.
- Phase 4 (post-auth): bank/account import via an aggregator (Pluggy/Belvo). See `PRD.md` §9.
