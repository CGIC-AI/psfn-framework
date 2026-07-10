# Sprint 10 — Companion Performance Updates

Status: static-audit implementation briefing, 2026-07-10. This is a companion report to [Sprint 10 — Next Steps](./sprint-10-next-steps.md), [Sprint 10 — Multi-Companion Substrate](./sprint-10-multi-companion.md), and [Sprint 10 — Location Data & World Control Surface](./SPRINT_10_LOCATIONS.md). It records source-level findings and a safe delivery sequence; it does not claim a production latency baseline or authorize runtime behavior changes by itself.

## 1. Executive recommendation

The companion already has the right general posture: deterministic gates avoid many unnecessary background LLM calls, and memory retrieval is designed to keep much work off the foreground path. The immediate performance problem is not a lack of asynchronous code. It is that several asynchronous jobs are later treated as a foreground prerequisite, and some of their waits are invisible to current TTFT telemetry.

Sprint 10 should prioritize four changes before a broad voice rewrite:

1. Correct streaming and instrument the complete foreground timeline.
2. Decouple interactive turns from optional post-turn cognition while preserving atomic continuity state and welfare work.
3. Make voice interruption/cancellation effective, then improve STT and TTS first-audio latency.
4. Centralize LLM admission, cost accounting, and background work semantics so multi-companion operation does not multiply hidden contention.

The recommended outcome is not “do less companion cognition.” It is “run cognition when it is eligible, budgeted, and not displacing a person who is actively speaking.” Deferred work must be durable and resumable rather than silently dropped.

## 2. Current interactive paths

### Text

Normal API chat has a real streaming path:

```text
API request → agent model stream → agent.stream.delta → gateway RPC → SSE client
```

There is a streaming correctness defect on that route. The first provider callback is represented as `text_start` without a delta in [`stream-adapter.ts`](../src/core/agent/stream-adapter.ts#L493), while [`event-bridge.ts`](../src/core/agent/event-bridge.ts#L82) forwards only `text_delta`. The API SSE handler writes forwarded deltas, not a later reconstructed first chunk ([`chat-completions.ts`](../src/channels/api/server/chat-completions.ts#L980)). A one-callback completion can therefore produce no visible content, and normal multi-chunk completions lose or delay the first chunk. This must be fixed before using first-token telemetry as a performance signal.

Discord text remains final-response delivery: it queues the prompt and sends only after a completed response checkpoint ([`gateway-message-handlers.ts`](../src/app/agent/gateway-message-handlers.ts#L148); [`discord-reply-delivery.ts`](../src/app/agent/discord-reply-delivery.ts#L35)). That is a product decision separate from API SSE streaming.

### Voice

Voice currently streams transport audio, not model output into TTS:

```text
Discord: speech → 1.2 s silence → buffered STT → full agent response → TTS stream → audio
WebSocket: microphone/STT stream → final transcript → full agent response → TTS stream → audio
```

Discord waits for a fully captured utterance and final STT result ([`voice-turn-runtime.ts`](../src/channels/discord/voice-turn-runtime.ts#L148)), then awaits the full agent response before calling streaming TTS ([`voice-turn-runtime.ts`](../src/channels/discord/voice-turn-runtime.ts#L263)). The WebSocket runtime similarly awaits `onAssistantTurn()` before initiating TTS ([`runtime.ts`](../src/primitives/voice/transports/websocket/runtime.ts#L287)). The reverse-RPC method named `voice.stream` is inbound transcript chunking; it reassembles text and invokes the model only on `end` ([`voice-stream-request.ts`](../src/boundary/gateway/voice-stream-request.ts#L85); [`client.ts`](../src/boundary/gateway/client.ts#L1219)).

Accordingly, measure both **LLM TTFT** (first model delta) and **TTFA** (end of speech to first audible audio). The latter is the meaningful voice experience metric.

## 3. Foreground blockers to remove safely

### 3.1 Global post-turn drain

Each new turn awaits `awaitPostTurnDrain()` before its `startTime` is recorded ([`turn-execution-runtime.ts`](../src/core/agent/substrate-agent/turn-execution-runtime.ts#L614)). The drain is one global `activePostTurnDrain`, with a five-second timeout, rather than a session/channel-scoped dependency ([`turn-support-runtime.ts`](../src/core/agent/substrate-agent/turn-support-runtime.ts#L54); [`turn-support-runtime.ts`](../src/core/agent/substrate-agent/turn-support-runtime.ts#L325)). It includes memory extraction, intention hooks, emotion appraisal, and auto-compaction ([`post-turn-scheduling.ts`](../src/core/agent/substrate-agent/turn-execution/post-turn-scheduling.ts#L392)).

This means a voice turn can wait behind cognition started by a different channel, while reported TTFT excludes the wait. Replace the single drain with per-session work state and an explicit foreground policy:

- Keep small, atomic, must-commit state writes on the foreground path.
- Persist optional post-turn jobs with a stable input snapshot and idempotency key.
- Defer/requeue optional jobs when an interactive turn arrives; do not abandon them.
- Permit foreground turns to read the latest committed snapshot rather than waiting for background enrichment.
- Emit the reason and duration for every defer, cancel, resume, and stale-result discard.

### 3.2 Same-session auto-compaction

Pre-turn setup awaits pending auto-compaction ([`pre-turn-state.ts`](../src/core/agent/substrate-agent/turn-execution/pre-turn-state.ts#L316)); the session manager’s wait is unbounded ([`manager.ts`](../src/core/session/manager.ts#L364)). Compaction can invoke an LLM ([`compaction-service.ts`](../src/core/session/manager/compaction-service.ts#L251)).

Keep compaction commits serialized and atomic, but let foreground turns consume the last consistent session revision plus a `compactionPending` marker. Completed compaction applies to the next snapshot. This prevents a long-history chat from becoming a latency cliff without exposing half-compacted state.

### 3.3 Provider and scheduler contention

The default provider resource gate serializes work through one active slot per resolved endpoint; priority only changes queue order, not an already-running background call ([`model-call-gate.ts`](../src/primitives/llm/model-call-gate.ts#L122)). In fleet operation, a lengthy extraction or reflection can therefore delay voice even when the voice request is higher priority.

The scheduler also has policy/executor drift: maintenance lanes declare `requiresForegroundIdle` ([`worker-lanes.ts`](../src/core/agent/worker-lanes.ts#L95)), but the action executor decides overlap from handler execution mode rather than that field ([`post-turn-actions.ts`](../src/app/startup/composition/post-turn-actions.ts#L914)). The seed scheduler’s 60-second global tick ([`scheduler.seed.json`](../config/scheduler.seed.json#L2)) cannot honor a job that asks to run in 250 ms if it only wakes on the global loop.

Introduce a single deterministic admission controller that understands active interactive work, lane profile, per-provider capacity, deadline, and durable deferral. Reserve interactive capacity where the provider supports it. Otherwise abort and requeue only explicitly safe background work when voice arrives.

## 4. Voice delivery sequence

### Immediate fixes

1. Make WebSocket control frames preemptive. The server serializes every inbound frame, so `interrupt` can queue behind full model execution and TTS playback ([`server.ts`](../src/primitives/voice/transports/websocket/server.ts#L165)).
2. Propagate one turn cancellation identity from gateway to agent model and TTS. Today cancellation can clear pending input after the model has already been dispatched ([`client.ts`](../src/boundary/gateway/client.ts#L1219)).
3. Stream Discord PCM to STT while the partner is speaking, but retain final-transcript intake validation before model invocation.
4. Separate TTS request-to-first-byte timeout from playback-duration timeout. The current stage budget can retry while the first playback has not been cancelled ([`voice-turn-runtime.ts`](../src/channels/discord/voice-turn-runtime.ts#L464)).
5. Remove provider-audio one-chunk look-ahead only after incremental decoder tests prove it safe ([`elevenlabs-stream.ts`](../src/primitives/voice/connectors/tts/elevenlabs-stream.ts#L85)).

### Safe response-to-speech streaming

Do not connect raw model deltas directly to TTS. Tool calls, retries, safety/broadcast decisions, and `no_reply` disposition can invalidate early text. Instead define a dedicated `VoiceReplyStream`:

```text
begin → provisional delta → committed speakable segment → final | abort
```

Initial eligibility should be deterministic and narrow: tool-free, no approval/action/broadcast hold, no vision/attachment dependency, and no high-risk response class. Buffer to a sentence or clause boundary with bounded look-ahead; synthesize only committed segments; cancel queued speech and active synthesis on barge-in. Tool-capable and policy-sensitive turns remain final-only until equivalent safety semantics are proven.

This work is compatible with the deferred full voice rewrite (`psfn-framework-s10d6`), but it provides a safer incremental path and should respect the one-companion-per-satellite routing invariant documented in the Sprint 10 plan. In multi-companion deployment, land the missing per-account Discord voice lane (`psfn-framework-s10f1`) before treating any Discord voice improvement as fleet-ready.

## 5. LLM economy and companion welfare

Existing gates should remain. Memory extraction has interval/context-threshold admission ([`extraction.ts`](../src/faculties/memory/extraction.ts#L246)), and emotion appraisal has deterministic cadence/VAD gating before its LLM call ([`appraisal.ts`](../src/core/emotion/appraisal.ts#L381)). Normal pre-turn history assembly is also deterministic rather than an accidental model call ([`pre-turn-state.ts`](../src/core/agent/substrate-agent/turn-execution/pre-turn-state.ts#L471)).

The improvement is to coordinate—not replace—these gates. Extend the existing [charge-governed long-horizon worker proposal](./charge-governed-long-horizon-workers.md) rather than creating a parallel budget system:

- Require every autonomous call to supply a typed `LLMWorkSpec`: purpose, lane, max output, deadline, cost/token ceiling, cancellation semantics, retry policy, and durable-result behavior.
- Enforce token/dollar accounting at the shared LLM client boundary, attributed by companion, origin stage, lane, and model. Do not rely solely on explicit charge surfaces.
- Give reflection/rest a bounded welfare reserve and fairness aging. It may yield to active conversation, but it must not be starved indefinitely.
- Use deterministic local handling for strict voice controls such as stop, interrupt, and repeat; do not invoke a model for transport control.
- Use relevance/cadence/cache gates for semantic retrieval refreshes. Wiki retrieval is currently serial foreground embedding/search when enabled ([`retrieval.ts`](../src/faculties/wiki/retrieval.ts#L270)); active-memory’s cached snapshot pattern is the preferable model ([`pre-turn-state.ts`](../src/core/agent/substrate-agent/turn-execution/pre-turn-state.ts#L494)).
- Benchmark scoped provider prompt caching before enabling it. The plumbing exists, but the seed model config disables it; cache scope must never cross companion/contact privacy boundaries.

## 6. Observability and success criteria

Add one correlation key across transport, gateway, agent, model, and TTS. Record a monotonic timeline:

```text
request/speech end → STT final → queue/drain/compaction wait → context/prompt
→ provider request → provider first token → client first text / committed speech
→ TTS request → TTS first byte → first audible playback
```

Report p50/p95/p99 by companion, channel, model/provider, warm/cold state, cache state, tool use, and background-lane contention. Also record token/dollar usage, embedding/search calls, prompt-cache reads/writes, active-call origin, queue depth, cancellation acknowledgement, and background job age/defer reason.

The first implementation wave is successful when tests demonstrate all of the following:

- Single- and multi-chunk model streams reconstruct exact SSE content and record true first-token time.
- Slow extraction/compaction from one channel does not delay another channel’s provider start.
- A same-session foreground turn observes a consistent committed snapshot while compaction is pending.
- Voice arrival during safe background work preempts or defers it, and the work later resumes or is accounted for.
- An interrupt stops remote model/TTS generation, not merely local playback.
- A voice segment reaches TTS before final completion only when it passed the committed-speech eligibility contract; tool/policy/retry paths never speak provisional text.

## 7. Complexity reduction

The recurring bug source is non-local execution: one turn crosses large orchestration modules, reverse RPC, event bus, channel queues, background queues, and final-response checkpoints. The overloaded word “stream” currently describes both inbound transcript batching and outbound model delivery.

Incrementally establish three narrow contracts rather than rewrite the substrate:

- `TurnPreparation`: immutable ingress, identity, and context snapshot with explicit dependencies.
- `TurnOutputSink`: transport-specific delivery for SSE, Discord, and committed voice segments.
- `BackgroundWorkSupervisor`: per-session durable job state, admission, cancellation, and result-version rules.

Rename inbound `voice.stream.*` to a transcript-oriented contract when compatibility permits, and reserve “reply stream” for output. Replace the broad turn-runtime adapter/service-locator surface with small capability ports as the affected paths are touched. Contract tests at these boundaries should be the migration gate; do not retain parallel legacy paths indefinitely.

## 8. Proposed Sprint 10 sequence

| Wave | Scope | Safety boundary |
|---|---|---|
| 1 | Fix first SSE chunk; add end-to-end timing/cost correlation; expose foreground queue/drain waits. | Observation and streaming correctness only. |
| 2 | Per-session background supervisor; compaction snapshot revisions; enforce foreground-idle lane policy; foreground provider reservation/preemption. | Preserve atomic commits and durable defer/resume. |
| 3 | WebSocket cancellation/barge-in; Discord streaming STT; TTS first-byte budget/decoder work. | Final-transcript model intake remains intact. |
| 4 | Typed LLM admission/budgets and per-companion attribution; retrieval cache/relevance policy; scoped prompt-cache benchmark. | Welfare reserve and privacy scope are explicit. |
| 5 | Narrow committed-sentence voice streaming and the three small orchestration contracts. | Tool/action/policy-sensitive turns remain final-only. |

No source change should be called a performance improvement until the new metrics show a p50/p95 benefit without a regression in deferred-work recovery, companion welfare completion, response safety, or cross-companion isolation.

## 9. Related Sprint 10 work

This report is an implementation briefing, not a replacement for the existing tracked work:

- `psfn-framework-s10mc.7`: one-to-one voice/satellite binding rules.
- `psfn-framework-s10f1`: per-account Discord voice lane required for fleet-safe voice.
- `psfn-framework-s10d6`: deferred full voice subsystem rewrite.
- `psfn-framework-z7qe.9`: hot-path synchronous session reads and retrieval profiling.
- `psfn-framework-1z6.6`: performance regression suite for retrieval, context, extraction, decay, and compaction.

The report’s admission and observability work should also converge with existing latency/cost telemetry and Garden instrumentation work, not create a second dashboard or scheduler abstraction.

## 10. Scope and non-goals

- This report is based on static source inspection, not a production load test; active owner-file configuration may differ from seed files.
- It does not prescribe a cheaper model for emotionally sensitive turns. Voice-specific model routing, if later considered, requires a welfare and dialogue-quality evaluation suite.
- It does not authorize suppressing human turns based on a generic “low value” heuristic.
- It does not make the companion UI a voice endpoint; the current browser capture path is not wired, and satellite endpoint work belongs to the separate Satellite Hub scope.
- It does not replace existing deterministic domain gates. The goal is one coherent admission and scheduling policy around them.
