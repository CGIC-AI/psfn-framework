# Phase V Execution Plan

Date: 2026-03-05

## Objective

Implement Phase V as a decision-complete architecture program: deterministic cognition foundations, pluginized extension seams, schema-driven settings governance, and optional compositional reasoning pipelines.

The Five Aggregates vision in `docs/PHASE_V_VISION.md` remains the product direction. This plan defines execution order and guardrails so Phase V scales without reintroducing hardcoded drift or core-file coupling.

## Prerequisites

1. `PSFN-4tnb` — Phase IV.V stabilization must close before major Phase V feature work.
2. `PSFN-04dt` — foundational contracts are mandatory inputs for higher-layer cognition work:
   - canonical turn provenance
   - fast/slow loop contracts
   - centralized eligibility enforcement
   - deterministic redaction semantics
   - evidence-aware retrieval scoring

## Decision Log (Locked)

1. **Full plugin seams are in scope for Phase V** (not deferred).
   Why: channel/STT/TTS additions still require core runtime edits in current architecture.
2. **Settings are schema-driven with strict ownership**.
   Why: manual settings wiring drifts; every setting must have both UX exposure and a single JSON owner.
3. **Compositional cognition is optional and policy-gated**.
   Why: support both low-complexity and high-autonomy deployments without forking architecture.
4. **No silent fallback policy remains strict** for security- and gateway-sensitive subsystems.

## Foundation Expansion (New Epics)

| Epic | Beads ID | Purpose |
|---|---|---|
| Plugin seams (channels/STT/TTS) | `PSFN-qyrl` | Remove core-edit requirement for transport/provider extensions; registry + fail-closed loading |
| Settings contract and UX governance | `PSFN-y2ac` | Enforce schema-driven settings with single subsystem JSON ownership and CI guardrails |
| Compositional cognition kernel | `PSFN-x92u` | Add decompose/evaluate/compose primitives across extraction, retrieval, appraisal, think, and shard context |

## Existing Core Epics (Retained)

| Epic | Beads ID | Status in Phase V Program |
|---|---|---|
| Continuous Emotion System | `PSFN-bu5f` | Foundation for intention and self-model remains unchanged |
| Intention & Active Concern Tracking | `PSFN-8e3t` | Now explicitly compositional in appraisal path |
| Agentic Context Composition | `PSFN-domy` | Now depends on compositional kernel + settings contract |
| Distributed Autonomy | `PSFN-17lw` | Now aligned to plugin seam architecture |
| Integrated Self-Model | `PSFN-be11` | Continues after emotion + intention + compositional foundations |

## Dependency Order (Execution Contract)

### Stage 0
- `PSFN-4tnb` stabilization.

### Stage 1 (Foundations)
- `PSFN-04dt.*` foundation tasks, with `PSFN-04dt.3` (EligibilityGate) unblocking plugin seam work.

### Stage 2 (Parallel)
- `PSFN-qyrl` plugin seams (blocked by `PSFN-04dt.3`).
- `PSFN-y2ac` settings contract (blocked by `PSFN-bxvy` and `PSFN-c0zl`).

### Stage 3
- `PSFN-x92u` compositional kernel (blocked by `PSFN-04dt.1`, `.2`, `.3`, `.5`, plus `PSFN-qyrl` and `PSFN-y2ac`).

### Stage 4 (Feature Epics on Top)
- `PSFN-domy` depends on `PSFN-x92u` and `PSFN-y2ac`.
- `PSFN-8e3t` depends on `PSFN-x92u`.
- `PSFN-17lw` depends on `PSFN-qyrl`.
- `PSFN-be11` depends on prior emotion/intention foundations and `PSFN-x92u`.

## New Features We Are Baking In

1. **Registry-driven extension model**
   - Channel adapter registry + manifests
   - STT provider registry
   - TTS provider registry
   - Runtime bootstrap from registry entries, not hardcoded constructors
2. **Settings governance contract**
   - Backend schema endpoints with ownership metadata
   - Garden schema renderer for common controls
   - Complex settings blocks bound to schema ownership
   - CI guard rejecting settings without schema + UX + owner file
   - Round-trip contract tests per subsystem JSON
3. **Compositional cognition kernel**
   - Policy-gated config (tier/channel/purpose), default OFF
   - Extraction chunk-and-compose with merge/dedup
   - Retrieval rerank batch-evaluate-and-compose
   - Signal-wise post-turn appraisal compose step
   - Recursive think sub-call/return with isolated context
   - Shard focused context-pack contract
   - Compositional telemetry and budget diagnostics

## Settings Rule (Hard Requirement)

Any new setting merged in Phase V must satisfy all of the following:

1. Declared in backend schema metadata.
2. Owned by exactly one subsystem JSON file.
3. Exposed in Garden UX (schema-rendered or explicitly bound custom block).
4. Covered by PATCH/GET round-trip tests.

## Branch Strategy

- Use `phase-v` as integration branch for Phase V execution.
- All Phase V worktrees branch from and merge into `phase-v`.
- `main` remains protected until full verification passes.
- Do not push or merge Phase V changes to `main` before explicit manual validation sign-off.
- Use `phase-v` for integration commits and test cycles until release approval.

## Current Execution State

- Top-level integration branch remains `phase-v`.
- Completed child-stream work ready for fresh-session review/integration:
  - `PSFN-04dt.1` on `phase-v-04dt1` at `092fa78` (`canonical TurnRecord + TurnID provenance`)
  - `PSFN-04dt.5` on `phase-v-04dt5` at `591a4cf` + `88eeab4` (`evidence-aware retrieval scoring + regression coverage`)
- Integrated on `phase-v` in this session:
  - `PSFN-qyrl.1` (`channel adapter manifest registry loader`) is now merged into `phase-v`, with an additional fail-closed guard so a manifest cannot silently skip a `required` channel by marking it disabled.
- Next active Phase V focus:
  - Review/integrate `PSFN-04dt.1` and `PSFN-04dt.5` child streams onto `phase-v`.
  - Continue plugin seam work with `PSFN-qyrl.2` (STT registry) and `PSFN-qyrl.3` (TTS registry) after the channel registry checkpoint is closed.
- Prior orchestration thread hit stale subagent/thread-cap contamination. Do not continue spawning workers from that old top-level session. Resume from a fresh top-level Codex session.

## Work Process

1. Use up to three parallel streams (worktrees + sub-agents).
2. Assign one epic (or explicit subtask slice) per stream.
3. Merge by dependency order only; blocker-unlocking work first.
4. Resolve merge conflicts at orchestrator level.
5. Keep beads updated continuously (status + dependencies + close evidence).

### Fresh-Session Resume Rule

When restarting Phase V orchestration after a thread-cap or stale-session failure:
1. Start a brand-new top-level Codex session in `/mnt/samesung/ai/psfn-framework`.
2. Reuse the existing `phase-v-*` worktrees/branches unless there is a concrete reason to recreate them.
3. Confirm worker spawning is healthy before assigning new streams.
4. Merge only validated child branches back into `phase-v`.
5. Do not mark new work complete from a contaminated orchestration session that can no longer spawn/close workers reliably.

## Verification Gates

1. `npm run build`
2. `npm test`
3. Targeted regression coverage for:
   - plugin load/fail-closed behavior
   - settings schema/ownership/UI contract
   - compositional pipeline correctness and diagnostics
4. Manual companion validation before `phase-v` -> `main` merge.

## Latest Validation Snapshot

- `PSFN-qyrl.1` targeted regression: `npm test -- --run src/runtime/channel-lifecycle.test.ts`
- `phase-v` build after channel registry integration: `npm run build`
