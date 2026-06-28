# Frontend update — Teams (shared finance) + Login

Brief for the React Native agent. Three backend changes you must integrate:
1. **Auth** — every request now needs a Bearer token (login/logout flow below).
2. **Team context** — transactions, vaults, categories, and balance are now either **personal** or **team** scoped via a `?team_id=` query param.
3. **Roles (RBAC)** — within a team you have a role (`owner | member | guest`) that governs what you can do. `GET /teams` now returns your `role` per team; drive screen affordances from it (see §2.1).

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

### 2.1 Roles within a team (RBAC)

Your `role` (from `GET /teams`) decides what you can do in that team's context. **Reads are open to
everyone**; writes differ:

| Role | Read (GET) | Create | Edit / Delete / Allocate / Withdraw |
|---|---|---|---|
| **owner** | all team rows | ✅ | ✅ any row (admin) |
| **member** | all team rows | ✅ | ✅ **only rows you created** |
| **guest** | all team rows | ❌ | ❌ (read-only) |

- A **member** editing/deleting/allocating on a row **someone else created** → `403`. Hide or disable
  those controls on rows where `record.user_id` ≠ the logged-in user (unless you're an owner).
- A **guest** sees everything but can't write → render team screens read-only when `role === 'guest'`.
- **Personal context** (no `team_id`) is always fully yours — full create/edit/delete on your data.

---

## 3. Teams API (new)

| Method | Path | Body | Who | Notes |
|---|---|---|---|---|
| `GET` | `/teams` | — | any | teams **I belong to**; each item includes my `role` |
| `POST` | `/teams` | `{ name }` | any | creates team; I become `owner` |
| `GET` | `/teams/:id` | — | any member | team detail |
| `PUT` | `/teams/:id` | `{ name }` | owner | rename |
| `DELETE` | `/teams/:id` | — | owner | soft-delete the team (must be empty) |
| `GET` | `/teams/:id/members` | — | any member | `[{ user_id, role, email }]` |
| `POST` | `/teams/:id/members` | `{ email }` or `{ user_id }`, optional `role` (`owner`/`member`/`guest`, default `member`) | owner | add/revive a member; returns the member list |
| `PUT` | `/teams/:id/members/:userId` | `{ role }` (`owner`/`member`/`guest`) | owner | **promote/demote**; returns the member list |
| `DELETE` | `/teams/:id/members/:userId` | — | owner | remove a member |

Membership rules to surface:
- Only an **owner** can add/remove members, change roles, or rename/delete the team.
- `GET /teams` returns each team tagged with your `role` — use it to group owned-vs-invited and to gate UI.
- Adding by an email that has no user → `404 { "error": "User not found" }`. Re-adding a previously removed member works (it revives them with the given role).
- You **cannot remove or demote the last owner** of a team → `400`.
- A team can only be **deleted when empty** (no active transactions or vaults) → otherwise `400`.

---

## 4. Errors to expect

All errors are `{ "error": "<message>" }` with these statuses:

| Status | When |
|---|---|
| `400` | bad input (missing field, invalid `team_id`); **business rule broken** — e.g. expense/allocate beyond available, withdraw beyond vault balance, deleting a non-empty vault, removing the last owner |
| `401` | no/invalid/expired/revoked token, or failed login |
| `403` | passing a `team_id` for a team you're not a member of; owner-only action by a non-owner; **guest** attempting any write; **member** editing/deleting/allocating on a row they didn't create |
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
- [ ] Gate UI by `role`: read-only for `guest`; for `member` hide edit/delete/allocate on rows they didn't create; full controls for `owner`.
- [ ] Team management screen (create team, rename/delete, list/add/remove members, **change role**) — owner-only controls; uses the Teams API.
- [ ] Surface `400` business messages (insufficient available, etc.) to the user.
