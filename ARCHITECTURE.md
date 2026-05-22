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

## Request lifecycle (layered per module)

```mermaid
flowchart LR
    req["HTTP request"] --> auth["auth middleware<br/>(req.userId)"]
    auth --> route["route"]
    route --> ctrl["controller<br/>validate + decimal↔cents"]
    ctrl --> svc["service<br/>business logic + invariants"]
    svc --> repo["repository<br/>SQL (better-sqlite3)"]
    repo --> db[("SQLite")]
    svc -. errors .-> err["errorHandler → JSON"]
```

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
│   ├── middleware/
│   │   ├── auth.js         # POC: inject req.userId = 1 (swap for real auth)
│   │   ├── errorHandler.js # central error → JSON + status
│   │   └── validate.js     # boundary validation helpers
│   ├── lib/
│   │   └── money.js        # decimal ↔ cents
│   ├── modules/
│   │   ├── transactions/   # route, controller, service, repository
│   │   ├── vaults/         # + allocate/withdraw actions, history
│   │   ├── categories/     # route, controller, service, repository
│   │   └── balance/        # aggregate queries
│   ├── app.js              # express wiring (routes + middleware)
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

- **Layering:** controllers do HTTP + validation + money conversion; services hold logic/invariants; repositories own SQL. No SQL outside repositories.
- **Auth-ready:** all tables carry `user_id`; only the auth middleware changes in Phase 2.
- **Invariants:** positive amounts; `expense` ⇒ `vault_id = NULL`; `vault_id` references active vaults only.
