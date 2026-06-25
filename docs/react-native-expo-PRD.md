# PRD — `balance-mobile` (React Native + Expo client)

> **Portable starter document.** Written from the `balance` backend's perspective so it can be
> dropped into a fresh repository to bootstrap the mobile app from scratch. It specifies *what the
> app must consume* (the real API), *what stack to build it on* (matching the team's existing Expo
> conventions), and *which documentation/workflow practices the new project must adopt from commit one*.
>
> Companion to the backend's `PRD.md`, `ARCHITECTURE.md`, and `.claude/ADR/`. Authored 2026-06-25.

---

## 1. Overview

`balance-mobile` is the **mobile client** for the `balance` personal-finance REST API. It lets a
single user record incomings and expenses, organize savings into **vaults**, and see their balance
broken into three figures: **total** (net worth), **available** (spendable), and **per-vault**
balances.

It is a thin, well-structured client: the backend owns all business logic and the
cents↔decimal money boundary; the app consumes decimals and renders them with a currency label
the API provides.

## 2. Goals

- Full CRUD over **transactions**, **categories**, and **vaults**, with soft-delete semantics
  (deleted resources return `404` — treat as gone).
- A **dashboard** surfacing `total`, `available`, and each vault's balance/target.
- **Allocate / withdraw** an income transaction to/from a vault, and view a vault's history.
- A **modular auth seam** (see §7): ship the prototype with auth bypassed; design so Auth0 + RBAC
  drops in later without touching screens or data layers.
- Adopt the team **documentation & workflow standard** from day one (see §10).

## 3. Non-Goals (prototype)

- No real authentication yet (single seeded user, `user_id = 1` on the backend).
- No offline-first / local persistence of records (server is source of truth; cache is optional).
- No multi-currency (one currency label, provided by `/balance`).
- No budgets, recurring transactions, charts/analytics, or push notifications.
- No partial vault withdrawals (backend withdraws a whole transaction at a time).

## 4. Backend contract (what the app consumes)

**Base URL:** the API mounts routes at the root — `http://<host>:<PORT>` with no `/api` prefix.
Configure per environment via `react-native-config` (`API_URL`).

**Money:** the API speaks **decimals** (e.g. `19.99`); never send cents. Amounts are always
**positive** — the `type` field (`income` / `expense`) carries the sign meaning.

**Identity (today):** none required. The backend injects `req.userId = 1`. The app should already
send an `Authorization: Bearer <token>` header through a single injection point so that enabling
real auth later is a config change, not a refactor (see §7).

**Errors:** non-2xx responses return `{ "error": "<message>" }`. Standard codes: `400` (validation),
`404` (missing or soft-deleted), `500`. The API client must surface `error` as the user-facing message.

**Timestamps:** `created_at` / `updated_at` are ISO-8601 UTC (`YYYY-MM-DDTHH:MM:SSZ`);
`occurred_at` is a date (`YYYY-MM-DD`). Parse/format with `luxon`.

### 4.1 Endpoints

#### Balance — `GET /balance`
Returns the computed figures. **This is the dashboard's primary call.**
```json
{
  "total": 2400.00,
  "available": 2300.00,
  "vaults": [
    { "id": 3, "name": "Emergency", "balance": 100.00, "target": 500.00 }
  ],
  "currency": "USD"
}
```
- `total` = Σincome − Σexpense (net worth). `available` = total − Σ(vault balances).
- `target` may be `null`. `currency` is the label to render all money with.

#### Transactions — `/transactions`
| Method | Path | Body / Query | Returns |
|---|---|---|---|
| GET | `/transactions` | `?type=&vault_id=&category_id=` (all optional filters) | `200` array |
| POST | `/transactions` | `{ type, amount, category_id?, vault_id?, description?, occurred_at? }` | `201` record |
| GET | `/transactions/:id` | — | `200` record / `404` |
| PUT | `/transactions/:id` | any subset of the create fields | `200` record / `404` |
| DELETE | `/transactions/:id` | — | `204` / `404` (soft delete) |

Record shape: `{ id, user_id, type, amount, category_id, vault_id, description, occurred_at, created_at, updated_at, deleted_at }`.

**Invariants the app must respect (backend enforces with `400`):**
- `type` ∈ `income | expense`; `amount` > 0.
- An **expense can never carry a `vault_id`** — hide/disable vault selection when type is expense.
- `vault_id` must reference an existing, non-deleted vault.

#### Categories — `/categories`
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/categories` | — | `200` array |
| POST | `/categories` | `{ name, kind }` — `kind` ∈ `income | expense | both` | `201` |
| GET / PUT / DELETE | `/categories/:id` | `{ name?, kind? }` on PUT | `200` / `204` / `404` |

No money fields. Default seed categories exist (Salary, Freelance, Food, Transport, Health,
Utilities, Other).

#### Vaults — `/vaults` (+ actions)
| Method | Path | Body | Returns |
|---|---|---|---|
| GET | `/vaults` | — | `200` array |
| POST | `/vaults` | `{ name, target_amount? }` (decimal) | `201` |
| GET / PUT / DELETE | `/vaults/:id` | `{ name?, target_amount? }` on PUT | `200` / `204` / `404` |
| GET | `/vaults/:id/history` | — | `200` array of `{ id, vault_id, transaction_id, action, amount, created_at }`, newest first |
| POST | `/vaults/:id/allocate` | `{ transaction_id }` | `200` vault — tags the income txn to this vault |
| POST | `/vaults/:id/withdraw` | `{ transaction_id }` | `200` vault — detaches the txn (back to spendable) |

**Allocate/withdraw rules (backend, surface as `400`/`404`):** only **income** transactions can be
allocated; allocating a txn already in another vault moves it (logs a withdraw then an allocate);
withdraw requires the txn to currently belong to that vault. A vault's `balance` is derived — there
is no "spend from vault"; you allocate/withdraw whole transactions.

> Note: `GET /vaults` returns vault records only. The **balances/targets per vault** come from
> `GET /balance` (`vaults[]`). The dashboard and vault list should read balances from `/balance`.

## 5. Proposed stack

Match the team's existing Expo app (`employee-mobile-app`) so patterns and muscle memory carry over.
**JavaScript (no TypeScript)** to stay consistent with that app and the `balance` backend.

| Concern | Choice | Notes |
|---|---|---|
| Runtime | **Expo** (SDK 53+) + React Native 0.79+, React 19 | |
| Language | JavaScript / JSX | consistent with existing projects |
| Navigation | **React Navigation** (native-stack + bottom-tabs) | organized under `stacks/` |
| State | **Redux Toolkit** + react-redux | one slice per entity under `reducers/` |
| Networking | `fetch` + `react-native-url-polyfill`, central `errorHandler` | mirrors `services/API/*` pattern |
| Config / env | **react-native-config** (`API_URL`, `AUTH_BYPASS`) | per-environment |
| Auth | **react-native-auth0** + `jwt-decode` | wired but **bypassed** in prototype (see §7) |
| Storage | `@react-native-async-storage/async-storage` | token/credentials cache |
| i18n | `i18next` + `react-i18next` | strings under `locales/` |
| Dates/money fmt | `luxon` + a small `formatMoney(amount, currency)` helper | API already sends decimals |
| Testing | `jest` + `@testing-library/react-native` | colocated `*.test.js` |

## 6. App structure

Mirror the established layout:

```
balance-mobile/
├── App.jsx
├── stacks/                 # navigation: RootStack, AuthStack, AppTabs, SplashWrapper
├── screens/
│   ├── Dashboard/          # total / available / vaults summary (GET /balance)
│   ├── Transactions/       # list + filters, create/edit, detail
│   ├── Vaults/             # list, detail (history + allocate/withdraw)
│   ├── Categories/         # manage categories
│   └── Settings/
├── components/             # reusable UI (Buttons, Inputs, Card, Header, …)
├── reducers/               # Redux Toolkit slices: balance, transactions, vaults, categories, auth
├── store/                  # configureStore
├── services/
│   ├── API/                # one module per entity: balance.js, transactions.js, vaults.js, categories.js + utils (errorHandler)
│   └── AsyncStorage/       # typed wrapper around credential/token storage
├── hooks/                  # useAuth(), useIdToken(), data hooks
├── locales/                # i18next resources
├── utils/                  # formatMoney, date helpers, config
├── .claude/
│   ├── ADR/                # decision log (start with ADR-001 auth, ADR-002 doc standard — copy from balance)
│   └── agents/plans/       # /plan-feature output
├── CLAUDE.md
├── PRD.md                  # (this document, adapted)
├── ARCHITECTURE.md         # mermaid: navigation graph, state shape, data-flow
└── README.md
```

### 6.1 Redux slices (state shape)

- `balance` — `{ total, available, vaults: [{id,name,balance,target}], currency, status }` from `GET /balance`.
- `transactions` — list + filters (`type`, `vault_id`, `category_id`) + CRUD thunks.
- `vaults` — list + selected vault history + allocate/withdraw thunks.
- `categories` — list + CRUD thunks.
- `auth` — identity/token state (bypassed in prototype; see §7).

Each slice owns async thunks that call the matching `services/API/*` module; components never call
`fetch` directly.

### 6.2 API client pattern

One async function per endpoint, e.g.:
```js
// services/API/balance.js
import Config from 'react-native-config'
import { errorHandler } from './utils'

export const getBalance = async (token, baseUrl) => {
  const res = await fetch(`${baseUrl ?? Config.API_URL}/balance`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  })
  return errorHandler(res)
}
```
`token` is injected centrally; in bypass mode it is a throwaway value (the backend ignores it).

## 7. Auth — modular, bypassed in the prototype

Aligns with backend **ADR-001**. Authentication is a **single seam**, not scattered logic.

- **One injection point:** every API call gets its `Authorization` header from one place
  (an interceptor/helper or a `useIdToken()` hook). Screens and slices never touch tokens directly.
- **Prototype (now):** `AUTH_BYPASS=true`. No login screen on the critical path; the app boots
  straight into the tabs and sends a placeholder token. The backend currently ignores it
  (`req.userId = 1`).
- **North star (deferred, recorded):** **Auth0** via `react-native-auth0` — hosted login, `idToken`
  as the Bearer token, `jwt-decode` for claims, **roles & permissions** gating screens/actions.
  When enabled, only the auth seam and an `AuthStack` change; the rest of the app is untouched.
- **Guard:** `AUTH_BYPASS` must default to off outside development builds.

Write this as `ADR-001` in the new repo's `.claude/ADR/` (copy/adapt from `balance`).

## 8. Screens & flows (prototype scope)

1. **Dashboard** — `GET /balance`. Hero shows `total` and `available`; a list of vault cards
   (name, balance, target progress). Pull-to-refresh re-fetches.
2. **Transactions** — list with filter chips (`type`, `category`, `vault`); FAB to create.
   Create/edit form: type toggle, amount, category picker, description, date (`occurred_at`),
   and vault picker **only when type = income**. Swipe/menu to soft-delete.
3. **Vaults** — list (name + balance/target from `/balance`); detail shows `history` and actions to
   **allocate** (pick an eligible income transaction) or **withdraw** (pick a txn currently in this vault).
4. **Categories** — simple CRUD list grouped by `kind`.
5. **Settings** — currency display (from `/balance`), language (i18next), and the (disabled) auth/login entry.

## 9. Phases

- **Phase 1 — Prototype (this PRD):** scaffold + doc standard; API client for all four resources;
  Redux slices; Dashboard, Transactions CRUD, Vaults (allocate/withdraw/history), Categories; auth bypassed.
- **Phase 2 — Auth:** flip the seam to DB-hashed or Auth0 per backend readiness; add `AuthStack`,
  login, token refresh, RBAC-gated UI.
- **Phase 3 — Enhancements:** charts/insights, budgets, recurring transactions, offline cache,
  push notifications, multi-currency.

## 10. Documentation & workflow standard (adopt from commit one)

This project follows the same agent-driven standard as the rest of the stack — see backend
**ADR-002**. The new repo must ship:

- **`CLAUDE.md`** — stack, commands, architecture, key files, conventions (pairs with global `~/.claude/CLAUDE.md`).
- **`PRD.md`** — this document, adapted as it evolves (requirements, locked decisions, phases).
- **`ARCHITECTURE.md`** — **Mermaid graphs** (navigation graph, Redux state shape, request/data flow)
  plus a directory/file map. Diagrams are required — they load a mental model cheaply.
- **`README.md`** — setup, env config, run/build.
- **`.claude/ADR/`** — decision log (start by copying ADR-001 auth + ADR-002 doc standard).
- **`.claude/agents/plans/`** — `/plan-feature` output; no medium/high-complexity code without a plan.
- **Per-project memory** at `~/.claude/projects/<path>/memory/` — the linked memory graph
  (`MEMORY.md` index + one fact per file).

**Workflow loop:** `/prime → /plan-feature → /execute → /commit`. Use conventional commits
(`feat:`, `fix:`, `refactor:`, `docs:`, …), one logical change each.
