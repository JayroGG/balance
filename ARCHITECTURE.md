# ARCHITECTURE — `balance`

Agent- and human-readable map of the system: data model, balance logic, request flow, and where everything lives. Pair with `PRD.md` (requirements) and `CLAUDE.md` (commands/conventions).

## Data model (ER diagram)

```mermaid
erDiagram
    users ||--o{ categories : owns
    users ||--o{ vaults : owns
    users ||--o{ transactions : owns
    users ||--o{ payment_sources : owns
    categories ||--o{ transactions : classifies
    vaults ||--o{ vault_history : "balance ledger"
    payment_sources ||--o{ source_aliases : "recognized by"
    payment_sources ||--o{ captures : "resolved to"
    captures |o--o| transactions : posts
    captures |o--o| captures : duplicate_of

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
        string description
        date occurred_at
        int source_id FK "nullable — which pot paid"
        int capture_id FK "nullable — non-null = auto-captured"
        string transfer_group_id "nullable — pairs transfer legs"
        datetime deleted_at "nullable"
    }
    vault_history {
        int id PK
        int user_id FK
        int vault_id FK
        string action "allocate|withdraw"
        int amount "cents, > 0"
        datetime created_at
    }
    payment_sources {
        int id PK
        int user_id FK
        string name
        string type "account|credit_card"
        string bank "free slug"
        int target_team_id FK "nullable — routing rule, NULL = personal"
        int default_category_id FK "nullable"
        int active "1|0"
        datetime deleted_at "nullable"
    }
    source_aliases {
        int id PK
        int user_id FK
        int source_id FK
        string channel "google_wallet|nu_app|..."
        string match_kind "card_last4|channel_default"
        string value "4 digits, or NULL for channel_default"
        datetime deleted_at "nullable"
    }
    captures {
        int id PK
        int user_id FK
        string channel
        string kind "purchase|transfer|unknown"
        string direction "in|out"
        int amount "cents, > 0"
        string merchant_raw
        string last4 "nullable"
        datetime captured_at
        string notification_hash "exact-dedup key"
        string status "pending|posted|duplicate|discarded"
        int source_id FK "nullable"
        int duplicate_of FK "nullable"
        int transaction_id FK "nullable"
        datetime deleted_at "nullable"
    }
```

**Notes**
- All amounts are integer **cents**. API converts to/from decimals at the boundary.
- All tables soft-delete via nullable `deleted_at` (`NULL` = active). Every read filters `deleted_at IS NULL`.
- `transactions` is a **pure ledger** — no vault reference. `vault_history` is the **append-only source of truth** for vault balances (`balance = Σallocate − Σwithdraw`). See ADR-004.

## Balance calculation flow

```mermaid
flowchart TD
    A["GET /balance"] --> B["SUM(income) - SUM(expense)<br/>= total (net worth)"]
    A --> C["per vault: SUM(allocate) - SUM(withdraw)<br/>= vault balance (from vault_history)"]
    B --> D["available = total - SUM(all vault balances)"]
    C --> D
    D --> E["respond: { total, available, vaults[], currency }"]
```

Allocate / withdraw move an **amount** between spendable and a vault (independent of any transaction):

```mermaid
stateDiagram-v2
    [*] --> Spendable: income recorded (transactions ledger)
    Spendable --> Vaulted: allocate { amount } (≤ available) + append 'allocate'
    Vaulted --> Spendable: withdraw { amount } (≤ vault balance) + append 'withdraw'
    note right of Vaulted
        counts toward total (net worth)
        excluded from available (spendable)
        available can never go below 0
    end note
```

## Auto-capture ingest pipeline (ADR-008)

A payment notification is *evidence*, not a transaction. Devices (iOS Shortcuts / MacroDroid)
parse it into structured fields and POST to one ingest endpoint — all resolution lives server-side:

```mermaid
flowchart TD
    A["POST /captures<br/>{channel, direction, amount, last4?, captured_at, notification_hash?}"] --> B{"1. hash seen before?<br/>(user, channel, notification_hash)"}
    B -- yes --> B2["200 original capture<br/>(idempotent no-op)"]
    B -- no --> C{"2. alias match?<br/>last4 -> card_last4,<br/>fallback/card-less -> channel_default"}
    C -- no --> P["saved 'pending'<br/>-> review inbox"]
    C -- yes --> D{"3. same source+amount+direction<br/>within ±5 min?"}
    D -- yes --> D2["saved 'duplicate'<br/>duplicate_of = earlier capture"]
    D -- no --> E{"4. auto-post into the source's<br/>target_team_id context"}
    E -- ok --> E2["transaction created<br/>capture 'posted' + transaction_id"]
    E -- "available rule / lost team access" --> P
    P -. "confirm {source_id, team_id?, category_id?}<br/>re-runs steps 3–4" .-> D
    P -. discard .-> X["'discarded'"]
```

Ingest **never 4xxs a well-formed capture** — automations can't handle errors; the inbox
(`GET /captures?status=pending`) is the exception path. Ingest-scoped automation tokens
(`POST /auth/tokens`, 365 d, revocable session rows with `scope='ingest'`) may only call
`POST /captures` (app-level guard). Transfers are two `transactions` legs sharing a
`transfer_group_id`, created/deleted atomically with RBAC checks on both ends; legs are
individually immutable.

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

### RBAC (team context) — ADR-005

`resolveContext` resolves the caller's `team_members.role` (`owner | member | guest`) onto
`req.context = { userId, teamId, role }` (personal context → `role: null`). Two gates, centralized in
`src/lib/access.js` and called from the `restGenerator` write handlers (create/update/destroy) and the
custom vault write routes (allocate/withdraw):

- **Gate 1 (capability):** `guest` is read-only; owner/member/personal may write.
- **Gate 2 (ownership):** for edit/delete/allocate/withdraw, a `member` may act only on rows they
  created; `owner` bypasses; personal is already `user_id = self`-scoped (no-op).

Reads (GET) are open to all roles. Team management (rename/delete/add/remove/change-role) is
owner-only **by role** (not `teams.user_id`), so multiple owners work. `team_members.role` now
includes `guest`. Ownership for team writes is decided in the handler layer (`access.js`).

**Global admin (ADR-006).** `users.role` (`user|admin`) is a platform-level role carried in the JWT
and surfaced as `req.isAdmin` / `req.context.isAdmin` by `auth.js`. An admin **overrides** team RBAC,
membership, and ownership: `access.js` gates and the teams `requireRole` short-circuit; `resolveContext`
grants any team and enables an admin-only `?user_id=` selector; `modelGenerator` gives admins god-mode
single-row access by id and cross-user/team list scoping. Integrity invariants stay enforced for admins.

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
│   │   ├── payment-sources/# pots of money + per-source routing (ADR-008)
│   │   ├── source-aliases/ # per-channel recognition (card_last4 / channel_default)
│   │   ├── captures/       # ingest ledger + pipeline (http/controller) + review actions
│   │   ├── transfers/      # no table: routes/controller over paired transactions
│   │   └── index.js        # collects all entities
│   ├── app.js              # express wiring (mounts entity routes + middleware)
│   └── server.js           # boot: config → migrate → seed → listen
├── test/
│   ├── testSetup.js        # Jest global setup: fresh test DB per run
│   ├── helpers/            # db (schema+wipe+seed), api (supertest+login)
│   ├── unit-testing/       # pure-function specs (money, normalizeColor)
│   └── integration-test/   # HTTP specs per entity (auth, teams, balance)
├── jest.config.js          # serial suites over a shared SQLite test DB
├── .env.example            # committed template
├── .env.test               # committed (no secrets; throwaway DB)
├── .env.stage              # gitignored
├── .env.prod               # gitignored
├── data/                   # gitignored: balance.{stage,prod,test}.db
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
- **Balances are derived** from the two ledgers (`transactions`, `vault_history`) — never stored. Cent-level helpers live in `balance/db/queries.js` and are reused by transaction hooks (the `available ≥ 0` guard) and the vaults controller.
- **Invariants:** positive amounts; `available ≥ 0` on every spendable-affecting write; withdraw ≤ vault balance; a vault deletes only at balance 0. See ADR-004.
- **RBAC:** team roles `owner|member|guest` resolved onto `req.context.role` by `resolveContext`; two gates (capability + ownership) in `src/lib/access.js`; team management is owner-only by role; a team deletes only when empty (no active transactions/vaults). See ADR-005.
- **Auto-capture:** `payment_sources`/`source_aliases`/`captures` are **user-scoped only** (no `resolveContext`); routing to a team comes from the source's `target_team_id`, checked as write-capable at source create/update and again at post time. Provenance columns on `transactions` are server-set only. Ingest never 4xxs a well-formed capture. See ADR-008.
