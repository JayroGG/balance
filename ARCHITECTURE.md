# ARCHITECTURE — `balance`

Agent- and human-readable map of the system: data model, balance logic, request flow, and where everything lives. Pair with `PRD.md` (requirements) and `CLAUDE.md` (commands/conventions).

## Data model (ER diagram)

```mermaid
erDiagram
    users ||--o{ categories : owns
    users ||--o{ vaults : owns
    users ||--o{ transactions : owns
    vaults ||--o{ transactions : "tags (income only)"
    categories ||--o{ transactions : classifies
    vaults ||--o{ vault_history : logs
    transactions ||--o{ vault_history : references

    users {
        int id PK
        string email
        string password_hash "nullable (POC)"
        datetime created_at
        datetime updated_at
        datetime deleted_at "nullable"
    }
    categories {
        int id PK
        int user_id FK
        string name
        string kind "income|expense|both"
        datetime deleted_at "nullable"
    }
    vaults {
        int id PK
        int user_id FK
        string name
        int target_amount "cents, nullable"
        datetime deleted_at "nullable"
    }
    transactions {
        int id PK
        int user_id FK
        string type "income|expense"
        int amount "cents, > 0"
        int category_id FK "nullable"
        int vault_id FK "nullable; income only"
        string description
        date occurred_at
        datetime deleted_at "nullable"
    }
    vault_history {
        int id PK
        int user_id FK
        int vault_id FK
        int transaction_id FK
        string action "allocate|withdraw"
        int amount "cents"
        datetime created_at
    }
```

**Notes**
- All amounts are integer **cents**. API converts to/from decimals at the boundary.
- All tables soft-delete via nullable `deleted_at` (`NULL` = active). Every read filters `deleted_at IS NULL`.
- `transactions.vault_id` is **mutable** and only valid when `type = 'income'`.

## Balance calculation flow

```mermaid
flowchart TD
    A["GET /balance"] --> B["SUM(income) - SUM(expense)<br/>= total (net worth)"]
    A --> C["per vault: SUM(income WHERE vault_id = V)<br/>= vault balance"]
    B --> D["available = total - SUM(all vault balances)"]
    C --> D
    D --> E["respond: { total, available, vaults[], currency }"]
```

Allocate / withdraw lifecycle of a single income transaction:

```mermaid
stateDiagram-v2
    [*] --> Spendable: income created (vault_id = NULL)
    Spendable --> Vaulted: allocate (set vault_id = V) + log 'allocate'
    Vaulted --> Spendable: withdraw (set vault_id = NULL) + log 'withdraw'
    note right of Vaulted
        counts toward total (net worth)
        excluded from available (spendable)
    end note
```

## Request lifecycle (entity pattern)

Each entity is generated, not hand-written per layer. A `Router` mounts any custom
routes first, then `restGenerator` adds the standard CRUD handlers. Handlers fire
lifecycle **hooks** (validation + invariants) around the **model**, which owns the SQL
and the decimal↔cents conversion (via `modelGenerator`).

```mermaid
flowchart LR
    req["HTTP request"] --> auth["auth middleware<br/>(req.userId)"]
    auth --> route["route<br/>(custom + restGenerator)"]
    route --> handler["rest handler<br/>build body/filters"]
    handler --> hook["hooks<br/>validation + invariants"]
    hook --> model["model<br/>SQL + decimal↔cents<br/>(better-sqlite3)"]
    model --> db[("SQLite")]
    hook -. throw {message,status} .-> err["errorHandler → JSON"]
    handler -. errors .-> err
```

Generated CRUD lives in `src/utils/`: `modelGenerator` (findAll/findById/create/update/softDelete,
money conversion, user-scope + `deleted_at IS NULL`) and `restGenerator` (GET `/`, GET `/:id`,
POST `/`, PUT `/:id`, DELETE `/:id`). Hook constants: `BEFORE_CREATE`, `CREATE`, `BEFORE_UPDATE`,
`UPDATE`, `LIST_ALL`, `GET_ONE`, `BEFORE_DESTROY`, `DESTROY`.

## Directory map

```
balance/
├── src/
│   ├── config/
│   │   ├── env.js          # load/validate .env.<NODE_ENV>; export config
│   │   └── db.js           # better-sqlite3 connection (path from config)
│   ├── db/
│   │   ├── schema.sql      # full DDL: tables, indexes, constraints
│   │   ├── migrate.js      # apply schema.sql
│   │   └── seed.js         # seed user_id=1 + default categories
│   ├── constants/
│   │   └── hooks.js        # lifecycle hook type constants
│   ├── middleware/
│   │   ├── auth.js         # POC: inject req.userId = 1 (swap for real auth)
│   │   └── errorHandler.js # central error → JSON + status
│   ├── lib/
│   │   └── money.js        # decimal ↔ cents
│   ├── utils/
│   │   ├── modelGenerator/ # generic CRUD model (SQL + money conversion)
│   │   └── restGenerator/  # generic CRUD routes + handlers/ (fire hooks)
│   ├── entities/
│   │   ├── transactions/   # constants, db/{fields,model}, http/{hooks,routes}
│   │   ├── vaults/         # + http/controller (allocate/withdraw/history), db/history
│   │   ├── categories/     # constants, db/{fields,model}, http/{hooks,routes}
│   │   ├── balance/        # db/queries (aggregate), http/routes
│   │   └── index.js        # collects all entities
│   ├── app.js              # express wiring (mounts entity routes + middleware)
│   └── server.js           # boot: config → migrate → seed → listen
├── .env.example            # committed template
├── .env.stage              # gitignored
├── .env.prod               # gitignored
├── data/                   # gitignored: balance.stage.db, balance.prod.db
├── .claude/agents/plans/   # feature plans (/plan-feature output)
├── PRD.md
├── CLAUDE.md
├── ARCHITECTURE.md
└── README.md
```

## Conventions recap

- **Entity pattern:** each resource is a generated model + routes under `src/entities/<name>/`. Custom routes register **before** `restGenerator` so they aren't shadowed by `/:id`.
- **Validation & invariants** live in `http/hooks.js` (throw `{ message, status }` to short-circuit) — not in routes or handlers. No SQL outside `db/model.js` (or `db/queries.js` for balance).
- **Cross-entity access:** import the model file directly (e.g. `../../transactions/db/model`), never via the entity `index.js`, to avoid circular deps.
- **Money:** stored as integer cents; the model layer (`modelGenerator` `moneyFields`) converts decimal↔cents at the read/write boundary.
- **Auth-ready:** all tables carry `user_id`; only the auth middleware changes in Phase 2.
- **Invariants:** positive amounts; `expense` ⇒ `vault_id = NULL`; `vault_id` references active vaults only.
