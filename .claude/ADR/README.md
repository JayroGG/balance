# Architecture Decision Records (ADR)

This directory is the **decision log** for the project. Each ADR captures one significant
architectural or product decision: the context, what we decided, and the consequences.

ADRs are **append-only and immutable**. We don't rewrite history — when a decision changes,
we add a new ADR that **supersedes** the old one and flip the old one's status to `Superseded`.

## Why we keep ADRs

- **Durable memory.** Six months later, "why did we do it this way?" has a written answer.
- **Aim high, ship lean.** We record the *north-star* decision even when the MVP deliberately
  bypasses it (e.g. "Auth0 is the target; the prototype ships DB-hashed auth"). The gap is
  intentional and documented, not forgotten.
- **Agent-friendly.** Any agent (Claude Code or otherwise) can read the log and understand the
  system's trajectory without re-deriving it from code.

## How to write one

1. Copy `ADR-000-template.md` to `ADR-NNN-short-kebab-title.md` (next free number).
2. Fill in Context → Decision → Consequences → Alternatives.
3. Set the status. Link related/superseded ADRs by filename.
4. Add a row to the index below.

Statuses: `Proposed` · `Accepted` · `Deprecated` · `Superseded by ADR-NNN`.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| [ADR-001](ADR-001-auth-strategy.md) | Authentication as a modular layer (DB-hashed now, Auth0 north star) | Accepted |
| [ADR-002](ADR-002-documentation-and-workflow-standard.md) | Documentation & agent-workflow standard | Accepted |
| [ADR-003](ADR-003-session-validation.md) | Stateful session validation over JWT (DB-backed sessions) | Proposed (deferred) |
| [ADR-004](ADR-004-vault-allocation-model.md) | Vaults decoupled from transactions; amount-based allocation over a derived-balance ledger | Accepted (`available ≥ 0` superseded in part by ADR-012) |
| [ADR-005](ADR-005-team-rbac.md) | Team RBAC: owner/member/guest with a two-gate (method + ownership) model | Accepted |
| [ADR-006](ADR-006-global-admin-role.md) | Global admin role (platform super-admin) overriding team RBAC | Accepted |
| [ADR-007](ADR-007-testing-harness.md) | Jest + supertest harness over a throwaway SQLite file | Accepted |
| [ADR-008](ADR-008-shopping-lists-checkout.md) | Shopping lists: a pre-expense checklist that books one expense at checkout | Accepted |
| [ADR-009](ADR-009-activity-events-ledger.md) | Activity events ledger: a polled feed now, remote push as a delivery channel later | Accepted |
| [ADR-010](ADR-010-loans-lent-money.md) | Loans as receivables: a second vault-shaped ledger with journal transactions | Accepted |
| [ADR-011](ADR-011-transactions-search-pagination.md) | Transactions search, date range and keyset pagination | Accepted |
| [ADR-012](ADR-012-allow-negative-available.md) | Allow negative available (supersedes ADR-004's `available ≥ 0` in part) | Accepted |
| [ADR-013](ADR-013-multi-category-transactions.md) | Multiple categories per transaction (tags) | Accepted |
