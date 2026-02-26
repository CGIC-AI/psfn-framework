# ADR: Wyoming MVP Topology + Protocol Contract (Voice PE + HA + Gateway)

- Status: Accepted
- Date: 2026-02-26
- Issue: `PSFN-slsv.1`
- Decision scope: Home Assistant Voice Preview Edition (Voice PE) MVP path to gateway-hosted PSFN voice services.

## 1) Context

PSFN needs a concrete MVP integration path for Home Assistant Voice PE hardware before Wyoming runtime/service code is implemented. Today, voice paths in this repo are Discord- and API-websocket-centric, with typed turn events and Substrate message handling already established in:

- `src/channels/discord/voice.ts`
- `src/channels/api/voice-websocket-runtime.ts`
- `src/gateway-main.ts`
- `src/gateway/server.ts`
- `src/gateway/protocol.ts`
- `src/event-bus.ts`
- `src/types.ts`

The architecture choice must preserve the gateway trust boundary, reuse existing voice/agent primitives, and avoid assumptions that conflict with how Voice PE is actually operated (through Home Assistant Assist).

## 2) Decision Summary

For MVP, PSFN will support Voice PE through the **Home Assistant Assist pipeline path** (HA-mediated path), with Wyoming `handle` as required and `asr`/`tts` as optional add-ons.

### Selected Topology (MVP)

```text
Voice PE (ESPHome satellite)
  -> Home Assistant Assist pipeline
    -> Gateway Wyoming service host
      -> PSFN agent/runtime
    <- Gateway Wyoming response
  <- Home Assistant playback/device orchestration
```

### Why this topology is selected

- Voice PE is naturally orchestrated by Home Assistant; MVP should not require custom device firmware workflows.
- Keeps device provisioning/wake-word/assist orchestration in HA where operators already manage it.
- Preserves PSFN security posture: provider secrets remain gateway-side, not satellite-side.
- Aligns with existing gateway-centric runtime design (`src/gateway-main.ts`, `src/gateway/server.ts`).

## 3) Rejected Alternatives

### A) Direct Voice PE -> Gateway Wyoming satellite path (rejected for MVP)

Rejected because it introduces unnecessary hardware/firmware assumptions for MVP and bypasses the Home Assistant Assist control plane that Voice PE deployments rely on.

### B) Gateway-only custom path that bypasses HA Assist for Voice PE (rejected for MVP)

Rejected because it creates an integration mode that is harder to operate in typical HA environments and does not use HA’s existing session/device management.

## 4) Wyoming Event Families (MVP Contract)

This ADR defines **families** and required behavior. Concrete frame names for each family are implemented in follow-on transport/service issues.

### Required family: `describe/info`

- Client sends `describe`.
- Gateway returns `info` with exact service availability.
- `info` MUST always include `handle`.
- `info` MUST include `asr` and/or `tts` only when those adapters are enabled.

### Required family: `handle`

- `handle` is the MVP conversation contract.
- Input is normalized utterance text plus identity/session metadata from HA/Wyoming context.
- Output is assistant text response (single response for MVP; streaming text can be added later if protocol/runtime supports it).
- Errors in this family must be explicit and machine-actionable (`timeout`, `unavailable`, `invalid_request`, `cancelled`).

### Optional families: `asr`, `tts`

- `asr` and `tts` are optional in MVP and may be disabled.
- If disabled, they are omitted from `info` and direct calls return a deterministic not-supported error.
- If enabled, they reuse existing connector/policy primitives (reliability + security limits) instead of bespoke limits.

## 5) Canonical Identity Mapping (SubstrateMessage + EventBus)

MVP mapping must reuse existing types and trust classification behavior.

### SubstrateMessage mapping

- `channelType`: use `'api'` for MVP (no `wyoming` channel type exists yet in `src/types.ts`).
- `channelId` format: `api:wyoming:<siteId>:<satelliteId>`.
- Fallback when metadata is missing: `api:wyoming:unknown:<connectionId>`.
- `authorId` format: `wyoming-user:<haUserId|satelliteId|unknown>`.
- `authorName`: HA-provided display name when available, else `Wyoming Voice User`.
- `isDirectMessage`: `true`.
- `id` format: `wyoming-msg-<connectionId>-<sequence>`.

`api:` prefix is required so channel visibility continues to classify as private under current trust defaults (`config/trust-policy.seed.json`, consumed by `src/trust/policy.ts`).

### Session/turn identity mapping

- Transport session key: `<connectionId>` from Wyoming connection runtime.
- Conversation key: `<siteId>:<satelliteId>` (stable per satellite for MVP).
- Turn key: `wyoming-turn-<connectionId>-<sessionOrRequestId>-<sequence>`.

### EventBus mapping

For each successful `handle` turn, emit in this order:

1. `voice.turn.start`
2. `voice.stt.final` (text already resolved when entering `handle`)
3. `message.received`
4. `message.sent`
5. `voice.tts.requested`
6. `voice.turn.end` (`status: completed`)

On failure:

1. `voice.turn.error`
2. `voice.turn.end` (`status: timeout | error | cancelled`)

Do not emit Discord-scoped `channel.voice.*` for Wyoming MVP. Those payloads are Discord-specific and should remain tied to Discord runtime semantics.

## 6) Failure, Timeout, and Fallback Contract

### Gateway/runtime limits

- Use bounded queues for inbound session/frame buffering with explicit overflow policy (default: error), aligned with existing `BoundedQueue` usage (`src/gateway/backpressure.ts`, `src/gateway/server.ts`).
- Enforce request-level timeout for gateway-to-agent execution with a 60s ceiling for MVP parity with current gateway defaults (`DEFAULT_AGENT_TIMEOUT_MS` in `src/gateway/server.ts`).
- Reuse stage budgets from `resolveVoiceReliabilityBudgets` (`src/voice/policy/reliability.ts`) for STT/LLM/TTS pathways when enabled.
- Reuse payload limits from `resolveVoiceSecurityLimits` (`src/voice/policy/security.ts`).

### Error handling behavior

- Malformed protocol frames: deterministic protocol error; do not crash gateway process.
- Session misuse (unknown session, bad sequence, overflow): deterministic session-scoped error.
- Upstream timeout/unavailable: return retryable service error to client and emit `voice.turn.error`.
- Client disconnect/cancel: abort active turn work and emit `voice.turn.end` with `cancelled`.

### Compatibility fallback behavior

- If downstream agent voice-stream method is unavailable, runtime must support a non-stream compatibility path where possible (same compatibility intent as gateway voice stream fallback in `src/gateway/server.ts`).
- If optional `asr`/`tts` are unavailable, service discovery (`info`) must make that explicit.

### Remote client fallback expectation

When gateway Wyoming service is unavailable or times out, operators should configure HA Assist with a local/default fallback pipeline so Voice PE remains usable.

## 7) Concrete Integration Points for Implementation

- `src/gateway-main.ts`: module/service host lifecycle and wiring.
- `src/gateway/server.ts`: timeout, queue, and reverse-RPC compatibility behavior.
- `src/gateway/protocol.ts`: transport-neutral method contracts for voice stream evolution.
- `src/gateway/client.ts`: reverse-method handling and stream sequencing rules.
- `src/channels/api/voice-websocket-runtime.ts`: current canonical example of API-style voice turn -> SubstrateMessage -> EventBus mapping.
- `src/event-bus.ts`: typed lifecycle events that Wyoming runtime should reuse.
- `src/types.ts`: current `ChannelType` constraints and SubstrateMessage schema.

## 8) Consequences

- MVP implementation work can proceed without topology ambiguity.
- Voice PE integration remains HA-first and operator-friendly.
- Identity and telemetry behavior are defined before transport/service implementation, reducing risk of incompatible module designs across `PSFN-slsv.2` to `PSFN-slsv.5`.
