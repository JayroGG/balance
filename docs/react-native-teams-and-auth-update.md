# Frontend update — Teams (shared finance) + Login

Brief for the React Native agent. Two backend changes you must integrate:
1. **Auth** — every request now needs a Bearer token (login/logout flow below).
2. **Team context** — transactions, vaults, categories, and balance are now either **personal** or **team** scoped via a `?team_id=` query param.

The response **shapes are unchanged**; rows just gained a `team_id` field. The FE decides how to present personal vs team separation.

---

## 1. Auth

### Login flow
1. `POST /auth/login` with `{ "email", "password" }` → `200 { "token" }` (a JWT, valid 7 days).
2. Store the token; send it on **every** other request as header `Authorization: Bearer <token>`.
3. `POST /auth/logout` (with the header) → `204`. The token is **immediately dead** server-side (real logout, per device).
4. No refresh token. On `401`, treat the session as over → drop the token and route to login.

### Rules
- Any failure (wrong password, unknown email, inactive/unverified user) returns the **same** `401 { "error": "Invalid credentials" }` — don't try to distinguish them in the UI.
- Missing / malformed / expired / revoked token on a protected route → `401 { "error": "Unauthorized" }`.
- `/auth/login` is the only public route. Everything else requires the header.

> Dev note: while the backend runs with `AUTH_BYPASS=true` (stage), requests work **without** a token and act as user 1. Build the FE to always send the token anyway — production has bypass disabled.

---

## 2. Team context (`?team_id=`)

These endpoints accept an optional `team_id` **query param** — omit for personal, pass a team id for that team:

| Endpoint | No `team_id` (personal) | `?team_id=T` (team) |
|---|---|---|
| `GET /transactions` | my personal transactions | team T's transactions (all members') |
| `POST /transactions` | creates a personal one | creates one owned by me, tagged to team T |
| `GET/PUT/DELETE /transactions/:id` | personal row | team T row |
| `GET /vaults`, `POST /vaults`, `/vaults/:id/*` | personal vaults | team T vaults |
| `GET /categories`, `POST /categories`, `/:id` | personal categories | team T categories |
| `GET /balance` | personal totals | team T totals |

**Critical rules:**
- **Never put `team_id` in the request body.** It is taken from the query param only; the server injects it. Sending it in the body does nothing.
- Personal and team data are **fully separate** — personal transactions/vaults/**categories** never appear in a team list and vice-versa. A team starts with **no categories**; create them in team context.
- To act in a team you must be a **member** of it (see Teams API). Passing a `team_id` you're not in → `403`.
- Existing personal screens keep working unchanged (just omit `team_id`).

Each record now includes `team_id` (`null` = personal). Same fields otherwise.

---

## 3. Teams API (new)

| Method | Path | Body | Who | Notes |
|---|---|---|---|---|
| `GET` | `/teams` | — | any | teams **I belong to** (owner or member) |
| `POST` | `/teams` | `{ name }` | any | creates team; I become `owner` |
| `GET` | `/teams/:id` | — | member | team detail |
| `PUT` | `/teams/:id` | `{ name }` | owner | rename |
| `DELETE` | `/teams/:id` | — | owner | soft-delete the team |
| `GET` | `/teams/:id/members` | — | member | `[{ user_id, role, email }]` |
| `POST` | `/teams/:id/members` | `{ email }` or `{ user_id }`, optional `role` (`member`/`owner`, default `member`) | owner | add a member; returns the member list |
| `DELETE` | `/teams/:id/members/:userId` | — | owner | remove a member |

Membership rules to surface:
- Only an **owner** can add/remove members or edit/delete the team.
- Adding by an email that has no user → `404 { "error": "User not found" }`.
- You **cannot remove the last owner** of a team → `400`.

---

## 4. Errors to expect

All errors are `{ "error": "<message>" }` with these statuses:

| Status | When |
|---|---|
| `400` | bad input (missing field, invalid `team_id`); **business rule broken** — e.g. expense/allocate beyond available, withdraw beyond vault balance, deleting a non-empty vault, removing the last owner |
| `401` | no/invalid/expired/revoked token, or failed login |
| `403` | passing a `team_id` for a team you're not a member of; member-only action attempted by a non-member; owner-only action by a non-owner |
| `404` | resource not found, unknown `team_id`, add-member email not found |

**Business restrictions the UI should enforce/expect (per context — personal or the selected team):**
- Spendable money can't go negative: creating an expense, increasing an expense, decreasing/deleting income, or **allocating to a vault** beyond `available` → `400`. Read `available` from `GET /balance` (optionally with `?team_id=`).
- Vault **withdraw** can't exceed that vault's balance → `400`.
- A vault can only be **deleted** when its balance is `0` → `400`.
- `amount` is always a **positive decimal**; `type` (`income`/`expense`) carries the sign.

---

## 5. Practical integration checklist

- [ ] Add a login screen → `POST /auth/login`, persist token (secure storage).
- [ ] Attach `Authorization: Bearer <token>` to every API call.
- [ ] Global `401` handler → clear token, go to login.
- [ ] Logout button → `POST /auth/logout`, then clear token.
- [ ] A context switcher (Personal / each of my teams from `GET /teams`); when a team is selected, append `?team_id=<id>` to transactions/vaults/categories/balance calls.
- [ ] Never send `team_id` in bodies.
- [ ] Team management screen (create team, list/add/remove members) using the Teams API.
- [ ] Surface `400` business messages (insufficient available, etc.) to the user.
