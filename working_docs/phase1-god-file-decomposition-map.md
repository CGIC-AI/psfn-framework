# Phase-1 God-File Decomposition Map (PSFN-ikln)

Scope for this stream: runtime/agent-main only. Admin server and telegram adapter decomposition are intentionally deferred.

## Current hotspots (baseline)
- `src/runtime.ts` (~1069 LOC before this stream)
  - Mixed concerns: runtime bootstrap config helpers, lifecycle orchestration, channel startup, wyoming wiring, API/admin wiring.
- `src/agent-main.ts` (~986 LOC before this stream)
  - Mixed concerns: startup/bootstrap, gateway lifecycle, wyoming routing policy, network isolation, API/admin wiring.

## Phase-1 extractions implemented here
1. Runtime bootstrap helper extraction
- Source: `src/runtime.ts`
- New module: `src/runtime/bootstrap-helpers.ts`
- Moved concerns:
  - Voice provider resolution (`resolveRuntimeVoiceSttProvider`, `resolveRuntimeVoiceTtsProvider`)
  - Telegram runtime channel overrides (`buildRuntimeChannelsConfigOverrides`)
  - Embedding mismatch fatal message composition (`createEmbeddingDimensionMismatchFatalMessage`)
  - Promoted-tools settings persistence hook (`installPromotedToolsPersistenceHook`)
- Wiring outcome: `src/runtime.ts` now imports these helpers and re-exports parity-facing APIs (`buildRuntimeChannelsConfigOverrides`, `createEmbeddingDimensionMismatchFatalMessage`).

2. Agent Wyoming routing policy extraction
- Source: `src/agent-main.ts`
- New module: `src/agent-main/wyoming-routing.ts`
- Moved concerns:
  - Wyoming routing metadata resolution (`resolveWyomingRoutingMetadata`)
  - Delegation decision policy (`evaluateWyomingDelegation`)
- Wiring outcome: `src/agent-main.ts` now imports `evaluateWyomingDelegation` and keeps behavior unchanged at call sites.

## Parity proof strategy in this stream
- Existing parity tests retained:
  - `src/runtime.test.ts` still validates exported runtime helper behavior via `src/runtime.ts` re-exports.
- Added targeted extraction tests:
  - `src/runtime/bootstrap-helpers.test.ts`
  - `src/agent-main/wyoming-routing.test.ts`

## Deferred phase-2 seams (out of current scope)
- `src/runtime.ts`
  - Channel adapter registry/start-stop orchestration can move to dedicated runtime channel lifecycle module.
  - API/admin/wyoming server bootstrap blocks can be isolated into `runtime/servers/*` composition helpers.
- `src/agent-main.ts`
  - Gateway message handler registration and shutdown wiring can be split into `agent-main/handlers/*` and `agent-main/lifecycle/*`.
  - Network isolation probe logic can later move once source-based wiring tests are adjusted.
