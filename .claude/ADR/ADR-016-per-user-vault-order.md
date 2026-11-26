# ADR-016 — Per-user vault order

- **Status:** Accepted (BE `balance`)
- **Date:** 2026-11-26

## Context
Vaults have no order; the user wants to drag them into an order shown on the Vaults screen and the
dashboard. Team vaults are shared, so a column on `vaults` would force one order on every member.

## Decision
- Table `vault_order(user_id, vault_id, position)`, PK `(user_id, vault_id)`.
- `PUT /vaults/order {ids}` replaces the caller's positions for those ids in one transaction; ids must be
  visible in the request context.
- Vault list and balance summary sort by the caller's position, then unordered vaults by `created_at`.

## Consequences
- Each member keeps their own order; new vaults appear last until moved.
- Reordering is a personal display preference, so every team role (guests included) may call it; it never
  touches shared vault data. Vaults left out of `ids` that already had a position follow the given ones.
