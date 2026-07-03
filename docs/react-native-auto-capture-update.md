# Frontend update — Auto-capture domain model, Slices 1 + 2 (work done)

Brief for the React Native agent. Backend shipped **both slices** of
`balance-manager/docs/backend-auto-capture-request.md`: `payment_sources`, `source_aliases`,
`captures` with the full ingest pipeline, review actions, ingest-scoped automation tokens
(Slice 1), and `/transfers` (Slice 2, §9 below).
Auth, RBAC, `?team_id=` context, and every pre-existing endpoint are unchanged.

**TL;DR**
- `POST /captures` is live: exact hash dedup → alias match → ±5 min cross-channel dedup →
  auto-post into the source's routed context. Unresolved evidence stays `pending`.
- New CRUD: `/payment-sources`, `/source-aliases` (both user-scoped — **no** `?team_id=`).
- Review actions: `POST /captures/:id/confirm` (with `team_id`/`category_id` overrides) and
  `POST /captures/:id/discard`.
- Automation tokens: `POST/GET/DELETE /auth/tokens` — long-lived (365 d), revocable, and locked
  to `POST /captures` only.
- Transactions now carry provenance: `source_id`, `capture_id`, `transfer_group_id` (all `null`
  for manual rows). They are **read-only** — never accepted in a POST/PUT body.
- Migration is automatic on boot / `npm run migrate`. Nothing to run by hand.

---

## 1. `/payment-sources` (user-scoped CRUD)

Row: `{ id, user_id, name, type, bank, target_team_id, default_category_id, active,
created_at, updated_at, deleted_at }`.

- `POST` body `{ name, type, bank?, target_team_id?, default_category_id?, active? }`
  - `type` ∈ `account | credit_card` → else `400 { "error": "type must be account or credit_card" }`
  - missing `name`/`type` → `400 { "error": "Missing required field: <f>" }`
  - `target_team_id` must be a team the caller can **write** to (owner/member; admin: any team)
    → else `400 { "error": "target team must be one you can write to" }`. `null` = personal.
  - `active` accepts booleans, stored/returned as `1`/`0` (default `1`).
- `GET /payment-sources` — filterable `?type=&bank=&active=`. `GET/PUT/DELETE /:id` as usual
  (PUT: any subset of the create fields, same validations).
- `DELETE` **cascades the soft delete to the source's aliases**. Captures/transactions keep
  their `source_id` for history.

## 2. `/source-aliases` (user-scoped CRUD, top-level — not nested)

Row: `{ id, user_id, source_id, channel, match_kind, value, created_at, updated_at, deleted_at }`.

- `POST` body `{ source_id, channel, match_kind, value? }`
  - `source_id` must be one of the caller's sources → else
    `400 { "error": "source_id must be one of your payment sources" }`
  - `match_kind` ∈ `card_last4 | channel_default` → else `400`
  - `card_last4`: `value` exactly 4 digits → else `400 { "error": "value must be exactly 4 digits" }`;
    duplicate `(channel, value)` → `400 { "error": "alias already exists for this channel and card" }`
  - `channel_default`: `value` must be absent/`null` → else `400`; second default on a channel →
    `400 { "error": "channel already has a default alias" }`
- `GET` filterable `?source_id=&channel=`. PUT validates the post-update state with the same rules.

## 3. `POST /captures` — the ingest endpoint

Body (decimal `amount`, all money as usual):

```json
{ "channel": "google_wallet", "kind": "purchase", "direction": "out", "amount": 129.50,
  "merchant_raw": "OXXO", "last4": "0347", "captured_at": "2026-07-02T18:03:00Z",
  "notification_hash": "h1" }
```

- Required: `channel`, `direction` (`in|out`), `amount` (> 0), `captured_at` (ISO-8601).
  Optional: `kind` (`purchase|transfer|unknown`, default `unknown`), `merchant_raw`, `last4`,
  `notification_hash`. Malformed → `400`; a **well-formed capture never gets a 4xx outcome** —
  resolution failures land it `pending`.
- Response `201` with the capture row; **re-sent `notification_hash` → `200` with the original
  capture** (idempotent, no new row, no new transaction).

Capture row:

```json
{ "id": 7, "user_id": 1, "channel": "google_wallet", "kind": "purchase", "direction": "out",
  "amount": 129.5, "merchant_raw": "OXXO", "last4": "0347",
  "captured_at": "2026-07-02T18:03:00Z", "notification_hash": "h1",
  "status": "posted", "source_id": 1, "duplicate_of": null, "transaction_id": 18,
  "created_at": "...", "updated_at": "...", "deleted_at": null }
```

`status` tells the outcome: `posted` (+ `transaction_id`), `duplicate` (+ `duplicate_of`),
or `pending` (review inbox). Pipeline, in order:

1. **Exact dedup** — `(user, channel, notification_hash)` seen before → `200` original capture.
2. **Alias match** — `last4` → `card_last4` alias on that channel; **an unregistered last4 falls
   back to the channel's `channel_default`** (deviation, see §7); no `last4` → `channel_default`
   directly. No match → `pending`.
3. **Cross-channel dedup** — a live capture (not `duplicate`/`discarded`) with the same
   `source_id`, `amount`, `direction` within **±5 minutes** of `captured_at` → new capture saved
   as `duplicate` with `duplicate_of` = the earlier capture (first-in survives).
4. **Auto-post** — transaction created atomically in the source's `target_team_id` context
   (`null` = personal): `type` = `in`→`income`/`out`→`expense`, `description` = `merchant_raw`,
   `occurred_at` = date part of `captured_at`, `category_id` = source's `default_category_id`.
   Capture → `posted`. **Any failure** (available-never-negative rule, routed team no longer
   writable) → capture stays `pending`; ingest still returns `201`.

## 4. Review actions + inbox reads

- `GET /captures?status=pending` — the review inbox (also filterable `?channel=&source_id=`).
- `POST /captures/:id/confirm` body `{ source_id, team_id?, category_id? }` — own `pending`
  captures only (else `404 { "error": "Capture not found" }`). Links the source and runs steps
  3–4. Overrides beat the source's defaults; a bad override is an **interactive** error here:
  missing/foreign `source_id` → `400`; unwritable `team_id` →
  `400 { "error": "team must be one you can write to" }`. Returns `200` capture (normally
  `posted`; `duplicate`/`pending` possible if dedup hits or posting fails).
- `POST /captures/:id/discard` — `pending` → `200` capture with `status: "discarded"`.
- `DELETE /captures/:id` — standard soft delete (`204`); posting history survives via
  `transactions.capture_id`.

## 5. Automation tokens (`/auth/tokens`)

- `POST /auth/tokens { name }` → `201 { "id": 3, "name": "iphone-shortcut", "token": "<JWT>" }`.
  **The token is shown once** — store it in the automation. Long-lived (**365 d**), backed by a
  session row (`scope: 'ingest'`), sent as a normal `Authorization: Bearer <token>` header.
- Scope enforcement: an ingest token may call **only `POST /captures`** — anything else
  (including `/auth/logout` and `/auth/tokens`) → `403 { "error": "ingest-scoped token" }`.
- `GET /auth/tokens` → `[{ id, name, issued_at, expires_at }]` (own, non-revoked).
- `DELETE /auth/tokens/:id` → `204` (revoked immediately; the JWT then 401s), `404` if not yours.

## 6. Transactions — provenance fields

`GET /transactions[/:id]` rows now include `source_id`, `capture_id`, `transfer_group_id`
(`null` on manual rows; `capture_id` non-null = auto-captured). They are **not writable**:
`POST`/`PUT /transactions` ignore them entirely (stamped server-side by the pipeline only).
Everything else about the ledger (positive amounts, `type` carries the sign, available-never-
negative, `?team_id=` scoping) is unchanged.

## 7. Deviations from the request doc

1. **last4 fallback to `channel_default`** (step 2): an *unregistered* card number from a channel
   that has a default alias resolves to that default instead of going to the inbox — a channel
   with a default maps to a single pot, so it's unambiguous, and it spares one alias per card
   (the worked example's `nu_app card_last4 0347` alias is now optional).
2. **Provenance stamping**: `source_id`/`capture_id` are set by a direct server-side UPDATE after
   the transaction insert, rather than being create-fields stripped from public bodies — same
   invariant (never client-writable), less surface.
3. **Cross-channel dedup canonicality**: the *earlier* capture survives regardless of channel
   ("first survives"); the bank-is-canonical preference from §8 research is deferred as a
   refinement, per the plan notes.
4. Aliases are **top-level** (`/source-aliases`), not nested under `/payment-sources/:id`.
5. `confirm` supports both `team_id` and `category_id` overrides (request marked them optional).
6. Everything else — window (±5 min), pending fallback behavior, idempotent `200`, error
   messages — is verbatim from the request doc. All acceptance curls pass (encoded as the
   integration suite `test/integration-test/captures/captures.pipeline.test.js`, 15 scenarios).

## 8. Migration note (nothing to run)

On every boot and `npm run migrate`: new tables are created via `CREATE TABLE IF NOT EXISTS`;
existing DBs get `transactions.source_id/capture_id/transfer_group_id` and
`sessions.name/scope` via guarded `ALTER TABLE`s (`PRAGMA table_info` checks). Dev/stage DBs
upgrade in place, no data loss.

## 9. `/transfers` (Slice 2)

### `POST /transfers`

Body `{ amount, from_team_id?, to_team_id?, description? }` — `null`/omitted end = personal.

Response `201`:

```json
{ "transfer_group_id": "6f9c…-uuid", "from": { …expense tx, "team_id": null }, "to": { …income tx, "team_id": 4 } }
```

- Atomically creates the two legs, both carrying the shared `transfer_group_id` and
  `description` (default `"Transfer"` when omitted — client may prefer sending a localized one).
- Guards: `amount > 0` → else `400`; `from === to` (both personal or same team) →
  `400 { "error": "from and to contexts must differ" }`; unknown team →
  `404 { "error": "Team not found" }`; non-member → `403`; **guest on either end** →
  `403 { "error": "Guests have read-only access" }`; expense leg over the from-context's
  available → `400 { "error": "Insufficient available balance: …" }`.

### `DELETE /transfers/:group_id` → `204`

- Soft-deletes **both** legs atomically. `404` when no live legs, or when the caller is related
  to none of them; `403` when they can see the transfer but lack write rights on a leg
  (guest; member deleting another's transfer). Blocked with the standard available-balance
  `400` when removing the **income leg** would strand vaulted money in its context.

### Leg immutability

`PUT`/`DELETE /transactions/:id` on any row with a `transfer_group_id` →
`400 { "error": "part of a transfer — delete the transfer instead" }`. Mirror it in the UI:
render the pair as one transfer, no per-leg edit/delete affordances.

### Slice 2 deviations

None of substance: error semantics follow the house pattern (`404` hides what you can't see,
`403` denies what you can see), and the income-leg vault guard rejects the whole delete, as
requested. Suite: `test/integration-test/transfers/transfers.test.js` (7 scenarios).
