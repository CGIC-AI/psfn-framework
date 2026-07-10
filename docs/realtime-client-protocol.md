# Realtime Client Protocol

The custom Pi-class client talks to the hub over one persistent websocket.

This path exists for devices that can do smooth local playback interruption and continuous conversational control. Stock ESPHome and `linux-voice-assistant` remain supported through the fallback ESPHome transport.

## Why It Exists

The realtime client path is meant for devices that can:

- keep microphone capture local and continuous
- interrupt playback immediately on first user speech
- flush local playback buffers without waiting on ESPHome-style turn transitions
- keep a natural back-and-forth conversation over one persistent connection

## Connection

Default websocket endpoint:

```text
ws://<hub-host>:8787/
```

Set `DEVICE_TRANSPORT=realtime` to run only this path, or `DEVICE_TRANSPORT=hybrid` to run it beside the ESPHome fallback.

## Client To Hub

All client messages are JSON text frames.

`hello`

```json
{
  "type": "hello",
  "deviceId": "pi-zero-2w-kitchen",
  "deviceName": "Kitchen Pi",
  "sessionId": "optional-stable-thread-id",
  "channelId": "optional-explicit-psfn-channel-id",
  "satelliteId": "pi-zero-2w-kitchen",
  "satelliteName": "Kitchen Pi",
  "capabilities": {
    "input": ["microphone_pcm", "final_transcript", "text", "wake_event"],
    "output": ["text", "subtitle", "streamed_audio"],
    "control": ["interrupt", "presence", "session_attach"],
    "safety": []
  }
}
```

`channelId` is optional. If omitted, the hub derives a stable PSFN channel id
as `<PSFN_CHANNEL_TYPE>:<sessionId>`, defaulting to
`satellite.endpoint:<sessionId>`. Endpoint identity and current capabilities are
advertised to PSFN separately through the satellite claim envelope.

`user.text`

```json
{
  "type": "user.text",
  "text": "Typed shell input",
  "interrupt": true
}
```

`turn.start`

```json
{
  "type": "turn.start",
  "wake_word_phrase": "Hey Hermes"
}
```

`audio`

```json
{
  "type": "audio",
  "audio": "<base64 pcm16 mono 16k>"
}
```

`turn.end`

```json
{
  "type": "turn.end",
  "reason": "vad_end"
}
```

`interrupt`

```json
{
  "type": "interrupt"
}
```

`session.reset`

```json
{
  "type": "session.reset"
}
```

## Hub To Client

All hub messages are JSON text frames.

Setup and turn lifecycle:

- `session.ready`
- `hello.ack`
- `message` with final user text for typed or transcribed input
- `turn.started`
- `transcript.final`
- `turn.no_input`

Assistant lifecycle:

- `message` with live assistant text deltas
- `message` with final assistant text
- `text` with `audio-init` / `audio-end` for audio-capable satellites
- `audio` with base64 audio chunks for audio-capable satellites
- `assistant.interrupted`

Errors:

- `error-event`

## Device Studio Embodiment MVP

Device Studio does not need a new hub protocol message for the MVP. It connects
as a simulated satellite with the normal `hello` payload, advertises the device
capabilities it can preview, and drives local embodiment state from existing hub
events:

- `message` updates user and assistant subtitles.
- `text` with `audio-init` / `audio-end` opens and closes local speaking state.
- `audio` chunks can drive local viseme estimation when streamed audio is used.
- `assistant.interrupted` and `action: interrupt` stop local behavior playback.
- `user.text`, `turn.start`, `audio`, `turn.end`, and `interrupt` cover the
  outbound user and lifecycle path.

This keeps the production hub and existing Pi-class clients unchanged. Studio
behavior selection, expression, viseme, servo preview, LEDs, and display state
remain local simulator state unless a later server-driven embodiment feature
needs to cross the websocket boundary.

If that later feature is added, it should use explicit optional messages instead
of JSON encoded inside `message.data.content` or `text.data`. Those messages
must be capability-gated through `hello`, versioned, typed in
`src/ts/shared/protocol.ts`, documented here, and covered by focused protocol
tests.

## Companion Approvals, Artifacts, And Tool Activity

The hub can bridge a PSFN companion backplane (`PSFN_COMPANION_BASE_URL`) into
the realtime websocket path. The backplane endpoints live on the same gateway
API edge as `/v1/chat/completions`, so the base URL is typically the same
`<gateway>/v1` value as `PSFN_API_BASE_URL`. PSFN owns approvals, artifacts,
and tool events; the hub only relays the redacted payloads PSFN emits and
proxies decisions and preview reads back. If the backplane is unconfigured or
unreachable, the hub relays nothing and rejects the client requests below —
there is no fake or cached data.

Backplane access is deny-by-default at the satellite registry. The hub
authenticates with `Authorization: Bearer <key>`; the key's principal must be
listed on the hub's endpoint entry in PSFN's `satellites.json` and granted the
`approvals`, `artifacts`, and `tool_activity` telemetry scopes. Both backplane
`GET` endpoints additionally require the hub's registry identity as query
parameters (`satelliteId`, `endpointId`, `claimType`), which the hub takes
from its existing `PSFN_SATELLITE_ID` / `PSFN_ENDPOINT_ID` /
`PSFN_CLAIM_TYPE`-or-`PSFN_CAPABILITY_PROFILE` configuration; PSFN answers
`401` for a bad bearer and `403` for an unknown endpoint/principal or a
missing scope. An incomplete identity disables the bridge at startup — fail
closed.

All of these message families are capability-gated through `hello`:

- `approval.requested` / `approval.resolved` and the `approval.decision`
  request require the `approvals` control capability.
- `artifact.created`, `artifact.preview`, `artifact.preview.result`, and
  `artifact.preview.error` require the `artifact` output capability.
- `tool.activity` requires the `tool_activity` output capability.

A satellite that did not advertise the matching capability receives none of
the hub-to-client events, and its `approval.decision` is rejected with an
`error-event`.

### Hub To Client

`approval.requested`

```json
{
  "type": "approval.requested",
  "data": {
    "id": "appr-123",
    "title": "Send outbound message",
    "requestedAt": "2026-07-09T00:00:00Z",
    "expiresAt": "2026-07-09T00:05:00Z",
    "redactedContext": "Short redacted summary",
    "status": "pending"
  }
}
```

`expiresAt` is optional. `redactedContext` is PSFN's already-redacted summary;
the hub never adds transcript or raw payload content.

`approval.resolved`

```json
{
  "type": "approval.resolved",
  "data": {
    "id": "appr-123",
    "status": "approved",
    "resolvedAt": "2026-07-09T00:00:03Z"
  }
}
```

`status` is one of `approved`, `denied`, `expired`, or `blocked`. PSFN maps
its internal queue outcomes into this enum upstream (a `failed` stream arrives
as `blocked`, a `modified` stream as `approved`); the hub relays whatever
status PSFN emits. Resolution is broadcast to every approvals-capable
satellite, including after a decision the same satellite submitted.

`artifact.created`

```json
{
  "type": "artifact.created",
  "data": {
    "id": "art-456",
    "label": "Generated sketch",
    "mediaType": "image/png",
    "provenance": "image_generation",
    "createdAt": "2026-07-09T00:00:01Z",
    "previewable": true
  }
}
```

`artifact.preview.result`

```json
{
  "type": "artifact.preview.result",
  "requestId": "req-1",
  "artifactId": "art-456",
  "mediaType": "image/png",
  "data": "<base64, size-capped>"
}
```

`artifact.preview.error`

```json
{
  "type": "artifact.preview.error",
  "requestId": "req-1",
  "artifactId": "art-456",
  "message": "Companion artifact preview failed (403): ..."
}
```

Preview responses are size-capped (`PSFN_COMPANION_PREVIEW_MAX_BYTES`,
default 1 MiB) and deny-by-default: PSFN decides per artifact whether preview
bytes are released, and any denial, missing artifact, or over-cap response
becomes `artifact.preview.error` for the requesting satellite only.

`tool.activity`

```json
{
  "type": "tool.activity",
  "data": {
    "id": "act-789",
    "tool": "web_search",
    "phase": "completed",
    "detail": "3 results",
    "timestamp": "2026-07-09T00:00:02Z"
  }
}
```

`phase` is one of `started`, `progress`, `completed`, or `failed`. `detail` is
optional and already redacted by PSFN.

### Client To Hub

`approval.decision`

```json
{
  "type": "approval.decision",
  "id": "appr-123",
  "decision": "approve"
}
```

The hub forwards the decision to PSFN with the submitting satellite and device
identity attached. Success (`200` with `{id, status}`) produces no direct
reply; the authoritative `approval.resolved` event follows over the relay.
Failures come back as `error-event` to the submitting satellite only. The hub
classifies failures by HTTP status code, not body shape: `401`/`403` for
auth/scope problems, `404` for an unknown approval, and `409` for an
already-resolved or expired approval, where PSFN returns its standard API
error envelope with `details.{id, status}`.

`artifact.preview`

```json
{
  "type": "artifact.preview",
  "requestId": "req-1",
  "artifactId": "art-456"
}
```

The result or error is sent only to the requesting satellite.

## Streaming Model

The intended client behavior is:

1. keep local mic capture active
2. detect user speech locally
3. cut local playback immediately
4. send `interrupt`
5. send `turn.start`
6. keep streaming `audio` frames without waiting for a wake beep or transport reopen
7. send `turn.end` when local VAD decides the utterance is complete

That is the top-tier conversational path. The ESPHome path remains available for stock devices that cannot do this.
