# Autoresearch: Reduce TTFT in Companion Response Turns

## Objective
Reduce the time-to-first-token (TTFT) for companion response turns by optimizing the software overhead in the pre-prompt pipeline, without removing or degrading the context/memory/prompt quality that feeds into the LLM.

## Metrics
- **Primary**: `median_turn_ms` (ms, lower is better) — median wall-clock duration of `agent.handleMessage()` from entry to the first `agent.stream.delta` event.
- **Secondary**:
  - `prompt_to_stream_ms` — time from `agent.prompt()` call to first stream delta.
  - `pre_prompt_ms` — time from `handleMessageForTurn` start to `agent.prompt()` call.
  - `stat_sync_calls` — number of synchronous `fs.statSync` calls inside the hot path per turn.

## How to Run
`./autoresearch.sh` — runs the benchmark and outputs `METRIC` lines.

## Files in Scope
- `src/core/agent/substrate-agent/turn-execution-runtime.ts` — main turn orchestration; hot path for prompt assembly and pre-prompt I/O.
- `src/core/agent/substrate-agent.ts` — `SubstrateAgent` wrapper; computes prompt variables and runtime context.
- `src/core/identity/prompt-runtime.ts` — `PromptRuntimeLayoutStore` which does synchronous file I/O on every access.
- `src/core/agent/substrate-agent/prompt-lifecycle.ts` — static prompt prefix caching.
- `src/core/agent/substrate-agent/runtime-context.ts` — helpers for building dynamic variables and runtime context.
- `src/core/agent/event-bridge.ts` — bridges stream deltas to EventBus.

## Off Limits
- Do not remove memory retrieval, trust checks, or session context building.
- Do not change LLM provider/routing logic or model selection.
- Do not degrade response quality by stripping prompt sections.

## Constraints
- All existing tests must pass (`npm test -- --run src/core/agent/substrate-agent.test.ts` and related).
- `npm run lint` must pass.
- No new runtime dependencies.

## What's Been Tried
