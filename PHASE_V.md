# Phase V Execution Plan

Date: 2026-03-04

## Objective

Implement the Five Aggregates companion state architecture as described in `docs/PHASE_V_VISION.md`. Four foundation epics plus a stabilization pass deliver continuous emotion, intention tracking, agentic context composition, distributed autonomy, and an integrated self-model.

## Prerequisite

`PSFN-4tnb` — Phase IV.V stabilization (bugfix and infra hardening) must close before Phase V epics begin.

## Epics

| # | Epic | Beads ID | Summary |
|---|------|----------|---------|
| 1 | Continuous Emotion System | `PSFN-bu5f` | Valence/arousal classifiers, emotion state store, affect-weighted memory retrieval, mood decay |
| 2 | Intention & Active Concern Tracking | `PSFN-8e3t` | Concern lifecycle (notice→track→act→resolve), intention store, proactive follow-up, goal persistence |
| 3 | Agentic Context Composition | `PSFN-domy` | Helper-LLM context curation, retrieval-augmented prompt assembly, memory budget negotiation |
| 4 | Distributed Autonomy | `PSFN-17lw` | Shard orchestration improvements, upstream alignment protocol, capability-scoped subagents |
| 5 | Integrated Self-Model | `PSFN-be11` | Experience integration, metacognitive loop, values journal synthesis, self-model persistence |

Epics 1-3 can proceed in parallel. Epic 4 is independent. Epic 5 depends on epics 1 and 2.

Additional foundation work tracked in `PSFN-04dt` (turn provenance, loop contracts, policy gates, evidence-aware memory) feeds into multiple epics above.

## Branch Strategy

- Create `phase-v` as the dedicated integration branch for all Phase V work.
- All Phase V worktrees branch from `phase-v` and merge back into `phase-v`.
- `main` remains protected as the public release target.
- After Phase V completion: merge `phase-v` into `main`.

## Work Process

1. Use up to three parallel streams (worktrees + sub-agents).
2. Each stream owns one epic or a slice of subtasks within an epic.
3. Orchestrator assigns beads, manages dependency order, resolves merges, runs test gates.
4. Every merge into `phase-v` must pass `npm run build && npm test`.
5. Beads are updated/closed as work completes.

## Verification

- `npm run build` — zero errors
- `npm test` — all tests pass
- `npm run e2e` — end-to-end suite green
- Manual validation with companion instance before `main` merge
