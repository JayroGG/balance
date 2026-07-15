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

# Shopping lists (CRUD + soft delete) + checkout
GET/POST /shopping-lists ; GET/PUT/DELETE /shopping-lists/:id   (frozen once purchased)
POST   /shopping-lists/:id/checkout  { amount, category_id?, occurred_at? }

# Shopping list items — listed through their parent list
GET    /shopping-list-items      ?list_id=   (required)
POST   /shopping-list-items      { list_id, name, qty?, price?, checked? }
PUT/DELETE /shopping-list-items/:id

# Activity feed (read-only, append-only ledger)
GET    /events                   ?entity= &action= &since_id= &limit=   (newest first)
```

## Shopping lists

A checklist you fill *before* spending. Items carry an optional per-unit **price estimate**; nothing
touches your balance until you **check out**, which books a single expense transaction for the whole
list (you send the real total), links it, and freezes the list as `purchased` history. A checkout
that would push `available` below zero is rejected `400` and books nothing. Deleting a list removes
its items but keeps the transaction — the money was really spent. See
[`.claude/ADR/ADR-008-shopping-lists-checkout.md`](./.claude/ADR/ADR-008-shopping-lists-checkout.md).

## Activity feed

Every successful write (transactions, vault moves, list activity, checkouts, team management) is
recorded in an append-only `events` ledger. `GET /events` returns the newest-first feed — personal
by default (your own actions), `?team_id=` for a team's shared activity (all members' actions,
readable by every role). Poll incrementally with `since_id` + `limit` (e.g. for unread badges).
Events are immutable history. See
[`.claude/ADR/ADR-009-activity-events-ledger.md`](./.claude/ADR/ADR-009-activity-events-ledger.md).

## Deployment (Fly.io)

The repo ships a `Dockerfile` and `fly.toml`. The SQLite file lives on a **persistent volume** (`/data`), and the app **scales to zero** when idle (wakes on the next request) — so it costs ~nothing while unused. The Docker image is **environment-agnostic**; all config (`PORT`, `DB_PATH`, `CURRENCY`, `NODE_ENV`) comes from `fly.toml [env]`.

### Environment = branch = app

Each environment is a **separate Fly app** with its own volume and data, configured by the `fly.toml` (and, if needed, `Dockerfile`) on its branch. Branch code can drift per environment:

| Branch | Fly app | `NODE_ENV` | `DB_PATH` |
|---|---|---|---|
| `development` | `balance-4pi-dev` | `dev` | `/data/balance.dev.db` |
| `main` | `balance-4pi` | `stage` | `/data/balance.stage.db` |
| `prod-release` | `balance-4pi-prod` | `prod` | `/data/balance.prod.db` |

To stand up another environment, branch off, edit `fly.toml` (`app`, `NODE_ENV`, `DB_PATH`, `CURRENCY`), then create + deploy that app. Volumes and data are fully independent per app.

First-time setup ([install flyctl](https://fly.io/docs/flyctl/install/) first):

```bash
fly auth login
fly launch --no-deploy            # adopts fly.toml; pick a unique app name + region
fly volumes create data --region <your-region> --size 1   # match primary_region + [mounts] source
fly deploy
```

- Keep each app to a **single machine** (SQLite is one file on one volume) — `fly scale count 1`.
- `migrate` + `seed` run automatically on boot (both idempotent).
- Open it: `fly open` · logs: `fly logs` · shell: `fly ssh console`.
- **Deploying:** from the Fly dashboard, pick the branch to deploy (it uses *that branch's* `fly.toml`/`Dockerfile`), or from the CLI run `fly deploy` on the checked-out branch. Each branch always targets the app named in its own `fly.toml`.

## Roadmap

- Phase 2: DB-backed hashed authentication, then Auth0 + RBAC.
- Phase 3: multi-currency, budgets, recurring transactions, reporting.
- Phase 4 (post-auth): bank/account import via an aggregator (Pluggy/Belvo). See `PRD.md` §9.
