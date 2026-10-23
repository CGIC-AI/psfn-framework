# PSFN Satellite Hub

The same-origin Companion PWA browser bridge is described in
[Companion browser transport](docs/companion-browser.md), including explicit
gateway/Hub wiring, enrollment, renewed assertions, PCM input, and spoken replies.

Voice and embodiment hub for PSFN.

This application is the middleware layer between endpoint hardware, embodiment clients,
and PSFN Framework. It currently has three integration paths:

- a custom TypeScript realtime websocket path for Pi-class devices that can do smooth bidirectional conversation
- a Voxta-compatible SignalR facade for VaM / AcidBubbles-style plugin clients
- an ESPHome Native API fallback path for stock ESPHome voice devices and `linux-voice-assistant`

PSFN Framework is the sole agent backend. Treat this repo as the transport and
embodiment bridge into that runtime, not as a scoped local brain.

## What This Repo Does

The hub under `apps/satellite-hub` does the heavy lifting:

- accepts a custom realtime voice client, a Voxta/VaM client, or an ESPHome voice device
- streams microphone audio to Deepgram STT
- applies turn endpointing, interrupt, and timeout logic
- sends the current recognized text plus a stable conversation id into PSFN Framework
- streams runtime text back into ElevenLabs TTS
- returns assistant audio either as websocket chunks or ESPHome playback media
- exposes Voxta-compatible chat lifecycle and reply events for VaM embodiment
- stores turn artifacts, transcripts, and reply metadata locally

On the TypeScript paths, PSFN Framework owns the actual conversation/session
state. The hub keeps satellite/runtime transport state and relays the current
turn.

Device behavior depends on the path:

- custom realtime client:
  local mic capture, local playback ownership, explicit interrupt, persistent websocket
- Voxta/VaM facade:
  SignalR-compatible chat route, text turns, chat lifecycle events, allowlisted app triggers
- ESPHome fallback:
  wake word or button start, mic capture, speaker playback, ESPHome voice-assistant transport

No Home Assistant is in the runtime path.

## Current Architecture

```text
Pi-class realtime client
  -> continuous pcm audio over one websocket
  -> hub-side persistent Deepgram live session
  -> PSFN conversation runtime
  -> ElevenLabs streaming TTS
  <- audio-init / audio-end / audio chunks
  <- explicit interrupt-event / bot-speak-end handshake

ESPHome device / linux-voice-assistant / ESP32 fallback
  -> ESPHome Native API session in the Python hub
  -> Deepgram live STT websocket
  -> PSFN conversation runtime
  -> ElevenLabs streaming TTS websocket
  <- announcement/media playback over the ESPHome route

VaM / Voxta-compatible plugin
  -> SignalR JSON /hub route
  -> Voxta SendMessage framing
  -> PSFN Framework conversation runtime
  <- Voxta ReceiveMessage chat lifecycle and streamed reply events
  <- allowlisted appTrigger/action events
```

## Current Status

Implemented:

- TypeScript websocket hub for Pi-class clients
- TypeScript Pi client with continuous mic streaming, local playback ownership, and explicit interrupt
- explicit ALSA device routing and local playback ducking on Pi-class hardware
- persistent Deepgram websocket for STT on both paths
- persistent ElevenLabs websocket for streamed TTS on both paths
- PSFN-compatible conversation runtime driven from PSFN config/env
- reference-style handshake on the TS path:
  `audio-init`, `audio-end`, `bot-speaking`, `bot-speak-end`, `interrupt-event`
- server-side utterance boundaries on the TS path driven by Deepgram live results instead of client-side turn gating
- ESPHome fallback transport kept intact on the Python side
- Voxta-compatible SignalR facade on the TypeScript hub:
  `/hub/negotiate`, websocket `/hub`, `SendMessage` inbound, `ReceiveMessage` outbound
- Voxta chat lifecycle framing for authenticate, register app, chat list/start/resume/subscribe, send, interrupt, and allowlisted trigger actions
- `hub probe` for metadata, entities, services, and state subscription
- `hub transport-spike` for raw ESPHome transport capture and artifact logging
- local artifact capture under `.artifacts/runtime/` and `.artifacts/runtime-ts/`

Currently working:

- the TypeScript smoke harness succeeds end-to-end against the rebuilt realtime hub
- the Pi 5 client path is the primary path to extend first
- the Voxta facade has protocol-level test coverage, but still needs validation against the real AcidBubbles plugin
- the ESPHome/Python path remains available as the fallback for stock devices

Current intent:

- make the voice loop feel fast and smooth enough for daily use
- target the direct PSFN deployment first so the end-to-end path is real
- let VaM/Voxta act as an embodied satellite, not as a separate agent runtime
- keep the bridge thin so this can stay a sidecar first
- upstream only the smallest useful bridge seam later if it proves out

## Why The Hub Exists

PSFN is not talking directly to the satellite.

This repo is the orchestration layer that translates:

- custom realtime voice transport
- ESPHome voice transport
- realtime STT/TTS provider streams
- PSFN conversation execution

That split is deliberate. It keeps ESPHome transport concerns out of PSFN core until the interface is proven stable, while still letting the bridge use a direct PSFN deployment as the source of truth.

For the TypeScript realtime path, that means the hub should stay a transport/orchestration layer:

- satellite audio in
- turn control and interrupt handling
- current-turn text into PSFN
- streamed text/audio back out

Conversation memory and session continuity belong to PSFN, with the hub only maintaining transport-side continuity.

## Commands

From the monorepo root, the bounded check is:

```bash
npm run verify:satellite-hub
```

It runs TypeScript and Python checks without contacting live devices or paid
providers. Firmware preparation/compilation, physical-hardware validation,
live-device deployment, provider-backed voice/image calls, and the optional
.NET relay are separate operator actions. Pinned convenience tasks are exposed
as `mise run hub:firmware`, `mise run hub:firmware:compile`, and
`mise run hub:dotnet`; none is part of the default gate.

Install Python dependencies for the ESPHome fallback path:

```bash
uv sync --dev
```

ESPHome speaker endpoints that advertise FLAC-only playback, including the
Waveshare bedroom build, also require `ffmpeg` on the bridge host. On Debian or
Raspberry Pi OS:

```bash
sudo apt-get update && sudo apt-get install -y ffmpeg
```

Install TypeScript dependencies for the realtime hub/client path:

The TypeScript hub standard is Node.js 24 LTS (24.22.1 or newer 24.x) with npm
11.17.0, also recorded in `.node-version` and `package.json`.

```bash
npm ci
```

Show Python fallback CLI help:

```bash
uv run hub --help
```

Probe a device:

```bash
uv run hub probe --host <device-ip> --noise-psk <base64-psk>
```

Capture raw voice transport artifacts:

```bash
uv run hub transport-spike --host <device-ip> --noise-psk <base64-psk>
```

Bootstrap against the PSFN bridge config and run the Python fallback bridge:

```bash
uv run hub run
```

Run the TypeScript realtime hub:

```bash
npm run hub:ts
```

Point a Voxta-compatible VaM plugin at the same TypeScript hub:

```text
http://<hub-host>:8787
```

The facade exposes `POST /hub/negotiate?negotiateVersion=1` and
`WS /hub?id=<connectionToken>` using SignalR JSON framing.

Run the TypeScript Pi client locally:

```bash
npm run pi:ts
```

Run the TypeScript smoke test against the realtime hub:

```bash
npm run smoke:ts
```

Run the browser Device Studio scaffold locally:

```bash
npm run studio:dev
```

Serve Device Studio on the LAN for a phone, tablet, or hardware bench machine:

```bash
DEVICE_STUDIO_HOST=0.0.0.0 npm run studio:dev
```

Device Studio supports mock and live hub transport, behavior import/export,
server-side sprite generation through `FAL_KEY`, manual sprite packing, and
hardware verification labels. See [docs/device-studio.md](docs/device-studio.md)
for the operator workflow and verification checklist.

To build a new hub-facing endpoint, see
[docs/building-satellites.md](docs/building-satellites.md).

Send a typed turn through the PSFN channel seam with the text-only thin shell:

```bash
npm run shell:psfn -- "hello from the thin shell"
```

Apply the current `linux-voice-assistant` fork patch used for ESPHome fallback interrupt/follow-up behavior:

```bash
./scripts/apply-linux-voice-assistant-patch.sh /path/to/linux-voice-assistant
```

Deploy the dedicated TypeScript Pi realtime client and disable `linux-voice-assistant` on that Pi:

```bash
PI_USER=<pi-user> PI_PASSWORD='<pi-password>' HUB_WS_URL=ws://<hub-host>:8787/ DEVICE_ID=<device-id> DEVICE_NAME=<device-name> ./scripts/deploy-ts-pi-client.sh <pi-host>
```

## Configuration

Runtime config comes from the project-local `.env`.

The Python audio listener now requires explicit local development or a trusted
HTTPS/auth relay. See [Python listener, resource, and artifact security](docs/python-security.md)
for migration, exact admission rules, defaults, and retention.

Python realtime output has one per-socket budget shared by application frames,
automatic pong replies, explicit ping/pong, fragments, and close frames. The
production defaults are 8,192 retained frames, 1,048,576 bytes, and a five-second
absolute completion deadline. Admission occurs before serialization with a
conservative 14-byte charge per frame; the native asyncio transport buffer and
pending protocol output share that byte ceiling. HTTP handshake writes also
pass the byte boundary. Compression stays disabled. The gate uses the pinned
websockets 15.0.1 `send_frame` boundary, including its synchronous automatic
control replies; `write_limit` and `drain` provide flow control only.

Charges release when pending protocol output and the native transport buffer
both empty. Partial drain and new frames never extend an outstanding deadline.
Overflow, expiry, or write failure aborts TCP and clears pending output; close
frames have no extra capacity reserve. The connection slot stays charged until
terminal TCP cleanup. Failed output owners reject parsed and already queued
application input before it can finalize a buffered audio turn. A single timer handle checks retained output every 10 ms
and is canceled on cleanup; no output watcher task is created. Library tests can
inject smaller `RealtimeOutputLimits` through `RealtimeVoiceServer.output_limits`.
The cap measures process-owned serialized output and conservative frame charges;
kernel TCP buffers and provider/application source objects have their own limits.
Local socket regressions cover unread peers with reduced TCP buffers, exact and
one-over admission, a legal 125-byte ping flood, control competition, deadlines,
cancellation, shutdown, and fresh authenticated recovery. Live load validation
remains pending.

Important settings for the TypeScript realtime path:

- `HUB_WS_URL`
- `AUDIO_DEVICE_CARD`
- `AUDIO_INPUT_DEVICE`
- `AUDIO_OUTPUT_DEVICE`
- `ALSA_DUCK_CARD`
- `ALSA_DUCK_CONTROL`
- `ALSA_DUCK_PERCENT`
- `VOICE_START_THRESHOLD`
- `VOICE_CONTINUE_THRESHOLD`
- `VOICE_AMBIENT_START_RATIO`
- `VOICE_INTERRUPT_RATIO`

Important settings for the Python ESPHome fallback path:

- `DEVICE_TRANSPORT`
- `ESPHOME_HOST`, `ESPHOME_PORT`, `ESPHOME_NOISE_PSK`
- `REALTIME_VOICE_BIND_HOST`, `REALTIME_VOICE_PORT`, `REALTIME_VOICE_PUBLIC_HOST`
- `DEEPGRAM_API_KEY`
- `ELEVENLABS_API_KEY`
- `PSFN_API_BASE_URL`
- `PSFN_API_KEY`
- `PSFN_PROVIDER` optionally selects an explicit provider while retaining PSFN's full companion prompt pipeline
- `PSFN_MODEL`; with `PSFN_PROVIDER` set, this may be a configured provider alias such as `z-ai-glm-5.2-nitro`
- `PSFN_CLAIM_NAMESPACE` and `PSFN_CLAIM_TYPE` for the registry claim namespace/type, defaulting to `satellite.endpoint` and the selected capability profile
- `PSFN_CAPABILITY_PROFILE` for the current endpoint class: `voice-only`, `text-only`, `voxta-avatar`, `world-avatar`, `vision-capable`, `telemetry-only`, or `mobile-location`; `world-avatar` is the distinct 3D-world claim profile and does not enable the Voxta SignalR facade
- `PSFN_SATELLITE_ID`, `PSFN_ENDPOINT_ID`, and `PSFN_ENDPOINT_NAME` for the configured endpoint identity
- `VOICE_CONVERSATION_ID` pins every ESPHome turn to one PSFN channel suffix; defaults to `PSFN_SATELLITE_ID` and overrides device-provided conversation ids
- `PSFN_CHANNEL_TYPE` for the compatibility channel header, defaulting to the claim namespace instead of an authoritative endpoint type
- `PSFN_CLIENT_CERT_PATH`, `PSFN_CLIENT_KEY_PATH`, and optional `PSFN_CA_CERT_PATH` for PSFN client certificate identity
- `HUB_DEVICE_REGISTRY_PATH` enables enrolled device authority. Every device entry must declare `enrollmentVersion`, `enrollmentAssurance: "device_credential"`, `enrollmentStatus`, `companionId`, and optional server-owned `placeId`. The file is reread for new hellos, active-session messages, and Framework attempts; deletion, revocation, version drift, malformed state, or assertion-binding drift fences traffic until a current hello succeeds
- `HUB_LOCATION_CONFIG_PATH` optionally loads Hub-owned phone geofence zones; see `config/location-zones.example.json`. It requires enrolled device authority. A phone must request and be granted `device_location` in `maxCapabilities.input`. Raw samples are handled only by the Hub: stable zone transitions bind/unbind the device assertion place, a departure contributes only a coarse `Out, near <label>.` context note, and only typed `left`/`arrived` transitions cross the companion bridge. This is foreground message handling, not background tracking or Home Assistant synchronization
- `EIDOVERSE_PLACE_MAP_PATH` optionally loads a Hub-owned static world/region-to-place table; see `config/eidoverse-place-map.example.json`. Every world has a default `placeId` and may have exact-match region overrides. The mapping resolver retains the world default and produces a context note for an unmapped region; an unmapped world resolves with no `placeId`. All mapped IDs must match the canonical `places.json` place-ID pattern. This mapping is read-only and never creates or changes entries in `places.json`
- `EIDOVERSE_MCP_*` enables the Hub-owned visitor connection for `look`, `say`, and `pending_pings`. After a completed addressed turn, the Hub trims the companion's assistant reply, skips an empty result, and sends the first 4000 string units through MCP `say` exactly once; the full reply remains in the completed PSFN session. A `say` failure is logged without response text or credentials and is not retried. This embodiment path does not fan the utterance out to Discord or Telegram and does not create channel bonding
- `EIDOVERSE_MCP_TRANSPORT` selects how the Hub reaches the world and defaults to `poll`, the Phase 1 stdio MCP door. `mcpl` dials the world's MCPL door over WebSocket (`EIDOVERSE_MCPL_DOOR_URL`, credential-free; the identity token is attached at dial time from `EIDOVERSE_MCP_TOKEN_REF`) and knocks then arrive as pushed `channels/incoming` traffic, so no poll timer exists. The Hub is a bidirectional peer on that socket: it answers the door's `channels/register` and the `channels/changed` PREPARE question inside the door's five-second budget, while a tool call it issued is still pending. `EIDOVERSE_MCPL_FEATURE_SETS_JSON` is the grant the Hub issues — advertisement is not authorization, the capability allowlist is derived from that selection, and `eidoverse.typing` is excluded so refusing the typing relay cannot take world presence with it. `EIDOVERSE_MCPL_CATCHUP_WAKE` decides whether mentions the door replays after a reconnect may start turns and defaults to `false`; the replay still reaches the transcript, only the wake is withheld. The door confirms each transition with the notification form of `channels/changed`, which retires the channel the body left instead of tracking it for the life of the connection. `EIDOVERSE_MCPL_WAKE_QUEUE_LIMIT` (default 4) bounds the wake-dispatch queue: turns are serialized and pushed delivery has none of the poll timer's natural backpressure, so past that many waiting batches an arriving batch is dropped and counted, and the one line per overflow episode carries batch and message counts only — never a ping line or a world name
- The companion moves its own body without any device: the gateway calls the Hub control port (`POST /internal/v1/world/perceive`, `/move`, `/act`, control token only) on behalf of the `world` tool's `move` / `perceive` / `act` actions, so a one-person deployment with no device registry, no fleet auth and no SSO can walk, look around, travel and act in the Eidoverse. `HUB_CONTROL_*` may be set without `HOME_ASSISTANT_ENABLED`. See `docs/eidoverse-hub-integration.md`
- `world.travel` and `world.body` are the device-facing commands on the satellite socket, for an external device driving the avatar. Both require enrolled device authority plus their own control capability (`world_travel`, `world_body`) in the device's server-owned `maxCapabilities`, so a browser client cannot grant itself either. `world.travel` re-resolves the place map for the destination before it touches the wire — an unmapped world is refused where the body still is, and no `placeId` is invented — and on arrival every later turn carries the new `placeId` and an arrival note. `world.body` submits one allowlisted locomotion action to the body runner and answers with submission, never completion. Both answer in the Hub's own refusal vocabulary; the door's prose never reaches a satellite
- `EIDOVERSE_BODY_*` bounds the Hub-owned body runner. The allowlist is `walk_to`, `face`, `stop`, `emote`, `posture`, `whisper`, `spawn`, `remove`, `set_avatar`; the runtime parser rejects every other verb, so raw `world_verb`, `place`, moderation and terrain editing stay unreachable, and the runner exists only for a claim profile granting `avatar_action`. Which of these a companion may call is the framework's capability tier (`world.read` for locomotion and expression, `world.control` for `spawn`/`remove`/`set_avatar`). A device-submitted walk is fire-and-forget and reports a content-free `eidoverse.body` note on a later turn; the companion's own `move` waits a bounded time and is told whether it arrived, with the coordinates. `EIDOVERSE_BODY_WALK_TIMEOUT_MS` stays above the door's ~90s walk timeout; `EIDOVERSE_BODY_MAX_PENDING_NOTES` bounds the undrained outcome buffer
- `EIDOVERSE_SNAPSHOT_*` enables optional first-person vision over the world's own `GET /snap` surface, which needs a live spectator renderer attached to that world. It is off unless `EIDOVERSE_SNAPSHOT_ENABLED=true` and the claim profile grants vision, and it works on either transport. The base URL is derived from the active transport's own URL unless `EIDOVERSE_SNAPSHOT_BASE_URL` names a credential-free http/https origin: from `EIDOVERSE_MCP_WORLD_URL` under `poll` (scheme swapped, `/ws` and query dropped), and from `EIDOVERSE_MCPL_DOOR_URL` under `mcpl` (same host and port, `ws`->`http` scheme swap, the conventional `/mcpl` door path dropped, query dropped). The MCPL derivation only holds when the renderer answers on the door's own host and port; a door behind a path-routed gateway, a renderer on another host, or any door path that is not `/mcpl` is refused rather than guessed at, and the hub then fails at boot naming `EIDOVERSE_SNAPSHOT_BASE_URL` instead of running with vision that reaches nothing. No derivation can carry the identity token: the poll world URL's query is dropped, and the MCPL door URL is credential-free by construction because the token is attached at dial time. A frame lands on the same `visionCaptures`/`visionCaptureImages` seam Voxta uses, so the session transcript still receives text only. An absent renderer (503), an absent identity (404), a renderer timeout (504), a non-PNG body, a payload past `EIDOVERSE_SNAPSHOT_MAX_BYTES`, or an unreachable host each degrade to the text `look()` notes with one sanitized warning and no crash
- enrolled device authority requires all of `HUB_DEVICE_ASSERTION_ISSUER`, `HUB_DEVICE_ASSERTION_KID`, `HUB_DEVICE_ASSERTION_AUDIENCE`, `HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH`, and `HUB_DEVICE_ASSERTION_TTL_SECONDS`; the private-key file must be mode `0600` (or stricter), the key must be Ed25519, and TTL must be 5–60 seconds
- `PSFN_TELEMETRY_MODE` and `PSFN_TELEMETRY_CATEGORIES` for configured telemetry advertisement
- `PSFN_COMPANION_BASE_URL` enables the companion backplane bridge (typed touch and location-transition stimuli, approvals, artifact events, tool activity, and redacted emotion snapshot relay) on the TS realtime path; the endpoints live on the same gateway API edge as `/v1/chat/completions`, so this is typically the same `<gateway>/v1` value as `PSFN_API_BASE_URL`; unset disables the bridge and the hub relays nothing
- `PSFN_COMPANION_API_KEY` for companion backplane bearer auth, defaulting to `PSFN_API_KEY`; the key's principal must be listed on the hub's endpoint entry in PSFN's `satellites.json` and granted the `approvals`, `artifacts`, `tool_activity`, and `emotion` telemetry scopes
- touch submission additionally requires `touch` in that PSFN endpoint's `maxCapabilities`; authenticated browser devices must also have `touch` in the Hub device registry's `maxCapabilities.control`
- location-transition submission additionally requires `location` in that PSFN endpoint's `maxCapabilities`; raw coordinates are never accepted by the PSFN boundary
- the companion bridge identifies itself on `GET` requests with `satelliteId`/`endpointId`/`claimType` query params taken from the existing `PSFN_SATELLITE_ID`, `PSFN_ENDPOINT_ID`, and `PSFN_CLAIM_TYPE`/`PSFN_CAPABILITY_PROFILE` registry identity; an incomplete identity fails closed at startup
- `PSFN_COMPANION_PREVIEW_MAX_BYTES` caps artifact preview payloads relayed to satellites, defaulting to 1048576
- `PSFN_COMPANION_RECONNECT_BASE_MS` and `PSFN_COMPANION_RECONNECT_MAX_MS` tune the companion SSE reconnect backoff
- `VOXTA_FACADE_ENABLED=true` opts into the Voxta-compatible SignalR facade on `/hub`; the default is `false`
- `VOXTA_SATELLITE_ID` and `VOXTA_SATELLITE_NAME` identify the VaM/Voxta satellite in PSFN channel metadata
- Voxta session/chat IDs are random and bound to the authenticated principal by the server; reconnects retain that principal's IDs for the Hub process lifetime
- `VOXTA_ASSISTANT_NAME`, `VOXTA_USER_NAME`, and related ID vars shape the Voxta welcome/chat payloads
- `VOXTA_PUBLIC_BASE_URL` optionally overrides the public base URL used for proxy-fetchable Voxta audio artifacts
- `VOXTA_AUDIO_FOLDER` enables direct VaM TTS playback by writing local `.wav` files, typically VaM `Custom\Sounds\Voxta`; when unset, TTS uses HTTP WAV URLs under `/api/voxta/audio/`
- `VOXTA_STT_STREAM_ENABLED=true` emits Voxta `recordingRequest` messages for official-proxy or sidecar microphone streaming
- `VOXTA_VISION_CAPTURE_TIMEOUT_MS` controls how long a user turn waits for VaM Screen/Eyes capture uploads when ComputerVision is enabled
- `VOXTA_APP_TRIGGER_ALLOWLIST` is a comma-separated allowlist for Voxta `appTrigger` forwarding
- optional `PSFN_AUTHOR_ID` and `PSFN_AUTHOR_NAME` if you need the hub to assert a specific PSFN-side author
- `VOICE_REPLY_TIMEOUT_SECONDS`
- `VOICE_ENDPOINTING_GRACE_SECONDS`
- `VOICE_SILENCE_TIMEOUT_SECONDS`
- `VOICE_MAX_TURN_SECONDS`

Realtime-only mode must set either `AUDIO_PUBLIC_HOST` or `REALTIME_VOICE_PUBLIC_HOST`. The hub no longer probes an outbound address when ESPHome is not in use.

## Testing With PSFN

Set `PSFN_API_BASE_URL` and `PSFN_MODEL` in `.env`, then run the TypeScript hub:

```bash
npm run hub:ts
```

For the Python ESPHome fallback path, run:

```bash
uv run hub run
```

Fill in the remaining project-specific values in `.env`:

- ESPHome endpoint settings
- PSFN endpoint and provider overrides for the target Framework deployment

The Hub sends all agent turns to PSFN Framework over its OpenAI-compatible
`/v1/chat/completions` endpoint. PSFN Framework owns prompt assembly, identity,
memory, cognition, and tools; the Hub owns device and embodiment transport.

On the TypeScript paths, the hub passes a stable conversation id through to
PSFN Framework and does not maintain its own authoritative agent memory.

## Voxta / VaM Facade

The Voxta facade is mounted on the TypeScript hub. It is meant for VaM and
AcidBubbles-style clients that expect a Voxta server shape, while still routing
the actual conversation through PSFN Framework.

Supported HTTP and websocket routes:

| Route | Purpose |
| --- | --- |
| `POST /hub/negotiate?negotiateVersion=1` | SignalR negotiation |
| `WS /hub?id=<connectionToken>` | SignalR JSON websocket |
| `PUT /api/configurations/{id}/services/SpeechToText` | VaM STT toggle |
| `PUT /api/configurations/{id}/services/TextToSpeech` | VaM TTS toggle |
| `PUT /api/configurations/{id}/services/ComputerVision` | VaM vision toggle |
| `GET /api/voxta/audio/{artifact}.wav` | Proxy-fetchable WAV artifact for TTS playback |
| `WS /ws/audio/input/stream?sessionId=<guid>` | Voxta proxy microphone PCM stream for STT |
| `POST /api/vision/requests/{id}/send?sessionId=<guid>&source=<Screen\|Eyes>&label=virtamate` | AcidBubbles multipart JPEG vision upload |
| `DELETE /api/vision/requests/{id}?sessionId=<guid>` | AcidBubbles vision capture cancellation |
| `POST /voxta/hub/negotiate?negotiateVersion=1` | Alternate namespaced negotiation route |
| `WS /voxta/hub?id=<connectionToken>` | Alternate namespaced websocket route |

### Hub authentication and migration

The Hub now defaults to `127.0.0.1:8787`, with Voxta and anonymous development
disabled. A loopback listener without authority serves health information but
rejects client traffic. Every non-loopback listener requires an enrolled device
registry with its signing authority, or an enabled Voxta facade with a dedicated
credential. Keep network traffic behind TLS; a remote address never implies trust.

Enrolled realtime clients retain the existing `hello` handshake: supply the
registry's exact `deviceId` and device `credential`. No session metadata,
companion subscription, or turn is admitted before validation. The returned
`hello.ack.sessionId` is authoritative. A requested thread label is scoped to
that device, companion, and enrollment version; it cannot name another device's
history. Channel and satellite identity come from the server.

For native Voxta clients, send `Authorization: Bearer <credential>` on every
HTTP request and WebSocket upgrade, including audio downloads, microphone
streams, service toggles, and vision uploads. Use an enrolled device credential
with the required capabilities, or configure `VOXTA_AUTH_TOKEN` with at least
32 random bytes encoded as hex/base64url (for example, `openssl rand -hex 32`).
The dedicated token represents one Voxta principal; enroll separate devices
when callers need separate histories. The Hub rejects credential reuse with
device, gateway, control, companion, Home Assistant, or provider credentials.
Never send credentials in URLs. SignalR negotiation IDs are single-use,
short-lived, and bound to the credential that negotiated them. A native raw
`/hub` upgrade still works when its Authorization header is valid; the Voxta
`authenticate` message alone is not an authentication credential.

Set `HUB_ALLOWED_ORIGINS` to exact comma-separated browser origins, such as
`https://client.example.test`. Wildcards and `null` are rejected. Native
clients may omit Origin; all supplied Origins must match, even in developer
mode. Companion UI bridge deployments must include their canonical browser
origin. CORS preflight grants no session or turn authority.

For local development, explicitly set `HUB_DEVELOPER_MODE=true` and bind to
`127.0.0.1` or `::1`. Startup rejects wildcard, hostname, and remote binds and
prints a warning that local callers can spend provider resources. Local clients
receive connection-scoped identities and cannot choose session/channel IDs.
Device-only powers remain unavailable without enrollment.

Migration: remove old `VOXTA_SESSION_ID` / `VOXTA_CHAT_ID` pins, enable Voxta
only when needed, configure its dedicated token on both Hub and native relay
(`PSFN_VOXTA_RELAY_REMOTE_BEARER_TOKEN`), and replace cached IDs with those
returned by the authenticated server. The relay must listen on a literal
loopback address; it forwards credentials on SignalR, REST, audio downloads,
and microphone upgrades. Clients unable to set headers must use this local
relay. Anonymous remote clients are no longer supported.

Rotate a Voxta token by replacing the secret on Hub and relay and restarting
both, which closes old sockets and discards in-memory sessions and artifact
ownership. Device rotation updates the registry digest and increments
`enrollmentVersion`; revoke entries to deny the next authenticated event.
Never print tokens or put them in Helm values or release history. Helm uses
`satelliteHub.voxta.authTokenSecretRef`, defaults Voxta off, and rejects an
exposed Hub without either registry authority or enabled dedicated Voxta
authority. No live deployment is changed by these defaults.

The supported Python `hub run` realtime/hybrid entrypoint follows the same
literal-loopback development and `HUB_ALLOWED_ORIGINS` contract. For native
authenticated access set a separate `HUB_REALTIME_AUTH_TOKEN` (32 random bytes
as hex/base64url) and send it as a bearer header on upgrade. Python cannot
enroll or impersonate a device; client conversation/device IDs cannot select
server history. Both runtimes reject placeholder, repeated, and low-diversity
access tokens. The standalone TypeScript loaders apply the shared deployment
credential policy to PSFN, companion API, and control credentials as well.

Hub transport admission defaults are 256 KiB per WebSocket frame (compression
disabled), 64 KiB per JSON body, 4 MiB per vision file plus 64 KiB multipart
overhead, and 4 MiB or 120 seconds per 16 kHz mono PCM16 utterance, whichever
comes first. Bodies expire after 10 seconds. The TypeScript Hub allows 64
authenticated and 8 awaiting-authentication sockets, 8 active HTTP requests,
and 32 additional TCP connections; the total TCP population is capped at the
sum. Authentication expires after 5 seconds, idle sockets after 30 seconds,
and unused negotiations after 30 seconds, with at most 128 pending negotiations.
Incoming queues allow 32 messages and 1 MiB including the active message;
outgoing buffering and retained reply text allow 1 MiB. Session/history caches
retain at most 128 entries and evict the least recently used entry. Provider
speech queues allow 32 segments. Oversized input closes only its connection or
returns 413/429; abandoned bodies return 408.

The TypeScript Hub admits at most `maxProviderOperations` external operations
(8 by default) across all surfaces. Each operation has `providerTimeoutMs`
(30 seconds by default), combined with caller cancellation and Hub shutdown.
Admission precedes provider invocation. Cancellation or expiry detaches the
caller promptly; the slot remains occupied until the underlying promise or raw
iterator, including its cleanup, actually settles. Reconnecting cannot replace
that work. Shutdown stops admission and bounds every subsystem wait by
`authenticationTimeoutMs`; a stopped server instance cannot be restarted.

| Provider work | Admission owner |
| --- | --- |
| Realtime, Voxta and Eidoverse model replies | `HubResources.runProviderStream`, consuming the raw agent iterator |
| Realtime microphone STT and relay STT | `HubResources.runProvider` around prerecorded transcription |
| Voxta microphone STT | `HubResources.runProvider` around the outer STT adapter |
| Realtime spoken replies and relay TTS | `HubResources.runProviderStream` around the raw TTS iterator |
| Browser spoken replies | The same Hub resources passed through the browser bridge into speech synthesis |
| Voxta WAV synthesis | `HubResources.runProvider` around the complete outer synthesis, including raw TTS consumption and audio conversion |
| Eidoverse look, tool/clip lists, body actions, travel, snapshots and say | `HubResources.runProvider` around each external port operation |
| Eidoverse pending-ping polling | The same Hub resources passed to the production wake lifecycle |

Inner Deepgram/ElevenLabs adapters and world clients do not acquire another slot
for work already admitted by their caller. Model streaming and simultaneous
speech synthesis consume separate slots. If speech cannot acquire a slot, the
turn fails with a content-free error, closes its speech queue and cancels the
model; it creates no successful assistant history or speech artifact. Already
delivered text deltas remain visible. Voxta model and speech run sequentially,
so a single slot supports a successful complete turn.

Local formatting, session/artifact writes and audio encoding are not separate
provider operations. Identity metadata, companion control/SSE/audio relay,
device tooling and world connection handshakes/notifications are bounded
transport/control traffic rather than model or media provider invocations.
Device Studio image generation runs outside the Hub server lifecycle.

Upstream HTTP reads reject oversized `Content-Length` before reading, count
received bytes before decoding, and cancel fetch bodies or destroy mTLS streams
on overflow, cancellation, or expiry. Header/connect waits and finite body
reads each have the configured `providerTimeoutMs` deadline (30 seconds by
default); PSFN attempts also retain their shorter mode-specific deadlines.
Error statuses that do not require the bounded PSFN 503 busy check cancel their
bodies immediately. Diagnostics contain status/cause categories, never provider
bodies, status text, credentials, or exception messages.

| Upstream consumer | Streaming byte budget |
| --- | --- |
| PSFN completion, including 503 busy replies, fetch and mTLS | `maxQueuedBytes` (1 MiB), including the JSON envelope |
| Identity, companion control JSON, prerecorded Deepgram STT | `maxHttpBodyBytes` (64 KiB) |
| Device Studio FAL metadata JSON | Hub default `maxHttpBodyBytes` (64 KiB); default provider deadline |
| Device Studio generated PNG / FAL SDK upload-control replies | Existing 12 MiB pack-review cap shared across sequential image downloads / 64 KiB metadata cap; default provider deadline |
| Companion artifact preview | `PSFN_COMPANION_PREVIEW_MAX_BYTES` (1 MiB) |
| Eidoverse snapshot | `EIDOVERSE_SNAPSHOT_MAX_BYTES` (4,000,000 bytes), snapshot deadline |
| Companion SSE | `maxFrameBytes` (256 KiB) per retained UTF-8 frame; each decoded transport chunk is at most `maxQueuedBytes`; `idleTimeoutMs` between reads |
| ElevenLabs / Deepgram / MCPL WebSocket receives | `maxFrameBytes` (256 KiB), compression disabled |
| ElevenLabs TTS context and Voxta MP3 / WAV buffers | `maxAudioBytes` (4 MiB); TTS queue also limits message count |
| Deepgram realtime retained transcript | `maxQueuedBytes` (1 MiB) per utterance |
| Home Assistant WebSocket receives | Existing 2 MiB transport cap |
| Amica acknowledgement | Body cancelled immediately; configured request deadline |

Every outbound provider WebSocket write is admitted before enqueue: a frame
must fit `maxFrameBytes`, aggregate output must fit `maxBufferedBytes`, and at
most `maxQueuedMessages` send callbacks may remain pending. The socket owns
these charges: cancelling a TTS context, resolving a request, or timing out a
command cannot release an unfinished write. Native `bufferedAmount` overlaps
callback-pending writes, so admission uses the larger byte charge instead of
counting the same payload twice. Callbacks release their own charges once;
terminal socket close releases abandoned callbacks. A write exceeding capacity,
failing, or retaining its callback beyond `providerTimeoutMs` terminates that
connection and fails its logical operations with content-free errors. A fresh
connection creates a fresh budget. WebSocket automatic pong is disabled; actual
pong control frames use the same admission and callbacks.

| Outbound socket | Writes covered |
| --- | --- |
| ElevenLabs (created by the Hub server) | Context initialization, text/flush, cancellation/close, pong |
| Deepgram realtime (reusable adapter; currently no production caller) | PCM audio, keepalive, pong |
| MCPL (created by the Hub entrypoint) | Initialize, initialized notification, feature grant, requests, results/errors, pong |
| Home Assistant (created by the Hub entrypoint) | Authentication, state/subscription initialization, service commands, pong |
| Companion browser relay (attached by the Hub server) | Gateway and browser JSON/binary writes, assertion renewal, pong; uses its configured frame/byte caps, 32 pending frames and its handshake deadline |

HTTP-only providers retain the HTTP limits above. Device Studio and Pi client
sockets are endpoint clients.

The main realtime, Voxta SignalR and Voxta audio listeners use the same
socket-owned output admission for data, actual pong replies and close frames,
including realtime sockets still awaiting hello authentication. Automatic pong
is disabled. Each write must fit `maxFrameBytes`, `maxBufferedBytes` and
`maxQueuedMessages`; native buffering also reserves the next unmasked frame
header before enqueue. Callback-pending writes remain charged after caller
cancellation. Listener writes and close handshakes have the existing
`authenticationTimeoutMs` deadline. Overflow, callback failure or expiry
terminates the connection with content-free errors; shutdown uses the same
bounded close path. Logical cleanup cancels application work promptly, while
connection admission remains held until terminal transport close. A normal
Voxta microphone close still finalizes its accepted audio and retains its slot
until STT finishes. New connections receive fresh output budgets.

SSE remains a long-lived stream: completed frames release the frame budget and
refresh the idle deadline. Delimiter fragments and UTF-8 characters spanning
reads count toward the same frame. Voxta and realtime reply retention count
cumulative UTF-8 bytes before each append; a Voxta overflow aborts the turn
before TTS, artifact writes, assistant history, or `replyChunk`. Counters avoid
rescanning retained text for every small delta.

`HUB_RESOURCE_LIMITS_PATH` optionally points to a JSON object
`{"schemaVersion":1,"limits":{"maxFrameBytes":262144}}` relative to the Hub
root. Omitted limits retain these defaults; unknown keys and nonpositive or
unbounded integers reject startup. The complete keys are declared in
`src/ts/hub/transport-resources.ts`. Explicit `turn.start`/`turn.end` frames
buffer a complete utterance before transcription or artifact creation. Existing
continuous PCM clients still complete automatically after speech followed by
800 ms of silence (RMS threshold 25 in PCM sample units); continuous silence,
overflow, expiry, interrupt, or disconnect cannot submit an incomplete utterance.
Python uses explicit turn frames, the same frame/audio/idle defaults, 64
authenticated sockets, and a 32-frame bounded incoming queue; WebSocket writes
apply backpressure. Its server constructor exposes smaller limits for embedding
and focused tests. No paid provider or hardware checks are required to verify
these transport boundaries.

Supported Voxta client messages:

| `$type` | Behavior |
| --- | --- |
| `authenticate` | Sends `welcome` and basic configuration payloads |
| `registerApp` | Registers the VaM/Voxta satellite capabilities |
| `loadCharactersList`, `loadScenariosList`, `loadChatsList` | Returns minimal lists backed by the configured PSFN assistant identity |
| `startChat`, `resumeChat`, `subscribeToChat` | Opens or attaches a stable embodied session |
| `send` | Routes user text into PSFN Framework; `/secret` and `/note` are retained as context without generating a reply |
| `interrupt` | Cancels the active reply and emits Voxta interrupt/cancel events |
| `triggerAction` | Emits `appTrigger` only when the action is in `VOXTA_APP_TRIGGER_ALLOWLIST` |
| `speechPlaybackStart`, `speechPlaybackComplete`, `typingStart`, `typingEnd`, `pauseChat`, `inspect`, `inspectAudioInput` | Acknowledged for compatibility |

Assistant replies emit `chatFlow`, `replyGenerating`, `replyStart`,
`replyChunk`, and `replyEnd` events. When TextToSpeech is enabled,
`replyChunk.audioUrl` points at either a local `.wav` artifact written under
`VOXTA_AUDIO_FOLDER` or a proxy-fetchable HTTP WAV URL under `/api/voxta/audio/`.
If TTS is unavailable, the facade uses a `silence:0` placeholder so the text path
still works. The facade also attaches the VaM/Voxta satellite to PSFN channel metadata with text, local audio, animation,
expression, action, and vision capabilities.

For remote VaM use, run the repo-local relay on the VaM Windows machine and
point the AcidBubbles plugin at that single local endpoint:

```powershell
.\PsfnVoxtaRelay.exe
```

The relay exposes local SignalR `/hub` for VaM, forwards REST `/api/...` routes
to the remote hub, downloads remote `replyChunk.audioUrl` WAV artifacts into the
VaM audio folder, rewrites audio URLs to local file paths, and owns Windows
microphone capture when the hub emits `recordingRequest`. Set
`VOXTA_STT_STREAM_ENABLED=true` on the hub so the relay opens the remote
`/ws/audio/input/stream?sessionId=<guid>` websocket and streams 16 kHz mono PCM.
Edit the relay's published `appsettings.json` next to the EXE to set the remote
hub URL and VaM audio folder.

For VaM vision capture, enable the plugin's ComputerVision service and at least
one AcidBubbles source toggle (`Screen` or `Eyes`). On the next user turn, the
hub sends `visionCaptureRequest` for both sources, accepts the plugin's JPEG
upload or cancellation, persists the image under the artifact root, and includes
capture metadata in PSFN channel metadata. The VaM satellite already advertises
`vision_upload`, which maps to the framework `vision` and `image_upload`
capabilities at the satellite registry seam.

Current Voxta limitations:

- low-latency live STT partials for long-running mic streams are not implemented yet
- VaM vision uploads are captured and surfaced as channel metadata; using the image bytes in model prompts depends on the PSFN image-processing/multimodal pipeline contract
- live AcidBubbles plugin testing is in progress; the facade now avoids unsupported `message` server packets and accepts proxy service syncs for active configuration IDs

## Transport Paths

Pi realtime path:

- custom TypeScript realtime websocket client for Pi-class devices
- one persistent connection
- continuous outbound mic audio instead of client-opened turns
- explicit `interrupt-event` / `bot-speak-end` semantics
- Deepgram-driven utterance boundaries on the hub
- streamed assistant text and audio back to the client
- local device-owned playback and ducking
- current Pi-class deployment uses this path and has `linux-voice-assistant` disabled

Voxta/VaM embodiment path:

- Voxta-compatible SignalR websocket facade on the TypeScript hub
- user text turns enter the same embodied session registry as the Pi path
- assistant replies stream back as Voxta reply events with VaM-compatible metadata
- app triggers are denied by default unless explicitly allowlisted
- remote VaM uses the repo-local relay to provide the plugin's single local
  endpoint, local WAV playback files, REST forwarding, and microphone capture

Fallback path:

- stock ESPHome voice devices
- `linux-voice-assistant`
- ESP32-class endpoints speaking the ESPHome voice protocol

The custom client protocol is documented in
[docs/realtime-client-protocol.md](docs/realtime-client-protocol.md).

## ESPHome Fallback Notes

Natural follow-up and interrupt behavior on the ESPHome fallback path still depends on a patched `linux-voice-assistant` endpoint. The stock endpoint is good enough to expose the ESPHome voice transport, but it does not own interruption strongly enough for the behavior this bridge wants.

The current patch in
[patches/linux-voice-assistant-followup-interrupt.patch](patches/linux-voice-assistant-followup-interrupt.patch)
does three important things:

- adds speech-first barge-in detection knobs at the endpoint
- turns wake-word and stop-word interrupts into explicit local `stop output now, then reopen mic` behavior
- preserves follow-up conversation reopening after TTS instead of relying on fragile announce-state side effects

To apply it to a `linux-voice-assistant` checkout:

```bash
./scripts/apply-linux-voice-assistant-patch.sh /path/to/linux-voice-assistant
```

This is intentionally endpoint-local and does not change PSFN Framework.

## Pi Realtime Client

The dedicated Pi-class TypeScript client lives under
[src/ts/pi-client](src/ts/pi-client) with deploy assets under
[client/ts_realtime](client/ts_realtime).

It is the preferred path for devices that can afford a custom client, because it owns:

- continuous local microphone capture
- immediate local playback stop on interrupt
- local playback state instead of inferred server-side playback state
- explicit ALSA device selection
- local playback ducking before interrupt
- direct websocket streaming back to the hub
- the same interaction pattern the working reference client used:
  stream audio continuously, stop playback locally first, then notify the hub

The hub then relays the finalized user turn into PSFN Framework,
keeps the websocket/audio pipeline moving, and leaves the actual
conversation/session state inside the Framework.

Deploy with:

```bash
PI_PASSWORD='<pi-password>' ./scripts/deploy-ts-pi-client.sh <pi-host>
```

## Repository Layout

```text
src/ts/
  hub/
    framework-agent.ts
    main.ts
    server.ts
    deepgram-live.ts
    embodied-session.ts
    psfn-model.ts
    voxta-facade.ts
    elevenlabs-stream.ts
  pi-client/
    main.ts
    client.ts
    audio-capture.ts
    audio-player.ts
    alsa-volume.ts
  shared/
    env.ts
    protocol.ts
hub/
  cli/
    probe.py
    run.py
  devices/
    esphome_session.py
    voice_runtime_streaming.py
client/ts_realtime/
scripts/
tests/
```

## Notes

- The TypeScript hub sends every agent turn to PSFN Framework.
- The repo now supports a custom TypeScript realtime client path, a Voxta/VaM facade, and an ESPHome fallback path.
- The checked-in TypeScript path is the primary conversation path now.
- Historical `.agent/` scaffolding exists in this repo, but it is not the main deployment target right now.
- The Python fallback bridge still serves streamed audio on `AUDIO_SERVER_PORT` for announcement playback back to the device. Set `AUDIO_PUBLIC_PORT` when a host proxy exposes that listener on a different device-facing port.
- Physical Python fallback turns can use the same Hub-device authority as the TypeScript Hub, with or without fleet auth. Set `PSFN_COMPANION_ID`, `HUB_DEVICE_ASSERTION_SATELLITE_REGISTRY_PATH`, `HUB_DEVICE_ASSERTION_PRIVATE_KEY_PATH`, and `HUB_DEVICE_ASSERTION_TTL_SECONDS` as one complete set. The verifier ring is the registry's top-level `hubDeviceAssertions` block by default; set `HUB_DEVICE_ASSERTION_RING_PATH` (a file holding the bare block or `{ "hubDeviceAssertions": … }`) or `HUB_DEVICE_ASSERTION_FLEET_AUTH_PATH` (a `fleet-auth.json`) — never both — when it lives elsewhere. The ring must hold exactly one `active` key; the signing key is matched to a non-revoked entry by public key (preferring `active`), so rotations may carry `retiring` entries. The bridge re-reads the exact endpoint's active `hubDeviceEnrollment` before every turn and sends a fresh assertion without persisting it.
- Turn artifacts are intentionally kept for debugging transport, latency, and failure recovery.

## Upstream Plan

The likely upstream path is:

1. keep ESPHome support as a sidecar first
2. validate the Voxta facade against the real VaM plugin
3. identify the smallest PSFN Framework streaming seam worth upstreaming
4. only move toward core gateway integration after the transport feels solid

That keeps the current experiment useful without forcing a large Framework core change too early.

## Future Plans

- further smooth streaming TTS chunking and playback pacing on the TypeScript path
- add better latency instrumentation around STT finalize, first Framework token, first TTS audio, and playback start
- support fully local STT providers behind the same adapter interface
- support fully local TTS providers behind the same adapter interface
- keep the dedicated Pi client as the top-tier path while retaining ESPHome fallback compatibility
- add Voxta local WAV/URL playback artifacts for VaM speech playback
- add Voxta vision upload handling
- harden the TS client interrupt path further with more real-device soak time
- make the hub usable with a fully local speech stack before worrying about a polished upstream story
- upstream the smallest Framework-side streaming interface only after the bridge feels stable against the deployment
