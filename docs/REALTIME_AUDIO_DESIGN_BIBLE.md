# Real-Time Audio Design Bible (PSFN)

Updated: 2026-02-26
Scope: architectural concepts and reusable design patterns for upgrading PSFN voice capabilities.  
Source inspiration: Pipecat framework patterns, adapted to PSFN constraints and security model.

## 1) Goals

- Move PSFN voice from utterance-batch flow to streaming-first flow.
- Introduce transport and service connector abstractions so voice can run on Discord, web apps, and future modalities.
- Preserve existing gateway security boundary and behavior expectations.
- Keep migration incremental and reversible.

## 2) Non-Goals

- No wholesale rewrite of PSFN runtime.
- No direct port of Pipecat internals or Python runtime into PSFN.
- No degradation of policy/audit controls.

## 3) Current PSFN Voice Baseline

Current implementation is a direct pipeline in `src/channels/discord/voice.ts`:

- Discord event trigger -> join/move voice channel.
- Capture Opus until silence (`CAPTURE_SILENCE_MS`) -> decode full PCM buffer.
- Submit full WAV to STT -> create message -> run handler -> synthesize full TTS response -> play.

Relevant modules:

- `src/channels/discord/voice.ts`
- `src/channels/discord/adapter.ts`
- `src/voice/deepgram.ts`
- `src/voice/elevenlabs.ts`
- `src/event-bus.ts`
- `src/gateway-main.ts` (voice reverse-RPC path)

Current constraints:

- Full-utterance STT path, not streaming partials.
- No explicit timeout/retry policy in STT/TTS clients.
- Voice logic tightly coupled to Discord transport.

## 4) Design Patterns to Adopt

### 4.1 Frame-Based Pipeline Contract

Adopt a typed frame/event contract for voice runtime internals (audio chunks, transcript partial/final, turn markers, control, errors, metrics).

Why:

- Decouples transport from STT/TTS/LLM components.
- Enables incremental processing and interruption-safe behavior.

PSFN adaptation:

- Add voice frame types under `src/voice/pipeline/frames.ts`.
- Keep existing `EventBus` events as outer public interface.

### 4.2 Processor Chain with Directional Flow

Adopt small processors with clear responsibilities (ingest, VAD/turn, STT adapter, context assembly, LLM stream, TTS stream, output).

Why:

- Reduces monolithic logic and local complexity.
- Enables testing each stage independently.

PSFN adaptation:

- Introduce `VoiceProcessor` interface and `VoicePipeline` composition module.
- Keep Discord adapter as transport-level entrypoint.

### 4.3 Priority Control Frames + Interruptibility Rules

Adopt control-path precedence and interruption semantics:

- Control frames (interrupt, stop, fatal) preempt normal data.
- Terminal/control-critical frames remain uninterruptible.

Why:

- Deterministic barge-in behavior.
- Fewer deadlocks and stuck audio playback states.

PSFN adaptation:

- Add queue policy with control/data separation inside voice runtime only.
- Preserve gateway cancellation and shutdown semantics.

### 4.4 Explicit Turn Lifecycle Processor

Adopt dedicated turn lifecycle manager:

- user started
- user stopped
- bot started
- bot stopped
- interruption boundaries

Why:

- Clear turn accounting for latency and behavior tuning.
- Supports advanced strategies (timeout-based, VAD-based, semantic stop).

PSFN adaptation:

- Turn processor emits normalized turn events; downstream components consume it.
- Existing `channel.voice.*` event emissions remain supported.

### 4.5 Transport Abstraction (Input/Output split)

Adopt transport interface split into input and output concerns.

Why:

- Reuse core voice pipeline across Discord, WebSocket, WebRTC, telephony bridges.
- Prevent business logic duplication per connector.

PSFN adaptation:

- `VoiceTransportInput` and `VoiceTransportOutput` interfaces.
- Concrete transports:
  - Discord voice (existing behavior preserved first)
  - WebSocket voice for browser/webapp
  - Optional LiveKit/WebRTC bridge later

### 4.6 Service Connectors as Swappable Adapters

Adopt STT/TTS connectors behind stable interfaces with runtime selection.

Why:

- Easier fallback and A/B testing across providers.
- Enables future connectors without touching pipeline core.

PSFN adaptation:

- `SttConnector` and `TtsConnector` contracts.
- First implementations: Deepgram, ElevenLabs.
- Add connector registry and policy-controlled selection.

### 4.7 Streaming-First IO

Adopt streaming pipeline behavior as first-class:

- Ingest audio in chunks.
- Emit transcript partials and final.
- Stream assistant tokens into incremental TTS chunks where available.

Why:

- Lower response latency.
- Better interruption responsiveness.

PSFN adaptation:

- Keep fallback path for non-streaming providers.
- Support partial transcript events without breaking current message contract.

### 4.8 Observability via Side-Channel Observers

Adopt observers that monitor pipeline events without changing processing logic.

Why:

- Better latency/turn/error metrics.
- Easier debugging and operations.

PSFN adaptation:

- Add observers for:
  - user->bot latency
  - STT first/final transcript timing
  - TTS first-byte and playback completion
  - interruption cause/rate
- Route to logs + optional gateway audit extensions.

### 4.9 Dynamic Service Switching and Fallback

Adopt service switcher concept:

- Manual and policy-driven switching.
- Metadata-aware active service selection.

Why:

- Graceful degradation during provider outages.
- Controlled experimentation.

PSFN adaptation:

- Feature flags in settings/admin.
- Health checks and retry budgets to trigger fallback.

### 4.10 Wire Serializer Boundary for External Transports

Adopt explicit serializer boundary for transport payloads.

Why:

- Clear protocol for browser and external connectors.
- Avoid leaking internal runtime objects over network.

PSFN adaptation:

- Define `voice-wire-v1` schema for WS/WebRTC bridge messages.
- Keep agent/gateway internal protocol separation intact.

## 5) Patterns to Avoid

- Tight coupling of transport + STT + TTS + business logic in one class.
- Provider-specific behavior spread across unrelated modules.
- Hidden interruption behavior without explicit state machine.
- Unbounded queues or no backpressure handling.

## 6) Target Architecture (PSFN)

### 6.1 Component Model

- `VoiceOrchestrator`: owns session state, pipeline lifecycle, policy hooks.
- `VoicePipeline`: ordered processors handling stream flow.
- `VoiceTransport*`: channel-specific input/output adapters.
- `SttConnector` / `TtsConnector`: provider adapters.
- `VoiceObservers`: metrics, tracing, diagnostics.

### 6.2 Flow (Conceptual)

1. Transport input pushes audio chunk frames.
2. Turn/VAD processor emits turn state and interruption signals.
3. STT connector emits transcript partial/final frames.
4. Context/LLM stage emits response token frames.
5. TTS connector emits audio output frames.
6. Transport output plays/streams audio.
7. Observers record latency/errors/usage.

## 7) Security and Reliability Requirements

- All new connectors must preserve existing gateway policy/audit posture.
- Enforce bounded queues, bounded message sizes, and per-stage timeouts.
- Add retry policies with jitter and circuit-breaker style fallback.
- Ensure interruption does not bypass audit/approval constraints when applicable.
- Ensure secrets remain in host/gateway trust boundary as today.

## 8) Incremental Migration Strategy

### Phase A: Foundations

- Define frame model, processor interfaces, transport/service contracts.
- Keep current Discord runtime as adapter over new contracts (compat mode).

### Phase B: Streaming Core

- Add chunked ingest, partial transcripts, interruption-safe playback.
- Introduce timeout/retry/cancel semantics across STT/TTS.

### Phase C: Connector Expansion

- Add WebSocket webapp connector.
- Add optional WebRTC/LiveKit bridge.

### Phase D: Operations

- Add observer metrics, dashboards/logging, SLO alarms.
- Tune turn strategies and fallback policies from production data.

## 9) Definition of Done for Voice vNext

- Streaming response begins before full-user utterance completion in supported modes.
- Barge-in interruption is deterministic and tested.
- Discord voice parity is preserved for existing users.
- At least one non-Discord transport (web app) works end-to-end.
- Provider failover works within configured budgets.
- Latency and failure metrics are available for each stage.

## 10) Mapping to Existing PSFN Modules

Primary implementation zones:

- `src/channels/discord/voice.ts`
- `src/channels/discord/adapter.ts`
- `src/gateway-main.ts`
- `src/gateway/protocol.ts`
- `src/event-bus.ts`
- `src/voice/*` (new pipeline, connectors, observers, serializers)
- `src/settings.ts` and admin settings surfaces for runtime strategy toggles

## 11) Source Pattern References

- Pipecat frame taxonomy and interruptibility model:
  - `src/pipecat/frames/frames.py`
- Pipecat processor queue/priority/interruption model:
  - `src/pipecat/processors/frame_processor.py`
- Pipecat pipeline composition:
  - `src/pipecat/pipeline/pipeline.py`
  - `src/pipecat/pipeline/parallel_pipeline.py`
- Pipecat task/runner lifecycle and observer integration:
  - `src/pipecat/pipeline/task.py`
  - `src/pipecat/pipeline/runner.py`
  - `src/pipecat/observers/*`
- Pipecat transport and serializer abstraction:
  - `src/pipecat/transports/base_transport.py`
  - `src/pipecat/transports/base_input.py`
  - `src/pipecat/transports/base_output.py`
  - `src/pipecat/serializers/base_serializer.py`
- Pipecat service switcher pattern:
  - `src/pipecat/pipeline/service_switcher.py`

## 12) Wyoming MVP Addendum (PSFN-slsv.1)

Architecture decisions for the Home Assistant Voice PE MVP path are locked in:

- `docs/architecture/wyoming-mvp-adr.md`

Implementation constraints from the ADR:

- Topology: Voice PE -> Home Assistant Assist pipeline -> gateway-hosted Wyoming services.
- MVP service contract: `handle` is required; `describe/info` is required for discovery; `asr`/`tts` are optional and must be explicitly advertised when enabled.
- Identity contract: map Wyoming turns to `SubstrateMessage` with `channelType: 'api'` and `channelId` prefixed with `api:wyoming:` for compatibility with current trust/session behavior.
- Event contract: reuse existing generic voice lifecycle events (`voice.turn.*`, `voice.stt.*`, `voice.tts.*`) and message events (`message.received`, `message.sent`) rather than Discord-specific `channel.voice.*`.
- Reliability/security contract: reuse existing queueing/timeouts and voice safety budgets (`src/gateway/backpressure.ts`, `src/gateway/server.ts`, `src/voice/policy/reliability.ts`, `src/voice/policy/security.ts`).

## 13) Echo TTS Operational Compatibility Notes (PSFN-mndj)

### 13.1 Env keys and rollout stance

- Current parsed voice keys are ElevenLabs-centric (`DEEPGRAM_API_KEY`, `DEEPGRAM_MODEL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `ELEVENLABS_MODEL_ID`) in `src/types.ts`.
- Planned provider-switch keys are tracked under `PSFN-mndj.2` assumptions and are documented as:
  - `TTS_PROVIDER`
  - `ECHO_TTS_URL` (default: `http://<your-echo-tts-host>:8001`)
  - `ECHO_TTS_VOICE` (default: `11labs-Allison`)
  - `ECHO_TTS_PRESET` (default: `Independent-High-Speaker-CFG`)
  - `ECHO_TTS_MODEL` (optional override)
- Safe default for rollout remains `elevenlabs` until provider-registry wiring (`PSFN-mndj.2`, `.3`, `.4`) is merged into active runtime paths.

### 13.2 Runtime mapping (Discord/API/Wyoming)

- Discord runtime currently instantiates `createStreamingTtsConnector('elevenlabs', ...)` in `src/channels/discord/voice.ts`.
- API voice websocket runtime currently instantiates `createStreamingTtsConnector('elevenlabs', ...)` in `src/channels/api/voice-websocket-runtime.ts`.
- Wyoming `tts` service path is already connector-agnostic (`StreamingTtsConnector`) in `src/channels/wyoming/services/tts.ts`; provider switching lands by injecting the selected connector, not by changing Wyoming event families.
- MVP Wyoming `handle` behavior remains valid even when `tts` service is disabled; `describe/info` must advertise enabled services truthfully.

### 13.3 Troubleshooting quick notes (format, latency, fallback)

- Streaming format mismatch: confirm requested `encoding` aligns with consumer expectations (`mp3` in current API websocket runtime defaults; `pcm_s16le` where raw PCM metadata is required).
- First-byte latency spikes: inspect per-stage timing (`voice.tts.first-byte` and runtime stage budgets) before tuning; most spikes come from upstream provider cold starts or transient network stalls.
- Fallback behavior: if streamed chunks fail decode/playback, allow buffered fallback for that turn and keep one known-good provider config complete before enabling automatic switch-over.
