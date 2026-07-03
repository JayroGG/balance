# Request to `balance` backend — auto-capture domain model (sources, captures, transfers)

> **From:** `balance-mobile` (repo `/Users/jayro/Dev/ReactNative/Projects/balance-manager`)
> **To:** the `balance` backend agent (repo `/Users/jayro/Dev/Node/Projects/balance`)
> **Date:** 2026-07-02
> **Why:** the mobile side is designing automatic transaction capture from payment notifications
> (Google Wallet / Apple Pay / bank apps — iOS Shortcuts + Android MacroDroid first, native listener
> later). A notification is *evidence* of a payment, not a transaction: the same purchase can be
> reported by two apps, card-less bank pushes (SPEI) must still resolve to an account, and each
> card/account must route to its own context (personal vs a team). All resolution logic belongs
> server-side so every capture path shares it.
>
> Full design rationale (worked scenarios included):
> `/Users/jayro/Dev/ReactNative/Projects/balance-manager/docs/auto-transaction-capture-research.md` §8.
> This doc is the actionable contract. Suggested delivery: **Slice 1** (sources + aliases + captures
> + automation token) first; **Slice 2** (transfers) can follow separately.

## Concepts (30 seconds)

- **`payment_sources`** — one row per *pot of money* the user owns: a bank **account** or a
  **credit card** (debt = its own pot). A **debit card is not a source** — it's an access method to
  its account. Sources belong to the user (no `team_id` scoping); instead each source carries a
  **routing rule**: `target_team_id` (`NULL` = personal) deciding where its transactions land.
- **`source_aliases`** — how a channel's notifications identify a source: by card last-4
  (`card_last4`) or as the channel's only pot (`channel_default`, for card-less pushes like
  "Transferencia exitosa a X").
- **`captures`** — the ingest ledger: one row per notification evidence, with dedup + provenance.
  A capture that resolves cleanly **auto-posts** a real transaction; otherwise it stays `pending`
  for the mobile review inbox.
- **`transfers`** (Slice 2) — an atomic two-legged operation moving money symbolically between two
  contexts the user can write to.

## Slice 1 — requested contract

### 1. Data

New tables (house `schema.sql` style; money as cents via `moneyFields`; soft-delete like the rest):

```sql
CREATE TABLE payment_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,                    -- "Nu account", "BBVA credit"
  type TEXT NOT NULL,                    -- 'account' | 'credit_card'
  bank TEXT,                             -- free slug: 'nu', 'bbva', ...
  target_team_id INTEGER REFERENCES teams(id),   -- NULL = personal (THE routing rule)
  default_category_id INTEGER REFERENCES categories(id),
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT ..., updated_at TEXT ..., deleted_at TEXT
);

CREATE TABLE source_aliases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  source_id INTEGER NOT NULL REFERENCES payment_sources(id),
  channel TEXT NOT NULL,                 -- 'google_wallet' | 'apple_pay' | 'nu_app' | 'bbva_app' | ...
  match_kind TEXT NOT NULL,              -- 'card_last4' | 'channel_default'
  value TEXT,                            -- 4 digits for card_last4; NULL for channel_default
  created_at TEXT ..., updated_at TEXT ..., deleted_at TEXT
);

CREATE TABLE captures (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  channel TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'unknown',  -- 'purchase' | 'transfer' | 'unknown'
  direction TEXT NOT NULL,               -- 'in' | 'out'
  amount INTEGER NOT NULL,               -- cents (moneyFields)
  merchant_raw TEXT,                     -- merchant or transfer counterparty
  last4 TEXT,                            -- as parsed from the notification, may be NULL
  captured_at TEXT NOT NULL,             -- ISO-8601 from the device
  notification_hash TEXT,                -- device-computed; exact-dedup key
  status TEXT NOT NULL DEFAULT 'pending',-- 'pending' | 'posted' | 'duplicate' | 'discarded'
  source_id INTEGER REFERENCES payment_sources(id),
  duplicate_of INTEGER REFERENCES captures(id),
  transaction_id INTEGER REFERENCES transactions(id),
  created_at TEXT ..., updated_at TEXT ..., deleted_at TEXT
);
```

`transactions` gains three nullable columns (no behavior change to the existing ledger rules):

```sql
ALTER TABLE transactions ADD COLUMN source_id INTEGER REFERENCES payment_sources(id);
ALTER TABLE transactions ADD COLUMN capture_id INTEGER REFERENCES captures(id);
ALTER TABLE transactions ADD COLUMN transfer_group_id TEXT;   -- used by Slice 2
```

Uniqueness / invariants (enforce in hooks per house convention):

- `source_aliases`: unique `(user_id, channel, match_kind, value)` among non-deleted rows.
- **`channel_default` is only valid while it is the only one for that `(user_id, channel)`** —
  creating a second one → `400`. (Two pots behind one app = card-less pushes are ambiguous.)
- `card_last4` `value` must be exactly 4 digits → else `400`.
- `payment_sources.type` ∈ `account | credit_card`; `target_team_id`, when set, must be a team the
  user belongs to with a **write-capable role** (owner/admin/member — not guest) → else `400`.
- `captures.notification_hash`: unique `(user_id, channel, notification_hash)` when non-NULL.

### 2. Entities & endpoints (house pattern: `src/entities/<name>/`)

`payment_sources` and `source_aliases` are **user-scoped only** — no `?team_id=` param, standard
restGenerator CRUD, rows filtered to `req.userId` like everything else:

| Endpoint | Notes |
|---|---|
| CRUD `/payment-sources` | restGenerator; validation in `BEFORE_CREATE`/`BEFORE_UPDATE` hooks. Soft-deleting a source soft-deletes its aliases. |
| CRUD `/source-aliases` | restGenerator; the alias invariants above in hooks. (Nesting under `/payment-sources/:id/aliases` is fine too if you prefer — mobile adapts.) |

`captures`:

| Endpoint | Notes |
|---|---|
| `POST /captures` | **The ingest endpoint** (see pipeline below). Body: `{ channel, kind?, direction, amount, merchant_raw?, last4?, captured_at, notification_hash? }` (decimal amount, as usual). Returns `201` with the capture — including its resolved `status` and, when posted, `transaction_id`. Re-sent `notification_hash` → **`200` with the existing capture** (idempotent), not a duplicate row. |
| `GET /captures` | List, filterable at least by `?status=` (`filterFields`) — the mobile review inbox reads `?status=pending`. |
| `POST /captures/:id/confirm` | Review action for `pending` rows. Body `{ source_id }` (optionally `{ team_id?, category_id? }` overrides). Links the source, runs steps 3–4 of the pipeline, posts the transaction → `200` capture. Custom route **before** restGenerator. |
| `POST /captures/:id/discard` | → status `discarded`, `200`. |
| `DELETE /captures/:id` | Standard soft-delete is fine; posting history is preserved via `transactions.capture_id`. |

**Ingest pipeline** (in the `captures` `BEFORE_CREATE`/`CREATE` hooks — this is the heart of it):

1. **Exact dedup** — `(user_id, channel, notification_hash)` already exists → short-circuit,
   return the existing capture (idempotent `200`).
2. **Alias match** — if `last4` present → look up `(channel, 'card_last4', last4)`; else →
   `(channel, 'channel_default')`. Match found → set `source_id`. No match → save as `pending`, done.
3. **Cross-channel dedup** — a non-`duplicate`, non-`discarded` capture with the same `source_id`,
   `amount`, `direction` and `captured_at` within **±5 minutes** exists → save the new one as
   `duplicate` with `duplicate_of` set, done. (Wallet + bank double-report of one purchase.)
4. **Auto-post** — create the transaction: `type` = `in`→`income` / `out`→`expense`, decimal
   `amount`, `description` = `merchant_raw`, `occurred_at` = date part of `captured_at`,
   `category_id` = the source's `default_category_id` (nullable), plus `source_id` + `capture_id`,
   **in the context of the source's `target_team_id`** (`NULL` = personal — inject `team_id`
   server-side exactly like the `?team_id=` write path does). Capture → `posted`, `transaction_id`
   set.
   - If the transaction insert is rejected (e.g. the `available`-never-negative rule) or the user
     has lost write access to the routed team → **do not fail the ingest**: leave the capture
     `pending` so it surfaces in the review inbox. Automations can't handle a `400`.

### 3. Automation auth (long-lived token)

iOS Shortcuts / MacroDroid can't refresh a JWT. Requested: a way to mint a **long-lived,
ingest-scoped credential** — e.g. `POST /auth/tokens { name, scope: "ingest" }` → an API-key row
(revocable via `DELETE /auth/tokens/:id`), accepted by the auth middleware as
`Authorization: Bearer <key>` but **only authorized for `POST /captures`**. Exact design is the
backend's call (API-key entity vs long-TTL scoped JWT) — the mobile constraints are only:
long-lived, revocable, and ingest-only (a leaked phone-automation secret must not expose the
full account).

## Slice 2 — transfers (can ship separately)

| Endpoint | Contract |
|---|---|
| `POST /transfers` | Body `{ amount, from_team_id?, to_team_id?, description? }` — `null`/omitted side = personal. **Atomically** creates two transactions sharing a fresh `transfer_group_id`: `expense` in the *from* context, `income` in the *to* context (`description` on both; a sensible default like `"Transfer to <team>"` if omitted). Returns `201 { transfer_group_id, from: <tx>, to: <tx> }`. |
| `DELETE /transfers/:group_id` | Soft-deletes **both** legs atomically → `204`. |

Guards (→ `400` / `403`):

- `amount > 0`; `from` ≠ `to`.
- RBAC: the user needs a **write-capable role in both contexts** (owner/admin/member; guest → `403`;
  personal always allowed). Same matrix the entity writes already enforce.
- The expense leg obeys the *from* context's `available`-never-negative rule (reject the whole
  transfer, not one leg).
- Legs are **not individually editable/deletable**: `PUT`/`DELETE /transactions/:id` on a row with
  `transfer_group_id` → `400 { "error": "part of a transfer — delete the transfer instead" }`.

## Explicitly out of scope (client-owned or later)

- Notification **parsing** — devices send structured fields only; no raw notification text is
  stored server-side.
- The review-inbox UI, sources-manager UI, per-source screens — all mobile.
- Retro-detection of transfer-like pairs ("link as transfer") — north star, not now.
- Aggregator feeds (Belvo etc.) — future `channel` writing into the same `POST /captures`; no
  schema change anticipated.

## Acceptance checks (curl, with a valid `$TOKEN`)

```bash
# 1. create a source (account, routed personal) + its aliases
SRC=$(curl -s -X POST $API/payment-sources -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"Nu account","type":"account","bank":"nu"}' | jq -r '.id')
curl -s -X POST $API/source-aliases -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"source_id\":$SRC,\"channel\":\"google_wallet\",\"match_kind\":\"card_last4\",\"value\":\"0347\"}"
curl -s -X POST $API/source-aliases -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"source_id\":$SRC,\"channel\":\"nu_app\",\"match_kind\":\"channel_default\"}"

# 2. wallet purchase → auto-posts a personal expense
curl -s -X POST $API/captures -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"google_wallet","kind":"purchase","direction":"out","amount":129.50,
       "merchant_raw":"OXXO","last4":"0347","captured_at":"2026-07-02T18:03:00Z","notification_hash":"h1"}' \
  | jq '{status, transaction_id}'                    # → "posted", non-null

# 3. same purchase reported by the bank app ±5 min → duplicate
curl -s -X POST $API/captures -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"nu_app","kind":"purchase","direction":"out","amount":129.50,
       "merchant_raw":"Compra OXXO","last4":"0347","captured_at":"2026-07-02T18:04:10Z","notification_hash":"h2"}' \
  | jq '{status, duplicate_of}'                      # → "duplicate", capture #2's id

# 4. card-less SPEI push → channel_default → income, personal
curl -s -X POST $API/captures -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"nu_app","kind":"transfer","direction":"in","amount":500,
       "merchant_raw":"Transferencia de Karla","captured_at":"2026-07-02T19:00:00Z","notification_hash":"h3"}' \
  | jq '.status'                                     # → "posted" (income)

# 5. unknown card → pending; confirm from the inbox
CAP=$(curl -s -X POST $API/captures -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"apple_pay","kind":"purchase","direction":"out","amount":80,
       "last4":"9999","captured_at":"2026-07-02T20:00:00Z","notification_hash":"h4"}' | jq -r '.id')
curl -s $API/captures?status=pending -H "Authorization: Bearer $TOKEN" | jq length   # ≥ 1
curl -s -X POST $API/captures/$CAP/confirm -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d "{\"source_id\":$SRC}" | jq '.status'           # → "posted"

# 6. idempotent re-send of hash h1 → 200, same capture, no new transaction
curl -s -X POST $API/captures -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"channel":"google_wallet","direction":"out","amount":129.50,"last4":"0347",
       "captured_at":"2026-07-02T18:03:00Z","notification_hash":"h1"}' -w '%{http_code}'

# 7. second channel_default on the same channel → 400
# 8. (slice 2) transfer personal → team, then verify both legs share transfer_group_id
#    and PUT on a leg → 400
```

## What to send back

When done, please produce a short **"work done" contract doc** (like the team-color one) covering:

1. Final table schemas + the exact endpoint list with request/response shapes (including the
   capture response's `status`/`transaction_id`/`duplicate_of` fields and error messages).
2. The automation-token design you chose (mint/revoke endpoints, header format, scope enforcement).
3. Any deviation: dedup window chosen, how the "routed team not writable" fallback behaves, whether
   aliases are nested or top-level, `confirm` overrides supported.
4. Migration note for existing dev DBs (`ALTER TABLE` list / recreate).

The mobile side implements its endpoints (`sources.js`, `captures.js`, `transfers.js`), the review
inbox, and the sources-manager screen against that doc.
