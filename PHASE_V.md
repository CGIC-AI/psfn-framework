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
- `PSFN-x92u` compositional kernel (integrated and closed on `phase-v`; `PSFN-x92u.1` through `.7` landed).

### Stage 4 (Feature Epics on Top)
- `PSFN-domy` depends on `PSFN-x92u` and `PSFN-y2ac`; it becomes the primary context-composition lane once `PSFN-x92u` closes.
- `PSFN-17lw` depends on `PSFN-qyrl`; it is already unblocked and can run in parallel with the context/emotion track.
- `PSFN-bu5f` depends on `PSFN-domy`.
- `PSFN-8e3t` depends on `PSFN-bu5f`, with the `PSFN-x92u` foundation already satisfied.
- `PSFN-be11` depends on `PSFN-bu5f` and `PSFN-8e3t`, with the `PSFN-x92u` foundation already satisfied.

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
- Integrated on `phase-v` in this session:
  - `PSFN-04dt.1` (`canonical TurnRecord + TurnID provenance`) is merged from `phase-v-04dt1` at `092fa78`.
  - `PSFN-04dt.2` (`immutable TurnSnapshot contract between fast-loop and slow/background mutation paths`) is integrated, with frozen prompt/session/memory turn snapshots captured at turn start, compaction prompt pinning, snapshot-backed retrieval/context reads, and persisted snapshot version pointers on canonical turn records.
  - `PSFN-04dt.5` (`evidence-aware retrieval scoring + regression coverage`) is merged from `phase-v-04dt5` at `591a4cf` + `88eeab4`.
  - `PSFN-qyrl.1` (`channel adapter manifest registry loader`) is merged, with an additional fail-closed guard so a manifest cannot silently skip a `required` channel by marking it disabled.
  - `PSFN-qyrl.2` (`STT provider registry and pluggable provider contract`) is merged, including runtime/bootstrap gating plus backend settings/admin validation for registered provider ids.
  - `PSFN-qyrl.3` (`TTS provider registry and pluggable provider contract`) is merged, including registry-backed bootstrap gating plus backend settings/admin validation for registered provider ids.
  - `PSFN-qyrl.4` (`runtime/bootstrap registry replacement`) is integrated, including shared channel runtime factory helpers for Discord/Telegram/API entrypoints plus runtime-config-driven STT/TTS bootstrap across Wyoming, API websocket voice, and Discord voice without hard-coded provider switch logic.
  - `PSFN-qyrl.5` (`EligibilityGate integration for plugin capabilities and fail-closed policy`) is integrated, including explicit eligibility metadata on channel/STT/TTS plugin seams plus fail-closed runtime gating/telemetry for registry activation and connector actions.
  - `PSFN-qyrl.6` (`plugin regression suite + sample external plugin fixture`) is integrated, including fail-closed plugin lifecycle/connector regression coverage across eligibility, runtime bootstrap, API voice, Discord voice, and provider registry seams.
  - `PSFN-c0zl` (`model API routing and persistence overhaul`) is integrated, including slot-level routing metadata in the canonical model catalog contract, fail-closed admin validation for `routing.providerOrder`, lossless persistence across settings/admin APIs, and legacy/Garden settings controls that preserve explicit per-slot routing intent without rewriting global OpenRouter fallback order.
  - `PSFN-nhtv` (`Garden voice provider picker hard-coding`) is integrated, with Garden preserving arbitrary STT/TTS provider ids from the registry-backed backend instead of coercing unknown values to `disabled`.
  - `PSFN-bxvy.1` (`two-root persistence contract`) is integrated, with canonical `system-data` vs `companion-data` root resolution, fail-closed split-root env guards, companion-state path helpers, and runtime/admin/bootstrap rewiring so system-owned settings/config stay on the system root while character/session/prompt/notes/backup state uses the companion root.
  - `PSFN-bxvy.2` (`identity + prompt single-source-of-truth`) is integrated, with the canonical `Character Foundation` locked to character-card ownership across Garden API, legacy admin, and agent prompt tools while runtime prompt sync continues to derive that layer from card-backed identity data instead of writable prompt copies.
  - `PSFN-bxvy.3` (`subsystem config normalization`) is integrated, with `/api/admin/settings` now exposing runtime-owned settings only, explicit fail-closed wrong-owner validation for model/scheduler/capability fields, and Garden saving model catalog, scheduler, and capability-tier edits back through their canonical JSON files instead of the generic runtime settings patch path.
  - `PSFN-bxvy.4` (`env scope reduction`) is integrated, with JSON-owned model/runtime/channel config no longer taking authority from `.env`, startup warnings for ignored legacy config env vars, canonical seed/default alignment for system-data config files, standalone CLI/E2E entrypoints hydrating from JSON-backed config owners, and operator/docs examples trimmed so `.env` is documented as secrets/bootstrap wiring only.
  - `PSFN-bxvy.5` (`migration pipeline for config/data topology cutover`) is integrated, with a single manifest-backed persistence cutover engine covering legacy shared-root plus legacy companion-root artifacts, dry-run/apply CLI support, entrypoint startup guards, integrity-verified backups, audit-db migration, and post-cutover legacy session cleanup normalization.
  - `PSFN-y2ac.1` (`backend settings schema endpoints and ownership map by subsystem`) is integrated, with a canonical settings contract module, `/api/admin/settings/schema`, dynamic owner metadata, and admin regressions proving schema exposure for subsystem files and provider enums.
  - `PSFN-y2ac.2` (`Garden schema renderer for common controls`) is integrated, with Garden fetching typed schema metadata and driving advanced-mode common field rendering from backend-declared types/enums/ownership instead of local hardcoded field semantics.
  - `PSFN-y2ac.3` (`bind complex settings blocks to schema ownership`) is integrated, with Garden complex model/scheduler/capability editors using canonical owner-file labels, preserving JSON-for-config / env-for-secrets separation, and exposing capability-tier custom tokens in the structured UI instead of raw-only.
  - `PSFN-y2ac.4` (`CI guard: reject new settings without schema + UX exposure + owner file`) is integrated, with a shared Garden settings-contract manifest, a fail-closed `verify:settings-contract` guard, backend schema coverage for model object fields, and regression tests that fail on missing Garden exposure or owner drift.
  - `PSFN-y2ac.5` (`Contract tests: PATCH/GET round-trip lossless by subsystem JSON file`) is integrated, with dedicated subsystem config round-trip tests, admin JSON/legacy endpoint regressions for runtime + subsystem owner payloads, and `AdminSettingsDataService` now reading runtime settings from the canonical JSON owner instead of stale in-memory config.
  - `PSFN-x92u.1` (`compositional policy config + default-OFF gating`) is integrated, including canonical JSON-backed `compositionalPolicy` schema/persistence, fail-closed backend validation, runtime snapshot wiring, and Garden advanced-mode controls that preserve JSON-for-config / env-for-secrets separation.
  - `PSFN-x92u.2` (`memory extraction chunk-and-compose pipeline`) is integrated, including channel-id-aware compositional policy gating, chunked extraction prompt fan-out for long pre-compaction transcripts, stable compose/dedup merging before acceptance/writes, and regression coverage proving fail-closed fallback to the legacy one-shot path when policy does not allow compositional extraction.
  - `PSFN-x92u.3` (`retrieval rerank batch-evaluate-and-compose pipeline`) is integrated, including fail-closed compositional rerank helpers, runtime LLM wiring into `MemoryRetriever`, policy-gated retrieval compose/rerank on allowed channel/tier/purpose combinations, and regression coverage proving deterministic fallback when policy or helper output denies the path.
  - `PSFN-x92u.4` (`post-turn intention appraisal`) is integrated, including a new signal-wise post-turn appraisal composer under `src/intention/*`, fail-closed policy gating for `purpose='appraisal'` at the parity runtime seam, and preserved downstream post-turn action queue/telemetry behavior with regression coverage for both legacy and composed inference paths.
  - `PSFN-x92u.5` (`recursive think subcalls with isolated child context and conclusion-only return`) is integrated, including policy-gated `sub_think(...)`, shared root-budget accounting across nested runs, depth-limited recursion, runtime/bootstrap wiring for compositional policy, and think-tool telemetry/header updates that surface nested execution diagnostics without leaking child scratch context.
  - `PSFN-x92u.6` (`shard focused context-pack contract`) is integrated, including source-request context capture on `spawn_shard`, task-scoped shard context packs rendered into child prompts, focused source-session excerpt + parent-channel memory packaging, and fail-closed suppression of live child memory retrieval when a bounded context pack is active.
  - `PSFN-x92u.7` (`compositional telemetry, budgets, timeout/fallback diagnostics`) is integrated, including richer `agent.think.trace` telemetry with nested-think diagnostics and correlation fields, extraction compose-path telemetry for chunking/dedup/boundary facts, and retrieval compose-path telemetry exposing candidate/batch/finalist counts and deterministic fallback modes.
  - `PSFN-crgg` (`ModelPurpose.context` model-roster slot) is integrated, including shared type/settings/routing wiring, context→background→chat fallback resolution, JSON-backed seed defaults, and Garden/admin exposure for the dedicated helper-model slot used by context-composition work.
  - `PSFN-domy.1` (`persist structured tool observations in session history for context masking`) is integrated, with first-class `tool` session entries, strict tool-observation metadata, context/snapshot round-tripping, and fail-closed recording of tool results before assistant archival.
  - `PSFN-20kl` (`observation masking in buildContext()`) is integrated, with a pre-compaction masking pass over stale tool observations, JSON-backed `observationMaskingWindow` runtime settings governance, and placeholder rendering that preserves recent tool observations while collapsing older ones to `[Tool result: name — see earlier context]`.
  - `PSFN-qyrl` plugin-seam epic is closed on `phase-v`.
  - `PSFN-bxvy` config/persistence-topology epic is closed on `phase-v`.
  - `PSFN-y2ac` settings-governance epic is closed on `phase-v`.
  - `PSFN-x92u` compositional-kernel epic is closed on `phase-v`.
- Next active Phase V focus:
  - Continue Stage 4 on `PSFN-domy` with `PSFN-fihj` (context manifest/debugging) as the next local context-composition slice after `PSFN-crgg`, `PSFN-domy.1`, and `PSFN-20kl`.
  - Advance `PSFN-17lw.1` next on the autonomy lane using the isolated background-agent/session plan; it remains the first concrete `PSFN-17lw` execution slice after the seam audit.
  - Keep `PSFN-bu5f` queued behind `PSFN-domy`, then advance `PSFN-8e3t`, with `PSFN-be11` remaining the final self-model lane behind emotion + intention.
  - Keep `PSFN-04dt.4` open as the remaining Stage 1 foundation lane for tombstone/redaction replay semantics; it does not block Stage 4.
  - Keep `PSFN-eg59` as the residual de-hardcode test-fixture cleanup lane where remaining `Purrsephone` hits are intentional branding/legacy cases versus generic fixture drift.
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
- `PSFN-04dt.5` targeted regression: `npm test -- --run src/memory/retrieval.test.ts`
- `PSFN-04dt.1` targeted regression: `npm test -- --run src/agent/substrate-agent.test.ts src/memory/extraction.test.ts src/session/store.test.ts`
- `PSFN-04dt.2` targeted regressions: `npm test -- --run src/agent/substrate-agent.test.ts src/session/manager.test.ts src/memory/retrieval.test.ts src/session/store.test.ts`
- `PSFN-qyrl.2` targeted regressions: `npm test -- --run src/voice/connectors/stt/index.test.ts src/runtime/bootstrap-helpers.test.ts src/settings.test.ts src/channels/admin/api-routes.test.ts`
- `PSFN-qyrl.3` targeted regressions: `npm test -- --run src/voice/connectors/tts/index.test.ts src/runtime/bootstrap-helpers.test.ts src/settings.test.ts src/channels/admin/api-routes.test.ts src/channels/api/voice-websocket-runtime.test.ts`
- `PSFN-qyrl.4` targeted regressions: `npm test -- --run src/runtime/bootstrap-helpers.test.ts src/channels/api/voice-websocket-runtime.test.ts src/channels/discord/voice.test.ts`
- `PSFN-qyrl.4` supporting bootstrap regressions: `npm test -- --run src/bootstrap/composition.test.ts src/voice/connectors/stt/index.test.ts src/voice/connectors/tts/index.test.ts`
- `PSFN-qyrl.5` / `PSFN-qyrl.6` plugin regressions: `npm test -- --run src/capabilities/eligibility.test.ts src/runtime/channel-lifecycle.test.ts src/runtime/bootstrap-helpers.test.ts src/channels/api/voice-websocket-runtime.test.ts src/channels/discord/voice.test.ts src/voice/connectors/stt/index.test.ts src/voice/connectors/tts/index.test.ts`
- `PSFN-c0zl` / `PSFN-nhtv` targeted regressions: `npm test -- --run src/channels/admin/templates.test.ts src/channels/admin/api-routes.test.ts src/settings.test.ts src/llm/routing.test.ts src/runtime.test.ts`
- `PSFN-c0zl` / `PSFN-nhtv` Garden type/build validation: `npm --prefix admin-ui run check` and `npm run garden:build`
- `PSFN-bxvy.1` targeted regressions: `npm test -- --run src/persistence/layout.test.ts src/types.test.ts src/runtime.test.ts src/lifecycle/notifications.test.ts src/bootstrap/parity.test.ts`
- `PSFN-bxvy.1` admin/runtime validation: `npm test -- --run src/channels/admin/api-routes.test.ts src/channels/admin/server.test.ts src/channels/admin/chat/bootstrap.test.ts src/channels/admin/templates.test.ts`, `npm run garden:build`, and `npm run build`
- `PSFN-bxvy.2` targeted regressions: `npm test -- --run src/channels/admin/server.test.ts src/channels/admin/templates.test.ts src/channels/admin/services/prompts-service.test.ts src/identity/prompt-tools.test.ts src/identity/prompt-sync.test.ts`
- `PSFN-bxvy.2` build validation: `npm run build`
- `PSFN-bxvy.3` targeted regressions: `npm test -- --run src/channels/admin/api-routes.test.ts src/channels/admin/services/prompts-service.test.ts`
- `PSFN-bxvy.3` Garden/runtime validation: `npm --prefix admin-ui run check`, `npm run garden:build`, and `npm run build`
- `PSFN-bxvy.4` targeted regressions: `npm test -- --run src/config/scheduler-runtime.test.ts src/capabilities/runtime.test.ts src/channels/config.test.ts src/types.test.ts src/gateway/server.test.ts src/gateway/methods/web.test.ts src/channels/wyoming/wiring.test.ts src/llm/client.test.ts`
- `PSFN-bxvy.4` build validation: `npm run build`
- `PSFN-bxvy.5` targeted regressions: `npm test -- --run src/persistence/cutover.test.ts src/runtime.test.ts src/bootstrap/parity.test.ts src/channels/admin/server.test.ts`
- `PSFN-bxvy.5` migration CLI validation: `npm run migrate:persistence-layout -- --help`
- `phase-v` build after integrated `PSFN-qyrl.*` / `PSFN-04dt.1` / `PSFN-04dt.5`: `npm run build`
- `PSFN-04dt.2` build validation: `npm run build`
- `PSFN-y2ac.4` guard validation: `npm run verify:settings-contract`, `npm test -- --run src/config/settings-contract-guard.test.ts src/channels/admin/api-routes.test.ts src/settings.test.ts`, `npm --prefix admin-ui run check`, `npm run garden:build`, and `npm run build`
- `PSFN-y2ac.5` round-trip validation: `npm test -- --run src/config/subsystem-config.test.ts src/channels/admin/api-routes.test.ts src/channels/admin/server.test.ts src/settings.test.ts`
- `PSFN-x92u.1` targeted regressions: `npm test -- --cache=false --run src/compositional/policy.test.ts src/settings.test.ts src/channels/admin/api-routes.test.ts src/config/settings-contract-guard.test.ts`
- `PSFN-x92u.1` Garden/runtime validation: `npm --prefix admin-ui run check`, `npm run garden:build`, and `npm run build`
- `PSFN-x92u.2` targeted regressions: `npm test -- --cache=false --run src/compositional/policy.test.ts src/memory/extraction.test.ts src/session/manager.test.ts`
- `PSFN-x92u.2` build validation: `npm run build`
- `PSFN-x92u.3` targeted regressions: `npm test -- --cache=false --run src/memory/retrieval.test.ts src/bootstrap/composition.test.ts src/compositional/policy.test.ts`
- `PSFN-x92u.3` build validation: `npm run build`
- `PSFN-x92u.4` targeted regressions: `npm test -- --cache=false --run src/intention/post-turn-appraisal.test.ts src/bootstrap/deferred-post-turn-inference.test.ts src/bootstrap/parity.test.ts src/bootstrap/post-turn-actions.test.ts`
- `PSFN-x92u.4` build validation: `npm run build`
- `PSFN-x92u.5` / `PSFN-x92u.6` / `PSFN-x92u.7` targeted regressions: `npm test -- --run src/repl/loop.test.ts src/repl/sandbox.test.ts src/bootstrap/composition.test.ts src/shards/manager.test.ts src/memory/extraction.test.ts src/memory/retrieval.test.ts src/channels/admin/server.test.ts src/channels/admin/audit-timeline.test.ts src/agent/substrate-agent.test.ts`
- `PSFN-x92u.5` / `PSFN-x92u.6` / `PSFN-x92u.7` build validation: `npm run build`
- `PSFN-crgg` targeted regressions: `npm test -- --run src/settings.test.ts src/llm/routing.test.ts src/llm/client.test.ts src/llm/correlation.test.ts src/channels/admin/templates.test.ts src/config/subsystem-config.test.ts src/channels/admin/api-routes.test.ts`
- `PSFN-crgg` build validation: `npm run build`
- `PSFN-domy.1` / `PSFN-20kl` settings-contract validation: `npm run verify:settings-contract`
- `PSFN-domy.1` / `PSFN-20kl` targeted regressions: `npm test -- --run src/agent/messages.test.ts src/agent/substrate-agent.test.ts src/session/manager.test.ts src/settings.test.ts src/config/subsystem-config.test.ts src/channels/admin/api-routes.test.ts src/config/settings-contract-guard.test.ts`
- `PSFN-domy.1` / `PSFN-20kl` build validation: `npm run build`
