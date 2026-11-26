# Mobile contract update — credit cards (ADR-014)

Additive except `GET /transactions` totals (new key). Run `npm run migrate` on stage/prod before the new
code serves traffic: it rebuilds `transactions` (new `card_id` column, `card_payment` type), idempotent.

## Model

- A **charge** is an `expense` with `card_id`. It is a spend (expense totals, category filters, list rows)
  but does **not** change `total`/`available` — cash hasn't moved.
- A **payment** (`type: "card_payment"`, `card_id` set) reduces `total`/`available` and is **not** a spend.
  `available` may go negative (ADR-012).
- Nothing is stored on the card. Per card: `owed = Σcharges − Σpayments`.

## Cards — `/cards` (context-scoped: `?team_id=`; guests read-only, members edit own cards, owners all)

```json
POST /cards { "name": "Visa", "cut_day": 5, "due_day": 25, "credit_limit": 5000 }   // credit_limit optional/null
```

- `cut_day`, `due_day`: integers 1..31 (clamped to the month length: 31 in February = 28/29). `400` otherwise.
- `GET /cards`, `GET /cards/:id`, and every write response carry:

| field | meaning |
|---|---|
| `owed` | all charges − all payments |
| `statement_balance` | `max(0, charges dated ≤ last_cut − all payments)` — what to pay by `due_date` |
| `current_period` | charges dated after `last_cut` (open period) |
| `last_cut` | latest cut date ≤ today (`YYYY-MM-DD`, UTC) |
| `due_date` | first due-day date after `last_cut`. Not rolled forward while unpaid: a past `due_date` with `statement_balance > 0` is **overdue** |
| `credit_limit` | decimal or `null` |

- `DELETE /cards/:id` → `400` while `owed > 0` (history of a deleted card stays in `/transactions`).

## Pay — `POST /cards/:id/pay`

```json
{ "amount": 500, "occurred_at": "2026-11-12" }   // occurred_at optional (default today)
```

- `201` with the updated card. `400` if `amount <= 0`, `amount > owed` (`Cannot pay more than the card owes`) or bad date.
- Full statement = send `statement_balance`; partial or any amount up to `owed` also works.
- Posts into the card's own context (team card → team balance).

## Transactions

- `POST/PUT /transactions` accept `card_id` (int, or `null` on PUT to move a charge back to cash). Only for
  `type: "expense"`; the card must be a live card of the **same context** as the transaction, else `400`.
- Rows carry `card_id` (null for cash). `GET /transactions?card_id=<id>` filters; `?type=card_payment` lists payments.
- `type: "card_payment"` cannot be created or edited here (`400`); `DELETE /transactions/:id` on a payment is
  allowed and restores the debt.
- `400` if a write would leave a card owing less than 0 (shrinking, moving, retyping or deleting a charge
  below what was already paid).
- **Totals** gain `card_payments`: `{ income, expense, card_payments, net, count }`. `expense` includes
  charges; payments are in neither `income` nor `expense`, so `net = income − expense` is spend-based.

## Balance — `GET /balance`

Adds `cards_owed` (Σ owed over live cards) and `cards: [{ id, name, owed, statement_balance, due_date }]`.
`total`/`available` stay cash-only. Dashboard "next due": the card with `statement_balance > 0` and the
earliest `due_date`.

## Events

`card` entity: `created`, `updated`, `deleted`, `paid` (summary `{ name, amount }` on `paid`). A payment logs
no `transaction` event; a card charge's transaction event summary includes `card_id`.

## Worked example (today 2026-11-20, cash 10,000, cut 5 / due 25)

| step | owed | statement_balance | due_date | current_period | available |
|---|---|---|---|---|---|
| charges 1,200 (11-02) + 800 (11-10) | 2,000 | 1,200 | 2026-11-25 | 800 | 10,000 |
| pay 500 | 1,500 | 700 | 2026-11-25 | 800 | 9,500 |
| pay 700 | 800 | 0 | 2026-11-25 | 800 | 8,800 |
