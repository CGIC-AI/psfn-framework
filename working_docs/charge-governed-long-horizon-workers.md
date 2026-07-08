# Charge-Governed Long-Horizon Worker Execution

Bead: `PSFNLIVE-qjwd`

Date: 2026-06-29

## Purpose

The current 36 assistant-step ceiling is a stopgap. Long-horizon work should terminate because it completed, exhausted its inherited budget, hit an operator stop, or stopped making measurable progress. This design keeps charge as the single accounting source and adds worker-local budget state, progress checkpoints, stuck-loop detection, bead-backed decomposition, and operator-visible telemetry for parent turns, bounded subagents, and shards.

This is a design and implementation-plan artifact. It does not change runtime code.

## Current Runtime Facts

- Parent agent loops stop on a hard assistant-step cap in `src/core/agent/scheduled-agent-loop.ts:120`, emit one check-in at `src/core/agent/scheduled-agent-loop.ts:132`, and synthesize a generic stop message at `src/core/agent/scheduled-agent-loop.ts:207`.
- The hard cap value is `AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN = 36` in `src/core/agent/turn-limits.ts:1`; the check-in threshold is 18.
- Shards already run inside nested charge contexts. `ShardManager.spawn()` creates a `shard` lane child context with `runId = shardId` at `src/faculties/shards/manager.ts:269`, and `executeSubagent()` charges `subagentLaunch` before using the same shard machinery at `src/faculties/shards/manager.ts:293`.
- Shard execution is still `maxTurns`-driven. `executeShard()` normalizes `maxTurns` at `src/faculties/shards/manager.ts:451`, charges `shardLaunch` at `src/faculties/shards/manager.ts:467`, then loops `for (let turn = 0; turn < maxTurns; turn++)` at `src/faculties/shards/manager.ts:563`.
- Named subagents are also `maxTurns`-driven. `SubagentFaculty.spawn()` normalizes max turns at `src/faculties/subagents/faculty.ts:184`; `runHandle()` loops to `handle.maxTurns` at `src/faculties/subagents/faculty.ts:366`.
- `runWithChargeContext()` already creates nested lineage, shares a quota account with the parent, folds completed child spend into the parent, and tracks orphaned child spend on errors in `src/shared/telemetry/run-charge.ts:437`.
- `inspectChargeSurface()` and `chargeSurface()` enforce both per-run quota and rolling 24-hour lane quota. Inspection includes remaining-before/after fields in `src/shared/telemetry/run-charge.ts:369`.
- The charge ledger already extracts `shardId` and `subagentId` from charge event details in `src/shared/telemetry/charge-ledger.ts:130`, and Garden exposes charge data through `src/operator/garden/services/charge-ledger-service.ts:14`.
- Action-pipe background work already exposes queue lanes, back-pressure, persistence, completions, and bounded subagent result summaries through `src/core/agent/post-turn-action-runtime.ts` and `src/operator/garden/services/action-pipe-service.ts`.
- The action-pipe subagent-spawn policy currently budgets only `maxTurns` in `src/core/agent/post-turn-subagent-spawn.ts:31`; it does not carry charge-unit, token, wall-clock, checkpoint, or stuck-loop limits.
- `docs/tool-surface.md` describes future long-horizon `shard action=spawn|list|status|deliver`, but startup currently registers `subagent` and does not expose a model-facing `shard` tool. The registry marks `shard` as future extended in `src/core/agent/tool-surface/registry.ts:446`.

## Goals

- Replace fixed long-horizon turn caps with explicit budget-governed termination.
- Make parent, subagent, and shard budgets inherit from one charge lineage and one quota account.
- Preserve existing run-charge and charge-ledger semantics; do not add a parallel spend ledger.
- Require progress checkpoints that summarize current goal, proven facts, uncertainty, next step or bead, and whether the work is still advancing.
- Detect repeated failed tool calls and repeated analysis without new evidence before the 36-step stop triggers.
- Use beads for decomposition and closure decisions, not markdown task lists.
- Show operators budget state, progress, stop reason, stuck-loop evidence, and child lineage in Garden/action-pipe/charge surfaces.

## Non-Goals

- Do not remove `AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN` immediately. Keep a high emergency fuse until budget termination is proven.
- Do not change charge-policy ownership. New mutable limits belong in `charge-policy.json` or another JSON owner file, never `.env`.
- Do not merge named subagents and shards. Bounded short-horizon workers stay `subagent`; long-horizon fold-back work should converge on `shard`.
- Do not make every internal worker result partner-visible. Parent-visible mailbox/result delivery remains separate from public notification policy.

## Core Model

Add a runtime-local `WorkerBudgetEnvelope` passed into parent turns, subagent spawns, action-pipe subagent spawns, and shard spawns.

Suggested shape:

```ts
interface WorkerBudgetEnvelope {
  schemaVersion: 1;
  ownerRunId: string;
  workerRunId: string;
  rootRunId: string;
  parentRunId?: string;
  lane: 'interactive' | 'background' | 'maintenance' | 'subagent' | 'shard';
  chargeUnits: {
    quota: number;
    spentBefore: number;
    remainingBefore: number;
    reserved?: number;
  };
  tokens?: { maxInputOutput: number; used: number };
  wallTimeMs?: { max: number; elapsed: number };
  checkpoints: {
    intervalAssistantSteps: number;
    intervalWallTimeMs?: number;
    requiredFields: readonly ['goal', 'provenFacts', 'uncertainty', 'nextStep', 'advancing'];
  };
  stuckLoop: {
    repeatedToolFailureLimit: number;
    repeatedNoEvidenceLimit: number;
    repeatedCheckpointNoProgressLimit: number;
  };
}
```

This envelope should be derived, not separately authoritative. The authoritative quota remains `chargePolicy.runChargeQuotaByLane`; spend remains `RunChargeContextState.quotaAccount` and ledger events.

## Budget Inheritance

Parent turn:

- Start each model-facing turn inside `runWithChargeContext()` when `chargePolicy` exists, using the runtime lane from `resolveRuntimeLaneClassForTurn()`.
- Build a parent `WorkerBudgetEnvelope` from `getRunChargeSnapshot()` plus `getRunChargeRollingWindowSnapshot()`.
- The parent budget is the smaller of current-run remaining and rolling 24-hour remaining for the lane.

Subagent:

- Add budget fields to `SubagentExecutionRequest` and `BoundedSubagentLaunchRequestInput`, while keeping current `maxTurns` as deprecated compatibility until callers migrate.
- When a parent spawns a subagent, inspect `subagentLaunch` first. If allowed, reserve or record the launch charge, then allocate a child envelope with an explicit child quota slice.
- Child subagent charge should remain in the parent quota account through `runWithChargeContext()`, so a child can never exceed the parent run's remaining lane budget.
- Include `subagentId` in every subagent-related charge event detail so charge-ledger summaries populate `subagentIds`.

Shard:

- Extend `ShardConfig` with `budget?: WorkerBudgetEnvelope | WorkerBudgetRequest`.
- `ShardManager.spawn()` should create a child `shard` lane context as it does today, but the child loop should ask the budget governor before each assistant/model step and after each response.
- Include `shardId`, `budgetLimit`, `stopReason`, and checkpoint metadata in `shard.spawn.start`, `shard.lifecycle.transition`, and `shard.spawn.end` audit events.
- Satellite-delegated shards should inherit the same budget envelope with a tighter default wall-clock/turn fallback because they are voice-adjacent.

Action pipe:

- Replace `PostTurnSubagentSpawnBudget { maxTurns }` with a budget object containing charge units, wall time, token cap, and checkpoint/stuck-loop policy.
- `resolvePostTurnSubagentSpawnQueuedStatus()` should expose budget remaining and requested/reserved units, not only max turns.
- Queue lane budgets should continue to control queue depth/back-pressure; worker budgets should control execution after dequeuing.

## Budget-Governed Termination

Introduce a shared `WorkerBudgetGovernor` module for parent turns, subagents, and shards.

Responsibilities:

- `beforeAssistantStep()`: inspect remaining charge, wall time, token budget, cancellation, and stuck-loop state before the next model call.
- `afterAssistantStep(response)`: update token usage, assistant-step count, model metadata, and evidence/progress facts.
- `beforeToolCall(toolCall)`: block repeated failed tool calls and costed surfaces that would exceed quota.
- `recordToolResult(toolCall, result)`: update failure streaks, evidence fingerprints, and progress markers.
- `nextCheckpointDecision()`: determine whether to inject a checkpoint steering message.
- `finalize(stopReason)`: produce a structured terminal summary used by agent response metadata, shard/subagent result objects, action-pipe completion records, and Garden views.

Stop reasons:

- `completed`: explicit structured completion.
- `budget_exhausted`: no charge units remain for the lane or child allocation.
- `token_budget_exhausted`.
- `wall_time_exhausted`.
- `operator_stop`.
- `stuck_repeated_tool_failure`.
- `stuck_no_new_evidence`.
- `decomposed_to_beads`.
- `blocked_waiting_for_operator`.
- `emergency_step_fuse`: old 36-step cap fired; this should become rare telemetry, not normal control flow.

The legacy 36-step stop stays as a final fuse. Once budget tests are stable, raise it high enough that normal long-horizon work terminates through `WorkerBudgetGovernor` first.

## Progress Checkpoints

Checkpoints should be structured records plus optional steering messages.

Minimum checkpoint fields:

- `goal`: the current goal in one sentence.
- `provenFacts`: concrete facts with evidence/tool references.
- `uncertainty`: unknowns and assumptions.
- `nextStep`: one concrete next step, or the bead to create/claim/close.
- `advancing`: boolean plus reason.
- `budget`: charge, token, wall-time, and assistant-step usage.
- `evidenceDelta`: new evidence fingerprints since the previous checkpoint.

Checkpoint timing:

- Parent turns: first checkpoint at current step 18 behavior, then every 8 assistant steps or 90 seconds, whichever comes first.
- Subagents: checkpoint every 2 worker turns or 60 seconds; default one checkpoint before budget wrap-up.
- Shards: checkpoint every worker turn for long-horizon mode; shards can run silently only for single-turn bounded work.
- Action-pipe workers: checkpoint on enqueue, start, every execution checkpoint, and terminal completion/failure.

The check-in text in `scheduled-agent-loop.ts` should become a rendering of `WorkerProgressCheckpoint`, not a hard-coded prose-only message.

## Stuck-Loop Detection

The governor should maintain a small rolling window of progress signals:

- Tool-call fingerprint: tool name plus normalized action/target/path/query, excluding volatile IDs.
- Tool-result fingerprint: success/error class and a short hash of result text or error text.
- Evidence fingerprint: cited file path, bead id, session id, memory id, URL, command output hash, or other provenance token.
- Analysis fingerprint: compact hash of assistant conclusion plus evidence set.

Stop or force decomposition when any of these holds:

- Same tool-call fingerprint fails 3 times without a changed input or new evidence.
- Same error class appears 3 times across equivalent tools.
- Two consecutive checkpoints report `advancing=false`.
- Three consecutive assistant steps produce no new evidence fingerprint and no committed decision.
- The worker asks for broad reorientation after already receiving the same checkpoint state.

The stuck detector should not punish normal multi-step reading. Reading different files, different bead details, or different command outputs counts as new evidence.

## Bead-Backed Decomposition And Closure

Long-horizon work should decide through beads at checkpoints and terminal states.

Decision flow:

1. Continue inline only when budget remains, the next step is specific, and the last checkpoint advanced.
2. Delegate to subagent only for bounded short-horizon parallel work that can return an artifact or answer inside the allocated child budget.
3. Spawn or schedule shard work only when the task needs longer isolation, fold-back review, or distributed execution.
4. Create a follow-up bead when the next required step is independently reviewable, exceeds remaining budget, or needs operator input.
5. Close a bead only after the worker has concrete validation evidence and the close reason can name the artifact, code path, or verification result.
6. Stop with partial findings when the remaining work is too ambiguous to bead safely.

Runtime support:

- Add a checkpoint field `beadDecision` with `none | create | claim | update | close | blocked`.
- When `beadDecision=create`, the worker must emit title, self-contained description, acceptance criteria, parent/dependency link, and concrete files or examples.
- When `beadDecision=close`, the worker must emit evidence and validation commands. A closure action should still go through the existing `beads action=close` capability gate.
- Use the existing unified `beads` tool (`action=ready|show|create|update|close|sync`) and preserve its capability gates.

This keeps decomposition in the issue tracker and avoids markdown task lists.

## Telemetry And Operator Visibility

Emit a new typed event family, for example `agent.worker.budget`, with phases:

- `allocated`
- `checkpoint`
- `budget_warning`
- `wrap_up`
- `stuck_detected`
- `terminated`

Payload fields:

- worker identity: `runId`, `rootRunId`, `parentRunId`, `workerKind`, `workerId`, `name`, `channelId`.
- budget snapshot: lane, charge quota/spent/remaining, rolling remaining, token used/max, wall-time elapsed/max, assistant steps.
- progress: checkpoint id, goal, advancing, evidence count/delta count, next step, bead decision.
- stop: stop reason, failure reason, operator stop reason, partial-result marker.
- lineage: `shardId`, `subagentId`, source message, action-pipe action id, fold-review path when present.

Garden changes:

- Charge Budget page: show active worker children under each run summary using existing `RunChargeRunSummary.shardIds` and `subagentIds`, plus new stop reason/checkpoint metadata when available.
- Action Pipe page: show budget requested/reserved/spent, current checkpoint, and terminal stop reason for queued and completed subagent-spawn actions.
- Shard/fold review surface: show `BudgetLimited` or equivalent terminal state, partial output, remaining budget, and next recommended bead.
- Telemetry page/WebSocket: stream `agent.worker.budget` events for live operator stop buttons and stuck-loop warnings.

Operator controls:

- Stop active worker by `workerId` with reason.
- Convert a checkpoint's `nextStep` into a bead draft.
- Acknowledge a stuck-loop terminal result.
- Approve fold-back delivery separately from budget termination.

## Implementation Plan

Slice 1: shared budget contract and governor

- Add worker budget types under `src/core/agent/worker-budget/`.
- Add deterministic budget evaluation helpers with no runtime dependencies.
- Add tests for charge remaining, token exhaustion, wall-time exhaustion, checkpoint timing, repeated tool failure, and no-evidence detection.

Slice 2: parent loop integration

- Replace hard-coded check-in construction in `scheduled-agent-loop.ts` with governor checkpoint rendering.
- Keep `AGENT_LOOP_MAX_ASSISTANT_STEPS_PER_RUN` as `emergency_step_fuse`.
- Add tests in `src/core/agent/scheduled-agent-loop.test.ts` for checkpoint injection, budget stop before emergency fuse, and stuck-loop stop.

Slice 3: subagent integration

- Extend `SubagentExecutionRequest`, `SubagentTaskRecord`, `SubagentResult`, and `SubagentRuntimeSnapshot` with budget, checkpoint, and stop reason fields.
- Replace `for (turn < maxTurns)` in `SubagentFaculty.runHandle()` with a governor loop.
- Preserve `maxTurns` as a compatibility cap only when no budget envelope is supplied, and emit a deprecation marker in diagnostics.
- Add tests in `src/faculties/subagents/faculty.test.ts` and `src/faculties/subagents/tools.test.ts`.

Slice 4: shard integration

- Extend `ShardConfig`, `ActiveShard`, and `ShardResult` with budget, checkpoints, and stop reason.
- Replace the shard `maxTurns` loop in `ShardManager.executeShard()` with the governor.
- Emit `BudgetLimited` or a richer terminal state. Current states are `registering|ready|degraded|offline`; adding explicit budget-limited semantics will require state-model changes.
- Add tests in `src/faculties/shards/manager.test.ts` for budget exhaustion, checkpoint telemetry, stuck loops, partial fold-back, and charge lineage.

Slice 5: action-pipe budget policy

- Replace `PostTurnSubagentSpawnBudget.maxTurns` with structured worker budget policy.
- Persist and hydrate the new fields in post-turn queue entries.
- Expose budget fields in `PostTurnActionQueuedEntryStatus`, completion records, and Garden action-pipe UI.
- Add compatibility rejection tests: malformed budget fails closed; legacy `maxTurns` is accepted only through a migration shim if explicitly allowed.

Slice 6: telemetry and Garden

- Add typed `agent.worker.budget` events in `src/shared/event-bus.ts`.
- Feed worker budget events into charge/action-pipe/shard services.
- Add Garden API/UI fields for active budget, checkpoints, stop reason, and operator stop.
- Test API serialization and UI rendering around partial/budget-limited workers.

Slice 7: bead decision helpers

- Add a pure helper that validates checkpoint bead decisions and returns a `beads` tool payload.
- Do not auto-close beads without validation evidence.
- Tests should cover create/update/close/blocked decisions, missing acceptance criteria, missing evidence, and capability-denied paths.

## Focused Test Plan For Budget-Governed Termination

Unit tests:

- `WorkerBudgetGovernor` allows work while charge, token, wall-time, and progress signals are within limits.
- It stops before the next model call when charge remaining cannot cover the next costed surface.
- It stops after a response when token budget is exhausted.
- It stops on wall-time exhaustion using injectable `now()`.
- It injects checkpoint decisions at configured assistant-step and wall-clock intervals.
- It reports `stuck_repeated_tool_failure` after repeated equivalent tool failures.
- It reports `stuck_no_new_evidence` after repeated analysis without new evidence.
- It treats different files, bead IDs, command hashes, memory IDs, or URLs as new evidence.

Parent loop tests:

- A long tool loop terminates via `budget_exhausted` before the 36-step emergency fuse.
- The old emergency fuse still works and reports `emergency_step_fuse`.
- Checkpoint messages include goal, proven facts, uncertainty, next step, advancing flag, and budget.

Subagent tests:

- A spawned subagent inherits parent `rootRunId` and cannot exceed the parent quota account.
- A subagent returns a partial result with `budget_exhausted` and checkpoint history.
- Operator cancellation returns `operator_stop` with partial token/turn counts.
- `subagent action=status` includes budget remaining and latest checkpoint.

Shard tests:

- A shard folds child charge back to the parent without double-counting.
- A shard terminates as budget-limited with partial output and fold-review path.
- Staged memory/artifact fold-back survives budget termination.
- Satellite shard delegation uses tighter defaults and reports the same stop reason fields.

Action-pipe/Garden tests:

- Persisted action-pipe entries with structured worker budgets hydrate correctly.
- Malformed budget payloads are quarantined or rejected fail-closed.
- Garden action-pipe status shows budget requested/spent/remaining and terminal stop reason.
- Charge ledger data can filter or summarize worker children by `rootRunId`, `shardId`, and `subagentId`.

## Follow-Up Implementation Gaps

- Model-facing `shard` tool is aspirational: registry/docs mention it, but startup does not register a `shard` tool. Implementing true long-horizon shard execution needs a separate bead.
- `SubagentFaculty` does not use charge contexts today. Bounded `spawn_subagent` calls through `ShardManager.executeSubagent()` do, but the canonical `subagent` faculty path has no `runWithChargeContext()` or `chargeSurface('subagentLaunch')` integration.
- Action-pipe subagent spawn policy only has `maxTurns`; it needs structured charge/token/wall-time/checkpoint budget fields.
- Current lifecycle state sets do not include `budget_limited`, `blocked`, `interrupted`, or `partial`. Adding those should coordinate with the related lifecycle/mailbox bead `psfn-framework-7ym.4`.
- Per-shard budget tracking is not implemented and is already related to bead `psfn-framework-7ym.8.2`; this design should feed that implementation rather than duplicate it.
- There is no typed worker-budget telemetry event or Garden worker-budget view.
- Checkpoints are currently prompt text, not structured records.
- Stuck-loop detection is not centralized; the existing tool-call guard prevents some repetition but does not evaluate evidence progress.
