# Phase IV Execution Plan

Date: 2026-03-02

## Objective
Complete all open beads in a strict, dependency-aware sequence using up to three parallel streams.

## Scope Rule
- `PSFN-xfus` is deferred until final sensitive-data cleanup just before repository publication.
- All other open beads are in scope for Phase IV execution.

## Branch Strategy (Phase IV Release Flow)
- Create and use `phase-iv` as the dedicated integration branch for all Phase IV work.
- All Phase IV worktrees branch from `phase-iv` and merge back into `phase-iv` (not `main`).
- `main` remains protected as the public release target branch during execution.
- After Phase IV completion, run manual verification with Operator + PSFN against `phase-iv`.
- Only after manual verification passes: merge `phase-iv` into `main` as the first public release cut.

## Priority and Blocker Order

### P1 foundations first
1. `PSFN-a5ow` — generalized post-turn action inference + deferred executor.
2. `PSFN-ztob` — unified contention/defer behavior across channels + internal scheduler actions.
3. `PSFN-bnm5` and `PSFN-4e6q` (+ `PSFN-4e6q.1/.2/.3`) in parallel as capacity allows.

### P1 blocker chain (Discord trigger stack)
1. `PSFN-9m0s`
2. `PSFN-vee3` (blocked by `PSFN-9m0s`)
3. `PSFN-ek62` and `PSFN-n7p2` (both blocked by `PSFN-vee3`)

### P2 adaptive tools + hardening
1. `PSFN-16uz` epic track:
- `PSFN-16uz.1`
- `PSFN-16uz.2`
- `PSFN-16uz.3` (blocked by `PSFN-a5ow`)
- `PSFN-16uz.4`
2. Remaining P2 hardening:
- `PSFN-e9s7`
- `PSFN-70ki`
- `PSFN-r9z4`
- `PSFN-9vfb`
- `PSFN-4lzh`
- `PSFN-pv62`
- `PSFN-vl9m`

### P3 polish and decomposition
- Execute all remaining P3 beads after P1/P2 priority work is stable.

## Operating Instructions (Orchestrator Mode)

1. Use up to three parallel streams at a time.
2. Each stream must use its own worktree and sub-agent.
3. The orchestrator does not implement feature code directly.
4. The orchestrator only:
- assigns bead ownership,
- manages progress and dependency order,
- resolves merge conflicts,
- merges completed worktrees into `main`,
- runs validation/test gates,
- updates and closes beads.

## Standard Execution Loop (Repeat Until Done)

1. Select next three highest-priority ready beads (dependency-safe).
2. Create three worktrees (one per bead/stream).
3. Spawn one sub-agent per worktree with explicit scope ownership.
4. Require each sub-agent to:
- implement only its assigned bead,
- run targeted tests,
- commit in its worktree.
5. When all streams report done:
- merge each worktree back to `phase-iv`,
- resolve conflicts at orchestrator level only.
6. Run validation on `phase-iv`:
- required targeted tests for merged areas,
- broader regression pass as needed.
7. Update bead states:
- close completed beads with evidence,
- reopen or create discovered follow-ups if needed.
8. Pull next set of up to three ready beads.
9. Repeat until all non-deferred open beads are complete.

## Merge and Validation Policy

- Merge order should prefer blocker-unlocking beads first.
- If conflicts span two stream outputs, resolve once on `main` and rerun impacted tests.
- Do not close a bead without passing validation evidence for the touched area.

## Completion Criteria for Phase IV

- All open beads completed except deferred `PSFN-xfus`.
- `phase-iv` is green on required validation gates.
- Manual verification by Operator + PSFN is completed and accepted.
- `phase-iv` is merged to `main` for the first public release.
- Bead tracker reflects final accurate state.
- Final handoff includes any residual risks and the trigger point for `PSFN-xfus` execution.
