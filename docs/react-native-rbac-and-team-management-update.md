# Frontend update — Team roles (RBAC) + Team Management screen

Brief for the React Native agent. Backend just shipped **role-based access control** inside teams and
the **full team-management API**. This supersedes the role bits in
`react-native-teams-and-auth-update.md` (§2.1 / §3) and adds a screen spec. Auth and `?team_id=`
context behavior are unchanged — see that doc for the basics.

**TL;DR**
- Every membership now has a **role**: `owner | member | guest`. `GET /teams` returns your role per team.
- **Reads are open to all roles.** Writes depend on role (and, for members, on who created the row).
- Team management (create/rename/delete, add/remove members, promote/demote) is a **single screen**,
  owner-gated.

---

## 1. The role model (what each role can do in a team)

| Role | See data | Add data | Edit / delete / allocate / withdraw | Manage team & members |
|---|---|---|---|---|
| **owner** | ✅ all | ✅ | ✅ **any** row (admin) | ✅ |
| **member** | ✅ all | ✅ | ✅ **only rows they created** | ❌ |
| **guest** | ✅ all | ❌ | ❌ (read-only) | ❌ |

- "Created by me" = `record.user_id === myUserId`. Every transaction/vault row carries `user_id`.
- **Personal context** (no `team_id`) is always fully yours — unchanged, no role gating.
- Get `myUserId` from the JWT (`sub` claim) or persist it at login. You need it to decide member
  edit/delete affordances.

### How to gate the UI (do this, don't rely only on the API)
For the **currently selected context**:
- `role === 'guest'` → render the whole context **read-only** (hide every add/edit/delete/allocate button).
- `role === 'member'` → show **Add**; on each row, show **Edit/Delete/Allocate** only when `row.user_id === myUserId`.
- `role === 'owner'` → show all controls on all rows.
- personal (`role` absent / `team_id` null) → all controls (your own data).

The API enforces the same rules and returns **403** if a disallowed write is attempted — treat a 403
as "you don't have permission here" (don't log the user out).

---

## 2. API recap (team management)

All owner-only unless noted. Base behavior + auth in the other doc.

| Method | Path | Body | Notes |
|---|---|---|---|
| `GET` | `/teams` | — | **any user** → `[{ id, name, role, ... }]` (your role per team) |
| `POST` | `/teams` | `{ name }` | **any user**; you become `owner` |
| `PUT` | `/teams/:id` | `{ name }` | rename |
| `DELETE` | `/teams/:id` | — | **blocked unless empty** (no active transactions/vaults) → else `400` |
| `GET` | `/teams/:id/members` | — | **any member** → `[{ user_id, role, email }]` |
| `POST` | `/teams/:id/members` | `{ email, role? }` | add/revive; `role` ∈ `owner\|member\|guest` (default `member`) |
| `PUT` | `/teams/:id/members/:userId` | `{ role }` | promote/demote; returns member list |
| `DELETE` | `/teams/:id/members/:userId` | — | remove member |

Guardrails the UI must surface:
- Add by an email with **no registered user** → `404` ("User not found"). Show "No account for that email."
- **Cannot demote or remove the last owner** → `400`. Disable that action when a team has exactly one owner.
- **Delete blocked unless empty** → `400`. Tell the user to clear/transfer the team's transactions and vaults first.
- Re-adding a previously removed person **works** (revives them) — no special handling needed.

---

## 3. Team Management screen (simple, owner-gated)

One screen reachable from the context switcher / settings. It has two states by role.

### 3a. Teams list (entry point — all users)
Drive from `GET /teams`. Group by `role`: teams you **own** (manageable) vs teams you were **invited
to** (read of membership only). The list doubles as the context switcher.

```
┌──────────────────────────────────────┐
│  Teams                          [ + ] │   ← [+] = create team (any user)
├──────────────────────────────────────┤
│  OWNED                                │
│   • Household            owner   [>]  │   ← tap → Manage screen (3b)
│  MEMBER OF                            │
│   • Trip 2026           member   [>]  │   ← tap → read-only detail (members list)
│   • Family Budget        guest   [>]  │
└──────────────────────────────────────┘
```
- `[ + ]` → prompt `{ name }` → `POST /teams` → refetch list.
- Tap a row → if `role === 'owner'` go to **Manage** (3b); otherwise a **read-only** member list.

### 3b. Manage team (owner only)
```
┌──────────────────────────────────────┐
│  ‹ Household                  [Rename]│   → PUT /teams/:id { name }
├──────────────────────────────────────┤
│  Members                       [+ Add]│   → POST /teams/:id/members
│   • me@x.com            owner          │      { email, role }
│   • ana@x.com           member  [⋯]    │   ⋯ = role picker + Remove
│   • leo@x.com           guest   [⋯]    │
│                                        │
│  [ Delete team ]                       │   → DELETE /teams/:id  (only if empty)
└──────────────────────────────────────┘
```
Interactions:
- **Add member**: form with `email` + role picker (`owner / member / guest`, default `member`) →
  `POST /teams/:id/members`. Handle `404` (no such user) inline.
- **Row ⋯ menu**: change role (`PUT /teams/:id/members/:userId { role }`) and remove
  (`DELETE /teams/:id/members/:userId`).
- **Last-owner protection**: if the team has exactly one owner, disable demote/remove on that owner
  (and still handle the `400` defensively).
- **Rename**: inline edit → `PUT /teams/:id`.
- **Delete team**: confirm, then `DELETE /teams/:id`. On `400` (not empty), show a blocking message:
  "Remove this team's transactions and vaults before deleting." Keep the button disabled or surface
  the reason.
- After every mutation, refetch the member list (the member endpoints already return it on write).

---

## 4. Integration checklist (delta)

- [ ] Persist `myUserId` (JWT `sub`) at login.
- [ ] Store the selected team's `role` alongside the active `team_id`; re-read it from `GET /teams`.
- [ ] Gate financial screens by role (guest read-only; member edit/delete/allocate only on own rows; owner all).
- [ ] Build the Teams list grouped by role (owned vs member-of), with create.
- [ ] Build the owner-only Manage screen: rename, add (email + role), change role, remove, delete.
- [ ] Handle `403` as "no permission" (not logout), `404` add-by-email, `400` last-owner / non-empty-delete.
