# Frontend update — Activity feed (`GET /events`) (work done)

Brief for the React Native agent. **Status: work done — shipped exactly as specified below, no
contract deviations** (ADR-009; integration-tested incl. scoping, filters, atomic checkout events).
Auth, RBAC, `?team_id=` context, and every existing endpoint are unchanged.

**TL;DR**
- New read-only endpoint: `GET /events` — an append-only activity feed ("Ana added an expense of
  12.50", "Luis checked Milk off Groceries"). Context-scoped exactly like `/transactions`:
  omit `team_id` = your personal actions; `?team_id=N` = everything every member did in that team.
- Newest first. Poll it (on screen focus / pull-to-refresh / interval); `since_id` gives you
  incremental fetch + unread badge. There is **no push** in this phase — the feed IS the
  notification surface. Remote push (Expo Push) is the recorded north star and will reuse this
  same data later; nothing you build here gets thrown away.
- No write routes exist on `/events`. Events are immutable server-side history.

---

## 1. Endpoint

### `GET /events?team_id=&entity=&action=&since_id=&limit=`

| Param | Meaning |
|---|---|
| `team_id` | optional — standard context switch (member-gated, `403` if not a member, `404` unknown team). Omitted = personal feed (your own actions only). |
| `entity` | optional equality filter — see catalog below |
| `action` | optional equality filter |
| `since_id` | optional — only events with `id > since_id` (use your last-seen id) |
| `limit` | optional — default **50**, max **200** |

`since_id`/`limit` must be positive integers, else `400 { "error": "..." }`.
Guests **can** read the feed (reads are open to all roles). Requires the usual `Authorization: Bearer`.

Response `200` — array, newest first:

```json
[
  {
    "id": 42,
    "user_id": 2,
    "actor_email": "ana@test.local",
    "team_id": 5,
    "entity": "transaction",
    "entity_id": 77,
    "action": "created",
    "summary": { "type": "expense", "amount": 12.5, "description": "Pizza" },
    "created_at": "2026-07-14T18:00:00Z"
  }
]
```

- `user_id`/`actor_email` = **who did it** (already-joined; no extra member lookup needed for display).
- `entity_id` = the affected record's id (for deep-linking to the transaction/vault/list screen).
- `summary` = display snapshot at the time of the event. **Amounts are decimals**, same convention
  as everywhere else. A referenced record may since be edited or soft-deleted — render from
  `summary`, and treat a `404` on deep-link as "gone", as usual.
- `created_at` ISO-8601 UTC (parse with luxon, as elsewhere).

## 2. Event catalog

| `entity` | `action` | `summary` | Suggested rendering |
|---|---|---|---|
| `transaction` | `created` / `updated` / `deleted` | `{ type, amount, description }` | "{actor} added an expense of {amount}" |
| `vault` | `created` / `deleted` | `{ name }` | "{actor} created vault {name}" |
| `vault` | `allocated` / `withdrawn` | `{ name, amount }` | "{actor} moved {amount} into {name}" |
| `shopping_list` | `created` / `deleted` | `{ name }` | "{actor} started list {name}" |
| `shopping_list` | `checked_out` | `{ name, amount, transaction_id }` | "{actor} checked out {name} — {amount}" |
| `shopping_list_item` | `created` / `updated` / `deleted` | `{ list_id, name, checked }` | "{actor} checked off {name}" when `checked` |
| `team` | `updated` | the applied patch (`{ name?, color? }`) | "{actor} renamed the team" |
| `team` | `member_added` / `role_changed` | `{ user_id, role }` | "{actor} added a member as {role}" |
| `team` | `member_removed` | `{ user_id }` | "{actor} removed a member" |

Not logged (deliberate, may come later): categories CRUD, vault/list renames, team create/delete.
Render unknown `entity`/`action` values generically (e.g. "{actor} · {entity} {action}") so future
event types don't crash the feed.

Note: on shared-list **checkout**, the event lands in the **list's own team feed** with the person
who checked out as actor — even if they triggered it from a different active context.

## 3. Suggested client behavior (your call)

- **Feed screen** per context (personal + each team), reachable from the dashboard; pull-to-refresh.
- **Unread badge**: persist the last-seen `id` per context; badge = count of
  `GET /events?since_id=<lastSeen>` on app focus. Mark seen when the feed screen is opened.
- **Optional local notification**: on foreground fetch, if unread events exist, fire a local
  notification via `expo-notifications` — a zero-infra stand-in until remote push exists.
- Polling interval: on-focus + manual refresh is enough for the MVP; skip background timers.

## 4. What this is NOT (yet)

- No remote push, no websockets, no per-event read receipts, no server-side unread state.
- North star (recorded in backend ADR-009): Expo Push Service delivering these same events while
  the app is closed — blocked only on a paid Apple Developer account. When that lands, the client
  work is a push-token registration call + notification handlers; the feed screen stays as-is.
