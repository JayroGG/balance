# Mobile contract update — negative available & multiple categories (ADR-012, ADR-013)

Breaking for the transaction body/row shape. Ship BE first, then the app. Run `npm run migrate`
on stage/prod (copies `category_id` into the new tag table, then drops the column).

## 1. `available` can be negative (ADR-012)

- `POST/PUT/DELETE /transactions` and `POST /shopping-lists/:id/checkout` **no longer return `400`**
  for "Insufficient available balance". The write succeeds and `GET /balance` returns a signed
  `total`/`available` (e.g. `-500`). Render negatives (red); don't gate the UI on it.
- Still `400`: `POST /vaults/:id/allocate` and `POST /loans/:id/lend` when `amount > available`
  (with `available <= 0` nothing can be allocated or lent). Vault and loan balances stay non-negative.
- Removed error text: `Insufficient available balance: the amount exceeds spendable money (funds are allocated to vaults)`.

## 2. Multiple categories per transaction (ADR-013)

Request (`POST /transactions`, `PUT /transactions/:id`):

```json
{ "type": "expense", "amount": 500, "category_ids": [3, 7] }
```

- `category_ids`: array of up to 50 positive ints. Duplicates are ignored. `[]` clears all tags;
  omitted on `PUT` leaves them untouched.
- Every id must be a live category of the **same context** as the transaction (personal rows: your
  personal categories; `?team_id=` rows: that team's categories). Otherwise `400`
  `category_ids must reference categories in the same context as the transaction`.
- The old `category_id` key is **rejected with `400`** on `/transactions` (no silent drop).

Response rows (list, search, get, create, update):

```json
{ "id": 9, "type": "expense", "amount": 500, "categories": [{ "id": 3, "name": "Food" }, { "id": 7, "name": "Home" }] }
```

- `category_id` is gone from rows; `categories` is `[]` when untagged, ordered by name. Deleted
  categories are not listed.
- `GET /transactions?category_id=3` returns every transaction tagged with 3. `q` also matches any tag name.
- The full amount counts under each tag: per-category totals can sum to more than the overall total.
  `totals` on an unfiltered search count each transaction once.

Shopping-list checkout: `POST /shopping-lists/:id/checkout { amount, category_ids?, category_id?, occurred_at? }`.
`category_ids` wins; else `category_id`; else the list's default `category_id`; else none. The list's own
`category_id` stays a single default.
