# Voice — Speech, Pipeline & Transports

> **Working draft** in `working_docs/docs-gap/voice.md` — promote to `docs/voice.md` after review.
> **System:** `voice` (`system:voice`) · **Code:** `src/primitives/voice/` (pipeline, reply-stream, transports, policy) + `src/channels/api/voice-websocket.ts` + `src/channels/discord/voice*.ts`
> **Tracker:** `working_docs/docs-gap/TRACKER.md` #4 · **Status:** draft from code @ 2026-08-06

## Orientation

Voice is the speech surface for both inbound (STT) and outbound (TTS) companionship. Inbound audio → Deepgram transcription → Wyoming adapter → agent turn. Outbound text → `VoiceReplyStream` segmenter → ElevenLabs TTS → satellite WS or companion-app WS. The agent's live output is split structurally into two disjoint channels so **tool-call JSON never reaches TTS** — tools still execute normally while the companion speaks.

**Who it's for:** contributors adding STT/TTS providers or a new transport, operators tuning voice policy, and reviewers auditing content gates.

**Fits between:** `channels.md` (transport + gateway edge) → here (frames, bridge, providers) → `chat-turn-lifecycle.md` (turn anatomy) → `cognitive-security.md` (content gates).

## Mental model

```
Inbound:  Mic/device ─► AudioFrames ─► Deepgram ─► transcript ─► Wyoming adapter ─► agent turn
Outbound: agent.stream.delta (text only) ─► VoiceReplyStream (segmenter + content gates) ─► committed segments ─► ElevenLabs ─► satellite WS / companion-app WS
                              ▲ not subscribed
                    agent.toolcall.* (structural isolation; never fed to TTS)
```

* **`VoicePipeline`** (`pipeline/pipeline.ts:45`) is a generic `source → processors → sink` with `AbortSignal` + `runId` scoping. Inbound audio and outbound TTS both run as pipelines.
* **`AgentReplyStreamBridge`** (`reply-stream/agent-stream-bridge.ts:1`) is the reusable core that drinks live `agent.stream.delta` for a single `(channelId, turnId)` and surfaces an async iterable of committed segments.
* **Law-18 tripwire is relaxed for voice only** (`reconcileFinalContent: false`, `:19`): voice speaks the live stream, not the authoritative `AgentResponse.content`. Per-segment gates are **unchanged** and still fail closed.

## Entry points

| Entry | Location | Purpose |
|-------|----------|---------|
| `VoicePipeline<TInput,TOutput>` | `src/primitives/voice/pipeline/pipeline.ts:45` | `fromSource(source).processors([...]).sink` — generic stage runner with `VoicePipelineContext {signal, runId}` |
| `AgentReplyStreamBridge` | `src/primitives/voice/reply-stream/agent-stream-bridge.ts:1` | `agent.stream.delta` (text-only port) → `VoiceReplyStream` → async iterable of `CommittedSegment` |
| `createVoiceReplyStream()` | `src/primitives/voice/reply-stream/reply-stream.ts` | Segmenter + per-segment `ContentGateConfig` (image-claim, datetime-contradiction) + in-order-prefix invariant |
| `Deepgram` | `src/primitives/voice/deepgram.ts` | STT provider (streaming frames → transcript) |
| `ElevenLabs` | `src/primitives/voice/elevenlabs.ts` | TTS provider (committed segments → audio bytes) |
| `AudioFrames` / `VoicePipelineQueue` | `src/primitives/voice/pipeline/frames.ts`, `queue.ts` | Frame batching + queue for streaming audio |
| `VoiceWebSocketAdapter` | `src/channels/api/voice-websocket.ts` | Companion-app WS transport for voice turns |
| `discord/voice*.ts` | `src/channels/discord/voice*.ts` | Discord voice transport (preflight, turn runtime, recovery runtime, TTS first-byte) |
| `ControlIntent` | `src/primitives/voice/control-intent.ts` | Control-plane intent for barge-in / cancellation |
| `observers/{latency,turns,errors}` | `src/primitives/voice/observers/` | Voice observability (latency histograms, turn counters, error taxonomy) |

## Key types

| Type | Location | Purpose |
|------|----------|---------|
| `VoicePipelineContext` | `src/primitives/voice/pipeline/pipeline.ts:3` | `{signal: AbortSignal, runId: number}` — lifecycle scope for every stage |
| `VoicePipelineDefinition<TIn,TOut>` | `src/primitives/voice/pipeline/pipeline.ts:24` | `{source, processors, sink}` shape |
| `AgentReplyDeltaEvent` | `src/primitives/voice/reply-stream/agent-stream-bridge.ts:32` | `{channelId, text, turnId?}` — text delta only (no toolcall field exists) |
| `AgentReplyDeltaSource` | `src/primitives/voice/reply-stream/agent-stream-bridge.ts:43` | Port that exposes **only** `agent.stream.delta` — toolcall channel structurally absent |
| `CommittedSegment` / `SegmenterConfig` / `ContentGateConfig` | `src/primitives/voice/reply-stream/types.ts` | Segmented speakable text with per-segment gates |
| `ReplyStreamAbortReason` | `src/primitives/voice/reply-stream/types.ts` | `barge_in | turn_cancel | channel_switch` |
| `ReliabilityPolicy` / `SecurityPolicy` | `src/primitives/voice/policy/reliability.ts`, `security.ts` | Reconnect, budget, and trust policy for voice transports |

## Data flow

### Inbound (STT)

`VoicePipeline.Source` (device frames) → `VoicePipelineTask` stages → `Deepgram` → transcript. The `VoicePipelineQueue` batches frames; `VoicePipelineRunner` drives `signal` cancellation on barge-in. Transcript is fed to the Wyoming host adapter and then to `SubstrateAgent` as a normal turn (CogSec intake runs on the transcript).

### Outbound (TTS) — the bridge

1. Gallery listener subscribes to `deltaSource.on('agent.stream.delta', handler)` for one `turnId` + `channelId` (`agent-stream-bridge.ts:43`). Structural guarantee: the port has **no** `agent.toolcall.*` surface, so tool JSON cannot leak to TTS even under race.
2. Deltas flow into `createVoiceReplyStream(segmenter, gate)` — segmenter splits live text into speakable segments (sentence-ish), `ContentGateConfig` runs image-claim + datetime-contradiction checks per segment, fail-closed.
3. Each finalized `CommittedSegment` is yielded from the async iterable; the TTS sink (`ElevenLabs`) drinks it as it finalizes — incremental speech, not buffered whole-reply.
4. On `barge_in` / `turn_cancel`, the `AbortSignal` aborts the pipeline and the `ReplyStream` surfaces `ReplyStreamAbortReason`.

### Defensive properties

* **Tool isolation is structural,** not a filter: the bridge never subscribes to `agent.toolcall.*` (`:7`). Text and tool JSON are separate event channels at the `EventBus` layer.
* **Per-segment gates unchanged.** Even with `reconcileFinalContent: false`, every segment still passes the in-order-prefix invariant and content gates — `content-gate.ts` fails closed.
* **Telemetry split.** Raw `onProvisionalDelta` is telemetry-only (`:58`) — never speakable (Law 18).

## External dependencies

| Dependency | Purpose | Critical |
|------------|---------|----------|
| Deepgram (STT) | Streaming transcription | Per voice deployment |
| ElevenLabs (TTS) | Segment → audio bytes | Per voice deployment |
| Gateway `/v1` + satellite WS mTLS | Device ↔ agent transport (`certificates.md`) | For satellite hub |
| PostgreSQL | Voice-turn transcript persistence (via `SessionManager`) | Yes |
| `EventBus` (`agent.stream.delta`) | Live text delta stream | Yes |

## Configuration

| Source | Priority | Example |
|--------|----------|---------|
| `channels.json` + per-channel voice block | Canonical | `voice:{enabled, stt:{provider,model}, tts:{provider,voice}, ingressMode}` |
| `voice-server-options` wiring | `src/channels/api/voice-server-options-wiring.test.ts` | WebSocket runtime hooks (`VoiceWebSocketRuntimeHooks`) |
| Env (provider keys) | Bootstrap only | `DEEPGRAM_API_KEY`, `ELEVENLABS_API_KEY` via `CredentialReference` (never logged) |
| Policy tunables | `src/primitives/voice/policy/reliability.ts` | Reconnect caps, first-byte budget (Discord `voice-tts-first-byte.test.ts`) |

## Test infrastructure

| Type | Location | Coverage |
|------|----------|----------|
| Pipeline | `pipeline/pipeline.test.ts`, `queue.test.ts`, `runner.test.ts`, `task.test.ts` | Stage ordering, `AbortSignal` cancellation, queue backpressure |
| Bridge | `reply-stream/agent-stream-bridge.test.ts`, `content-gate.test.ts` | Text-only subscription, segment finalization, Law-18 relaxation + still-gated segments |
| Policy | `policy/reliability.test.ts`, `security.test.ts` | Reliability budgets, trust gates on inbound audio |
| Transports | `channels/api/voice-websocket.test.ts`, `channels/discord/voice.test.ts` | WS lifecycle, Discord preflight/recovery |

## Pitfalls & gotchas

* **Don't subscribe to `agent.toolcall.*` in any voice path.** The bridge's port intentionally omits it — adding a toolcall listener adjacent to TTS would structurally re-introduce the leak the bridge was designed to prevent.
* **Speak only `CommittedSegment`, never `onProvisionalDelta`.** Provisional deltas are telemetry (`:58`) — they haven't passed per-segment gates.
* **Respect `AbortSignal` + `runId`.** Every pipeline stage takes `VoicePipelineContext`; ignoring `signal.aborted` leaks audio tasks across turns.
* **First-byte matters.** Discord voice has a TTS first-byte budget — the bridge yields segments as they finalize precisely to bound it; don't buffer the whole reply.

## Cross-links

* `docs/channels.md` (transports), `docs/certificates.md` (satellite mTLS), `docs/chat-turn-lifecycle.md` (turn delta events), `docs/cognitive-security.md` (content gates), `docs/tool-surface.md` (what TTS isolation preserves)

## Promotion notes

Move to `docs/voice.md`; link from `docs/channels.md` and `docs/architecture.md` (Gateway Responsibilities → voice transports). Keep `docs/tool-surface.md` note that voice TTS gates strip no tools — isolation is structural.
