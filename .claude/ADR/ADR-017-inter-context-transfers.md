# ADR-017 — Inter-context transfers

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Jayro Gómez
- **Related:** ADR-004 (derived balance), ADR-005 (team RBAC), ADR-006 (global admin), ADR-009 (events),
  ADR-012 (negative available), ADR-014 (cards), ADR-018 (step-up auth)

## Context
Every write so far touches one context resolved from `?team_id=`. Owners need to move money between
contexts they own (personal <-> team, team <-> team). This is the first inter-context write, so RBAC,
ledger and audit need a rule that spans two contexts.

## Decision
- **Entity:** `transfers` is a first-class, append-only, auditable entity (`/transfers`). Rows are
  never updated or deleted. Each transfer also books one `transactions` row per context
  (`transfer_out` / `transfer_in`, linked by `transfer_id`) so balance math, feeds and search keep working.
- **Authorization:** caller must be a REAL owner (`team_members.role = 'owner'`) of both contexts;
  personal = the caller's own. **No global-admin bypass**, and admin `?user_id=` targeting is rejected.
  Checked on create and on reversal. Reads: any role of either context.
- **Funds:** a transfer never makes the source negative. If available < amount, the caller covers the
  exact gap from one or more source vaults; each part is a `vault_history` withdraw linked to the
  transfer. No vault parts allowed when available covers the amount. Money lands in the destination's
  available.
- **Rollback = reversal ("devolución"), no edit, no delete:** a new transfer with `reversal_of` =
  original, opposite direction, same amount, dated today, booking its own `transfer_out`/`transfer_in`
  rows and vault allocates that return the original vault parts (to available if the vault was
  deleted, or when the source's available cannot take it back into a vault without going negative, ADR-012). One reversal per transfer; reversals can't be reversed. Blocked when the original
  destination's available < amount. Past periods' figures never change.
- **Accounting:** transfers move net worth/available but are not income or expense; excluded from
  income/expense and category totals; no categories. Rows attributed to the actor.
- **Events:** `transfer_sent` (source), `transfer_received` (destination), `transfer_reversed` (both).
- **Labels:** rows expose `counterpart_label` = team name or `<email local part> (personal)`.
- **Card charges (recorded here, no change):** a team member may charge an expense to any team card
  (shared payment method); edit/pay/delete of the card stays owner-or-creator per ADR-005.
- All writes in one `db.transaction`.

## Consequences
- Positive: auditable money movement between contexts; balances stay ledger-derived; no negative sources.
- Negative: `transactions` CHECK rebuild migration; a transfer's visibility crosses contexts (team members
  see the owner's email local part when money comes from personal).
- Each rollback adds two rows per side to the transactions list (original + devolución) — accepted for
  a full ledger trail.
- A reversal is blocked once the destination spent the money; the fix is a new manual transfer back.
