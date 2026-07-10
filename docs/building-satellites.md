# Building Satellites for the Hub

A satellite is any endpoint that connects to PSFN Satellite Hub and exposes a
real device, simulated device, or client surface to a PSFN-backed conversation.
Examples include a Pi voice endpoint, a browser text shell, a Device Studio
simulator, a Voxta/VaM avatar, a mobile browser, or a telemetry-only sidecar.

This guide covers the hub-facing realtime WebSocket path and the matching
PSFN framework registry contract. Stock ESPHome voice devices use the Python
ESPHome fallback path and do not need to implement the WebSocket protocol
directly, but they still use the same PSFN registry headers when the hub calls
PSFN.

## Integration Model

The hub sits between the satellite and PSFN:

```text
satellite endpoint
  -> realtime websocket hello/audio/text/control
  -> PSFN Satellite Hub
  -> PSFN chat runtime with registry-backed satellite headers
  <- assistant text/audio/control events
  <- satellite endpoint
```

The satellite proves what it can currently do to the hub through the `hello`
payload. The hub then advertises endpoint identity, current capabilities, and
configured telemetry to PSFN through scalar registry headers. PSFN intersects
those advertised values with `satellites.json`; the satellite must not assume
that advertising a capability grants permission.

There are two separate contracts:

| Boundary | Authority | What moves across it |
| --- | --- | --- |
| Satellite -> hub | The satellite's `hello` payload | Current local device capabilities for this connection |
| Hub -> PSFN framework | PSFN `satellites.json` plus hub `.env` | Registered endpoint identity, session/thread IDs, and registry-bounded capability advertisements |

The hub still sends the JSON `satellite_claim` body and
`X-PSFN-Satellite-Claim` header as diagnostics. The current PSFN framework
contract is the scalar header set documented below, not that JSON envelope.

## Choose an Endpoint Shape

Use the narrowest profile that matches the endpoint:

| Profile | Use for | Typical capabilities |
| --- | --- | --- |
| `voice-only` | Pi-class microphone/speaker endpoint | mic PCM, transcript, text, streamed audio, interrupt |
| `text-only` | CLI, browser shell, chat-only sidecar | text in, text/subtitle out, interrupt |
| `voxta-avatar` | VaM/Voxta avatar facade | text, local audio file playback, avatar actions/expressions |
| `vision-capable` | Image upload or camera endpoint | text plus image upload, text/subtitle output |
| `telemetry-only` | Health/presence/device-state sidecar | presence/control only, no chat input/output |
| `mobile-location` | Phone/tablet/browser endpoint | text, optional mic/speaker, optional image upload, configured location/timezone/battery telemetry |

Only advertise capabilities that are actually available at runtime. If a camera,
speaker, microphone, avatar action path, or telemetry source is unavailable,
omit or degrade that capability before sending `hello`.

## PSFN Framework Registry

The PSFN framework must have a matching `satellites.json` in its system data
directory. If the file is missing or disabled, satellite claims fail with
`satellite_registry_not_configured`.

Minimal voice endpoint:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "satellites": [
    {
      "satelliteId": "kitchen-pi",
      "displayName": "Kitchen Pi",
      "mobility": "static",
      "staticLocationLabel": "kitchen",
      "endpoints": [
        {
          "endpointId": "kitchen-pi-realtime",
          "displayName": "Kitchen Pi Realtime",
          "claimTypes": ["voice-only"],
          "promptChannelType": "voice_satellite",
          "auth": { "mode": "api_key" },
          "defaultIdentity": {
            "authorId": "primary-user",
            "authorName": "Primary User",
            "canonicalContactId": "contact-primary-user",
            "channelPrivacy": "private"
          },
          "maxCapabilities": [
            "text",
            "audio_input",
            "speech_to_text",
            "audio_output",
            "text_to_speech"
          ],
          "telemetryScopes": []
        }
      ]
    }
  ]
}
```

Android/Amica POC endpoint with speech, optional vision, and mobile telemetry:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "satellites": [
    {
      "satelliteId": "amica-android",
      "displayName": "Amica Android",
      "mobility": "mobile",
      "endpoints": [
        {
          "endpointId": "amica-android-app",
          "displayName": "Amica Android App",
          "claimTypes": ["mobile-location"],
          "promptChannelType": "mobile_satellite",
          "auth": { "mode": "api_key" },
          "defaultIdentity": {
            "authorId": "primary-user",
            "authorName": "Primary User",
            "canonicalContactId": "contact-primary-user",
            "channelPrivacy": "private"
          },
          "maxCapabilities": [
            "text",
            "audio_input",
            "speech_to_text",
            "audio_output",
            "text_to_speech",
            "vision",
            "image_upload",
            "avatar",
            "avatar_expression",
            "location",
            "timezone",
            "battery",
            "health",
            "telemetry"
          ],
          "telemetryScopes": [
            "location",
            "timezone",
            "battery",
            "health",
            "device",
            "status"
          ]
        }
      ]
    }
  ]
}
```

For local POC work, `auth.mode: "api_key"` is acceptable. For higher-trust
deployments, use `auth.mode: "mtls"` with a client certificate binding, and put
PSFN behind a trusted TLS edge that strips untrusted client certificate headers
before forwarding. The framework currently validates cert identity from trusted
forwarded headers plus API-key principal identity.

## Hub Configuration

The hub’s PSFN-facing identity is configured in `.env`. These values become the
registered identity and claim headers sent to PSFN:

```dotenv
AGENT_RUNTIME=psfn
DEVICE_TRANSPORT=realtime

PSFN_API_BASE_URL=https://psfn.example/v1
PSFN_MODEL=psfn
PSFN_API_KEY=

PSFN_CLAIM_NAMESPACE=satellite.endpoint
PSFN_CLAIM_TYPE=mobile-location
PSFN_CHANNEL_TYPE=satellite.endpoint
PSFN_CAPABILITY_PROFILE=mobile-location
PSFN_SATELLITE_ID=amica-android
PSFN_ENDPOINT_ID=amica-android-app
PSFN_ENDPOINT_NAME=Amica Android App
PSFN_ENDPOINT_CLASS=mobile
PSFN_LOCATION_MODE=mobile
PSFN_TELEMETRY_MODE=event
PSFN_TELEMETRY_CATEGORIES=location,timezone,battery,health

PSFN_CLIENT_CERT_PATH=
PSFN_CLIENT_KEY_PATH=
PSFN_CA_CERT_PATH=
```

For a speech-only Pi, use the same shape with `voice-only`, `kitchen-pi`, and
`kitchen-pi-realtime`. Keep `PSFN_CLAIM_TYPE`, `PSFN_CAPABILITY_PROFILE`,
`PSFN_SATELLITE_ID`, and `PSFN_ENDPOINT_ID` aligned with the PSFN
`satellites.json` entry.

For an Amica browser/avatar conduit, use a claim type registered for that
endpoint, for example `amica-conduit`, and keep the registry maximum wide enough
for the capabilities Amica advertises. Amica's default output capabilities
`text,subtitle,streamed_audio,animation,expression,gaze` map to Framework
capabilities `text`, `audio_output`, `text_to_speech`, `avatar`, and
`avatar_expression`. Add `vision` and `image_upload` only when Amica is
configured to advertise `vision_upload`.

For high-trust registered endpoints, configure `PSFN_CLIENT_CERT_PATH` and
`PSFN_CLIENT_KEY_PATH` so the hub presents client certificate identity to PSFN.
The satellite itself connects to the hub over the local hub transport; the hub
is the component that authenticates to PSFN.

## Hub To PSFN Headers

When the hub calls PSFN, it sends these registry-protocol headers:

```text
X-PSFN-Satellite-Claim-Type
X-PSFN-Satellite-ID
X-PSFN-Satellite-Endpoint-ID
X-PSFN-Satellite-Session-ID
X-PSFN-Satellite-Thread-ID
X-PSFN-Satellite-Capabilities
X-PSFN-Satellite-Telemetry-Scopes
X-PSFN-Client-Cert-Fingerprint-SHA256
```

`X-PSFN-Client-Cert-Fingerprint-SHA256` is only present when client certificate
config is available. `X-PSFN-Satellite-Capabilities` is the current satellite
capability set mapped to PSFN's canonical vocabulary. Empty telemetry categories
produce no telemetry scope header; PSFN treats omitted telemetry as no telemetry,
not as permission to use all registry scopes.

## WebSocket Connection

Connect to the hub:

```text
ws://<hub-host>:8787/
```

The first client message should be `hello`. Use stable IDs:

- `deviceId`: local device/client identifier
- `deviceName`: human-readable local device name
- `sessionId`: stable conversation thread id, such as `realtime:kitchen-pi`
- `satelliteId`: endpoint identity inside the hub session
- `satelliteName`: human-readable satellite name
- `channelId`: optional; if omitted, the hub derives `satellite.endpoint:<sessionId>`

Text-only example:

```json
{
  "type": "hello",
  "deviceId": "thin-shell",
  "deviceName": "Thin Shell",
  "sessionId": "thin-shell:demo",
  "satelliteId": "thin-shell",
  "satelliteName": "Thin Shell",
  "capabilities": {
    "input": ["text"],
    "output": ["text", "subtitle"],
    "control": ["interrupt", "session_attach"],
    "safety": []
  }
}
```

Voice endpoint example:

```json
{
  "type": "hello",
  "deviceId": "kitchen-pi",
  "deviceName": "Kitchen Pi",
  "sessionId": "realtime:kitchen-pi",
  "satelliteId": "kitchen-pi",
  "satelliteName": "Kitchen Pi",
  "capabilities": {
    "input": ["microphone_pcm", "final_transcript", "text", "wake_event"],
    "output": ["text", "subtitle", "streamed_audio"],
    "control": ["interrupt", "presence", "session_attach"],
    "safety": []
  }
}
```

Android/Amica speech-first example:

```json
{
  "type": "hello",
  "deviceId": "amica-android",
  "deviceName": "Amica Android",
  "sessionId": "mobile:weekend-walk",
  "satelliteId": "amica-android",
  "satelliteName": "Amica Android",
  "capabilities": {
    "input": ["microphone_pcm", "final_transcript", "text", "wake_event"],
    "output": ["text", "subtitle", "streamed_audio"],
    "control": ["interrupt", "presence", "session_attach"],
    "safety": ["confirmation_required"]
  }
}
```

Add `vision_upload` to `capabilities.input` only after the app and hub path can
actually upload images for the current turn. Do not advertise vision just
because the phone has a camera.

The hub replies with `hello.ack` containing the resolved session, channel, and
normalized capabilities. Treat that as the authoritative hub-side attachment for
the current connection.

## Sending User Input

For text-only satellites, send:

```json
{
  "type": "user.text",
  "text": "hello from my satellite",
  "interrupt": true
}
```

For voice satellites, use this turn flow:

```json
{ "type": "interrupt" }
{ "type": "turn.start", "interrupt": true }
{ "type": "audio", "audio": "<base64 pcm16 mono 16k chunk>" }
{ "type": "audio", "audio": "<base64 pcm16 mono 16k chunk>" }
{ "type": "turn.end", "reason": "vad_end" }
```

Audio chunks are raw PCM signed 16-bit little-endian mono at 16 kHz, base64
encoded. Keep chunks small enough for responsive interrupt behavior; the Pi
client uses continuous local capture and pushes frames as speech is detected.

## Receiving Assistant Output

Handle these hub messages:

| Message | Meaning |
| --- | --- |
| `session.ready` | Initial server-side default session before `hello` |
| `hello.ack` | Satellite attachment accepted and normalized |
| `message` with `role: "user"` | Final or live user transcript echoed by the hub |
| `message` with `role: "assistant"` and `live: true` | Assistant text delta |
| `message` with `role: "assistant"` and `final: true` | Final assistant text |
| `text` with `audio-init` | Hub is about to stream assistant audio |
| `audio` | Base64 assistant audio chunk |
| `text` with `audio-end` | Assistant audio stream finished |
| `assistant.interrupted` | Current assistant reply was interrupted |
| `error-event` | Hub-side protocol or runtime error |

If the satellite does not advertise `streamed_audio`, it should ignore audio
lifecycle events and render text/subtitles only.

## Satellite WebSocket Capability Vocabulary

Allowed capability values are defined in `src/ts/shared/protocol.ts`.

Input:

```text
text, microphone_pcm, final_transcript, vision_upload, wake_event
```

Output:

```text
text, subtitle, streamed_audio, local_file_audio, animation, action, expression, gaze, servo, artifact, tool_activity
```

Control:

```text
interrupt, mute, sleep_wake, presence, session_attach, approvals
```

`artifact`, `tool_activity`, and `approvals` opt a satellite into the companion
relay messages described in `docs/realtime-client-protocol.md`. Satellites that
do not advertise them receive none of those events, and `approval.decision`
from a satellite without `approvals` is rejected.

Safety:

```text
action_allowlist, confirmation_required, local_only
```

Prefer smaller capability sets. For example, a Device Studio simulator should
not advertise `vision_upload`, `action`, `servo`, or `streamed_audio` unless the
corresponding path is implemented and working.

## PSFN Capability Mapping

The hub maps WebSocket capabilities into PSFN framework capabilities before
sending the registry headers:

| Hub capability | PSFN capability |
| --- | --- |
| `input: text` or `output: text/subtitle` | `text` |
| `input: microphone_pcm` or `wake_event` | `audio_input` |
| `input: final_transcript` | `speech_to_text` |
| `output: streamed_audio` or `local_file_audio` | `audio_output`, `text_to_speech` |
| `input: vision_upload` | `vision`, `image_upload` |
| `output: animation`, `expression`, `action`, or `gaze` | `avatar` |
| `output: expression` | `avatar_expression` |
| `output: action` | `avatar_action` |

Presence is currently a telemetry/control signal, not a framework capability
grant. Do not rely on `control: presence` to grant `presence` as a PSFN
capability.

## Telemetry

Telemetry is currently advertised through hub configuration and PSFN registry
headers, not through a separate satellite WebSocket message. Do not invent custom
telemetry frames until the shared protocol defines them.

Supported telemetry categories for the claim envelope are:

```text
location, timezone, room, presence, battery, health, device_status, avatar_state
```

Mapping to PSFN framework telemetry scopes:

| Hub telemetry category | PSFN telemetry scope |
| --- | --- |
| `location` | `location` |
| `timezone` | `timezone` |
| `presence` | `presence` |
| `battery` | `battery` |
| `health` | `health` |
| `device_status` | `device`, `status` |
| `avatar_state` | `status` |
| `room` | no framework scope yet |

Use `PSFN_TELEMETRY_MODE=disabled` by default. Enable telemetry only for
endpoints that are configured to provide it and whose registry entry permits it.

## Amica Alignment Checklist

Use this checklist when wiring the Amica prototype or another companion client
through the hub:

- Pick stable IDs first: `PSFN_SATELLITE_ID`, `PSFN_ENDPOINT_ID`, and WebSocket `sessionId`.
- Add the matching PSFN `satellites.json` registry entry before testing the app.
- Configure the hub `.env` to match the registry claim type, satellite ID, and endpoint ID exactly.
- Start with speech only: microphone PCM or local STT transcript in, streamed audio/text out.
- Advertise `vision_upload` only after the app has a real image upload path through the hub.
- Keep PSFN secrets and client cert paths in hub `.env`, never in the Android app.
- Treat hub `hello.ack` as the accepted connection state and surface `error-event` visibly in the app.
- Verify that PSFN sees source `satellite`, channel ID `satellite:<claimType>:<sessionId>`, and the expected effective capabilities.

## Minimal JavaScript Satellite

This is the smallest text-only satellite shape:

```js
import WebSocket from "ws";

const socket = new WebSocket(process.env.HUB_WS_URL || "ws://127.0.0.1:8787/");

socket.on("open", () => {
  socket.send(JSON.stringify({
    type: "hello",
    deviceId: "my-shell",
    deviceName: "My Shell",
    sessionId: "text:my-shell",
    satelliteId: "my-shell",
    satelliteName: "My Shell",
    capabilities: {
      input: ["text"],
      output: ["text", "subtitle"],
      control: ["interrupt", "session_attach"],
      safety: []
    }
  }));
});

socket.on("message", (raw) => {
  const message = JSON.parse(String(raw));
  if (message.type === "hello.ack") {
    socket.send(JSON.stringify({
      type: "user.text",
      text: "hello from my shell",
      interrupt: true
    }));
    return;
  }
  if (message.type === "message" && message.data?.role === "assistant") {
    process.stdout.write(message.data.content);
    if (message.data.final) {
      process.stdout.write("\n");
      socket.close();
    }
  }
  if (message.type === "error-event") {
    console.error(message.data.message);
    socket.close();
  }
});
```

The checked-in version of this pattern is `scripts/psfn-thin-shell.mjs`.

## Validation

Start the TypeScript hub:

```bash
DEVICE_TRANSPORT=realtime npm run hub:ts
```

Run the built-in thin shell:

```bash
npm run shell:psfn -- "hello from a satellite"
```

Run protocol tests after changing the protocol, hub, or satellite examples:

```bash
npm run test:ts
uv run python -m pytest
```

If your shell resolves `pytest` outside this repo, use the project interpreter
form above. It avoids user-level `pytest` binaries shadowing the virtualenv.

## Readiness Criteria

Before treating a satellite as production-ready, verify:

- it sends `hello` before user/audio frames
- IDs are stable across reconnects when conversation continuity is desired
- capability claims are accurate for the current runtime state
- local playback stops immediately after `interrupt`
- text-only satellites do not advertise audio capabilities
- audio satellites send PCM16 mono 16 kHz chunks
- reconnect logic backs off and resends `hello`
- `error-event` is surfaced in local logs
- secrets, certs, and PSFN API keys stay in hub config, not satellite logs

## Extending the Protocol

Add a new message only when existing messages cannot represent the behavior.
When adding one:

- update `src/ts/shared/protocol.ts`
- document it in `docs/realtime-client-protocol.md`
- capability-gate it in the `hello` payload
- add focused tests for parsing and hub behavior
- keep unknown messages non-fatal where possible so older satellites can coexist
