# ADR-013 — Multiple categories per transaction (tags)

- **Status:** Accepted (BE `balance`)
- **Date:** 2026-11-26

## Context
A transaction had one `category_id`. Real spends often belong to several categories.

## Decision
- Join table `transaction_categories(transaction_id, category_id)`; existing `category_id` values are
  migrated, then the column is dropped (single client, no compat shim).
- Categories are **tags**: the full amount counts under each one. Writes take `category_ids: int[]`
  (deduped, all in the request's scope); reads return `categories: [...]`.
- The search `category_id` filter matches through `EXISTS`; overall totals still count each transaction once.
- `shopping_lists.category_id` stays a single default; checkout books it as a one-item list.

## Consequences
- Per-category totals can sum to more than the overall total — by design.
- List/search queries aggregate categories per row (one extra join/subquery).
