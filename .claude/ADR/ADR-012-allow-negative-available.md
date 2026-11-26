# ADR-012 — Allow negative available

- **Status:** Accepted (BE `balance`) — supersedes in part ADR-004 ("available can never go negative")
- **Date:** 2026-11-26

## Context
ADR-004 rejected any transaction write that pushed `available` below zero. In practice the owner
overspends (and, with credit cards, pays the card from the balance) and wants the ledger to reflect it
instead of refusing the write.

## Decision
- Transaction writes (create/edit/delete), shopping-list checkout and card payments may leave
  `available < 0`. No guard, no special status code.
- Vault **allocate** and loan **lend** keep `amount <= available` (you can't lock or lend money you
  don't have); vault and loan balances stay non-negative.

## Consequences
- `available` is a signed figure; clients must render negatives (FE ADR-022).
- One fewer aggregate query on transaction writes.
- ADR-004's "Allow available to go negative — rejected" alternative is now the chosen path.
