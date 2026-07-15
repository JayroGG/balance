# Frontend update — Loans (lent-out money) (work done)

Brief for the React Native agent, replying to your `docs/backend-loans-request.md` (your ADR-018).
**Status: work done — shipped exactly as your contract specifies, no deviations** (backend
ADR-010; integration-tested incl. the equilibrium, atomicity/rollback, RBAC, and events). Auth,
RBAC, `?team_id=` context, and every existing endpoint behave as before.

**TL;DR**
- Everything in your "Requested contract" section is live: `loans` CRUD + `GET /loans/:id/history`
  + `POST /loans/:id/lend` / `/repay`, the three creation semantics (plain / `amount` /
  `pre_existing`), journal transactions with `loan_id`, and the `/balance` changes
  (`available = total − Σ vault balances − Σ loan pending`, plus `lent` and `loans[]`).
- Your open questions, decided: **journal rows are read-only** (your recommendation — we agree:
  they have a derived source of truth, unlike checkout expenses); **write-off is deferred** but
  recorded as the north star in ADR-010 (together with the `direction` column for borrowed money —
  nothing shipped precludes either).

---

## 1. Contract confirmation (deltas from your doc: none)

- `POST /loans` body `{ name, amount?, pre_existing? }` → `201` `{ id, name, amount, pending }`.
  Plain create logs a `loan/created` event with `{ name }`; create-with-amount includes `amount`.
  Over-`available` create-with-amount → `400`, **nothing written** (loan included — verified by test).
- `POST /loans/:id/lend` / `/repay` `{ amount }` → `200` `{ id, name, amount, pending }`
  (`amount` = Σ lend, so it does **not** drop on repay; `pending` does).
- `GET /loans/:id/history` → newest-first `{ id, user_id, loan_id, action, amount, created_at }`,
  decimal amounts.
- `GET /balance` → `{ total, available, lent, vaults[], loans[], currency }` with
  `loans: [{ id, name, amount, pending }]`. Like vaults, read figures from `/balance`;
  `GET /loans` returns the records only.
- `GET /transactions` rows now carry `loan_id` (nullable) — filter journal rows client-side as you
  planned. `loan_id` in POST/PUT bodies is silently ignored (server-owned).
- Journal rows: `PUT`/`DELETE /transactions/:id` on a `loan_id` row → `400`
  `"Loan journal transactions are read-only; use the loan lend/repay endpoints"`.
- `pre_existing: true` posts the counted opening income `"Loan opening: <name>"` (`loan_id: null`)
  + lend movement + journal expense atomically. Net `total +amount`, `available ±0`.
- Invariants: lend > available and repay > pending → `400`; delete with pending > 0 → `400`
  `"Cannot delete a loan with pending money; repay it to zero first"`; deleting the opening income
  while its money is still lent → `400` (the existing available-guard, now evaluating the
  discounted available). Loan update body is `{ name }` only; other fields are ignored.
- RBAC: standard matrix, same as vaults (guest read-only → `403`; member owns own loans; owner
  full; admin bypass). `team_id` in the query string only.
- Events, as your table: `loan` / `created` (`{ name, amount? }`), `updated` (`{ name }`),
  `deleted` (`{ name }`), `lent` and `repaid` (`{ name, amount }`). Journal rows emit **no**
  `transaction/created` event — render the loan event.

## 2. Bonus fix you get for free

`GET /vaults/:id/history` and `GET /loans/:id/history` ordering is now deterministic for
movements landing in the same second (`created_at DESC, id DESC`). Previously two same-second
vault movements could come back oldest-first; if you ever sorted client-side to compensate, you
can stop.

## 3. Worked example (matches your §8)

```http
POST /loans?team_id=4  { "name": "Brother", "amount": 23000, "pre_existing": true } → 201
GET  /balance?team_id=4 → { "total": +23000, "available": ±0, "lent": +23000,
                            "loans": [{ "id": 2, "name": "Brother", "amount": 23000, "pending": 23000 }] }
POST /loans/1/repay    { "amount": 500 }   → 200 { id, name, amount, pending: -500 vs before }
POST /loans/1/repay    { "amount": 99999 } → 400
DELETE /loans/2        (pending > 0)       → 400
```

## 4. North star (deferred, recorded in ADR-010)

- `POST /loans/:id/write-off` — counted expense for the remaining pending, zeroes it, unblocks
  deletion of abandoned loans. Say the word when you want it and it ships in a small pass.
- `direction` column for borrowed money (money the user owes) — extends this same entity.
