# ADR-002 — Documentation & agent-workflow standard

- **Status:** Accepted
- **Date:** 2026-06-25
- **Deciders:** Jayro Gómez
- **Supersedes / Related:** Codifies the practice already used in `balance`, `llm-insights`,
  and `employee-mobile-app`.

## Context

Work on these projects is **agent-driven**: Claude Code (and other agents) navigate the codebase,
plan features, and implement them. For that to be fast, cheap (token-efficient), and high quality,
every repo must expose the same predictable set of documents and follow the same loop. Without a
written standard, each project drifts and every agent re-derives context from scratch — wasting
tokens and producing inconsistent architecture.

This ADR consolidates that standard so it is identical across **all** projects, current and future.

## Decision

Every project ships the following agent- and human-readable artifacts:

**Root-level docs (long-term memory of the project):**

- **`CLAUDE.md`** — tech stack, key commands, architecture summary, key-files map, conventions.
  The first thing an agent reads. Pairs with the global `~/.claude/CLAUDE.md`.
- **`PRD.md`** — product requirements: overview, goals/non-goals, **locked decisions**, data model,
  API surface, and **phases**. The project's product memory.
- **`ARCHITECTURE.md`** — the **graph-style** doc: Mermaid diagrams (ER diagram, balance/data-flow
  flowcharts, request-lifecycle, state diagrams) **plus a directory/file map**. Diagrams are the
  cheapest way to load a mental model — they are required, not optional.
- **`README.md`** — human setup: install, environment config, run/build instructions, endpoint summary.

**`.claude/` (agent working memory):**

- **`.claude/ADR/`** — this decision log. One decision per `ADR-NNN-*.md`, append-only, with an
  index `README.md`. Records *why*, including north-star targets the MVP deliberately bypasses.
- **`.claude/agents/plans/`** — output of `/plan-feature`. Research-first implementation plans,
  one file per feature. No medium/high-complexity code without a plan here.

**Per-project long-term memory (outside the repo):**

- `~/.claude/projects/<path>/memory/` — an auto-maintained **memory graph**: `MEMORY.md` is the
  one-line-per-fact index; each fact is its own file with frontmatter, linked to others via
  `[[name]]`. This is where cross-conversation context lives.

**The workflow loop** (for any non-trivial work):

```
/prime          → load context: CLAUDE.md + PRD.md, git log, structure, memory
/plan-feature   → research first, no code; plan saved to .claude/agents/plans/
/execute        → implement the plan step by step, validate after each task
/commit         → atomic commit, conventional tag (feat:/fix:/refactor:/docs:/…)
```

ADRs are written whenever a decision is significant or deliberately defers a better option.

## Consequences

- **Positive:** any agent gets oriented from the same files every time → fewer tokens, less
  re-derivation, consistent architecture and code quality across projects.
- **Positive:** decisions and their rationale are durable and discoverable; "shoot high, ship lean"
  is captured rather than lost.
- **Negative / trade-offs:** documentation upkeep is real work; docs must be updated alongside code
  or they drift (and stale docs mislead agents). Treat doc drift as a bug.
- **Follow-ups:** new projects start by scaffolding this exact set; the React Native app described
  in `docs/react-native-expo-PRD.md` must adopt it from commit one.

## Alternatives considered

- **Code + README only.** Rejected: forces agents to reverse-engineer intent and decisions on every
  session — expensive and error-prone.
- **A single monolithic doc.** Rejected: mixes concerns, grows unreadable, and can't be diffed by
  concern (requirements vs. decisions vs. architecture vs. plans).
