# Device Studio Architecture and Protocol Contract

Device Studio is repo-local tooling for ESP32-class embodied companion devices.
It lets implementation workers preview device-specific behavior, author
behavior timelines, connect to the existing PSFN Satellite Hub as a simulated
satellite, and export behavior or asset data for later firmware work.

The first target profiles are:

- Stack-chan-style companions with a face screen, expression and viseme state,
  servo movement channels, LEDs, audio I/O, and app-server-controlled behaviors.
- Waveshare ESP32-S3 1.85 inch round LCD boards, modeled as screen-centric
  devices with a 360x360 round display and touch where the concrete board
  variant supports it.

The intended product shape matches an engineering studio rather than a landing
page: a device preview, profile selector, live/mock backend mode switch,
behavior library, timeline and frame playback controls, structured command and
event log, provenance labels, and hardware verification state.

## Operator Workflow

Build and launch the browser studio from the repo root:

```bash
npm run studio:dev
```

The local server binds to loopback by default and prints the URL, normally
`http://127.0.0.1:8790`. To inspect the studio from another device on the same
LAN, bind the server to all interfaces:

```bash
DEVICE_STUDIO_HOST=0.0.0.0 npm run studio:dev
```

Use `DEVICE_STUDIO_PORT=<port>` when `8790` is already occupied. When serving
on a LAN, keep the machine and network trusted: Device Studio is local tooling,
not an authenticated production service.

The first-screen workflow is:

1. Select a profile in the top bar. The current concrete profiles are M5Stack
   Stack-chan Reference and Waveshare ESP32-S3 Touch LCD 1.85.
2. Choose `Mock` or `Live` in Operations.
3. Press `Connect`. Mock mode creates deterministic in-process hub-like events.
   Live mode connects to the Hub URL, normally `ws://127.0.0.1:8787/` for a
   local hub or `ws://<hub-host>:8787/` across the LAN.
4. Select a behavior card, scrub a frame marker, or press `Play` to inspect the
   timeline against the selected profile.
5. Send a typed turn through the Operations panel. `Draft` fills the typed-turn
   box with a profile-aware prompt for the selected behavior; `Send typed turn`
   sends it through the selected transport. `Interrupt` stops active playback
   and sends a transport interrupt when connected.
6. Inspect the Command/Event Log. Use `Copy` or `Export` to preserve the session
   evidence alongside behavior or hardware-intake artifacts.

Mock mode is the safe default for authoring because it needs no hub, provider
credentials, network, or hardware. Live mode is for checking how the studio
behaves as a simulated satellite against the real PSFN Satellite Hub websocket.
Live hub events can drive subtitles, speaking lifecycle, interrupt handling, and
local behavior selection, but they do not prove movement or display behavior on
real ESP32 hardware.

### Editing Behaviors

The behavior library is profile-aware. A behavior can carry expression, viseme,
movement, LED, display, and speaking state; playback resolves those semantic
channels against the selected device profile.

Use this loop when editing or reviewing behavior data:

1. Start in mock mode and select the target profile.
2. Select a behavior card and play it end to end.
3. For Stack-chan, inspect the Three.js physical preview for yaw/pitch,
   expression, and viseme state. For Waveshare round LCD, confirm motion
   channels drop out while expression and viseme state remain visible on the
   round display.
4. Click timeline frame markers to inspect exact frame states and watch for
   `behavior.channel.unsupported` or clamped-channel events in the log.
5. Import a behavior JSON file with `Import` when testing externally authored
   timelines. Import replaces the current browser-side behavior library for the
   session and records behavior import events.
6. Export the selected behavior with `Export` before handing it to firmware or
   hardware intake. The exported JSON preserves provenance and hardware
   verification fields; do not remove those fields to make a behavior look more
   mature than it is.

Simulator playback is enough to call a behavior `simulated-only`. It is not
enough to call servo travel, CAD pivots, display color, touch input, or firmware
timing verified on hardware.

### Sprite Generation, Review, and Export

Sprite generation is optional. The studio can work entirely from manually
provided PNGs, and deterministic sprite packing must continue to work without a
network call.

When generated source art is needed, generation must run through the local
server or CLI-backed provider that owns `FAL_KEY`. Browser code must never
receive the key, and event logs must record model IDs, options, prompts, request
IDs, provenance, and generated asset locations without recording secret values.
Set the key only in the server process environment:

```bash
FAL_KEY=<set-in-shell-or-env-file> npm run studio:dev
```

The review workflow is:

1. Choose the target profile and the expression or viseme frame to fill.
2. Upload optional reference images or enter a reference URL when the generation
   mode is image-to-image or edit. Uploaded references are preview inputs only;
   they are not assigned to an expression or viseme.
3. Request generated frame candidates or generated sprite sheets through the
   server-side provider, or import local/cached frame or sheet images manually.
4. Review candidates in the sprite workspace. Keep generated candidates marked
   as host-generated until a human approves them for a named expression or
   viseme.
5. Slice imported or generated sprite sheets by row/column count and target
   list. Sheet targets accept `expression:<id>` and `viseme:<id>` entries.
6. Approve one source frame per required expression or viseme ID. Rejected
   candidates should remain out of the firmware pack.
7. Pack/export the approved frames into a PNG atlas plus JSON manifest. The
   manifest records profile display metadata, safe area or round clipping,
   atlas rectangles, source provenance, and content hashes.

The current headless packer accepts local 8-bit RGBA, non-interlaced PNGs:

```bash
npm run studio:sprites -- \
  --profile waveshare.esp32-s3-touch-lcd-1.85 \
  --out-atlas dist/device-studio-sprites/avatar.png \
  --out-manifest dist/device-studio-sprites/avatar.json \
  --frame expression:neutral:assets/device-studio/sprites/neutral.png \
  --frame viseme:a:assets/device-studio/sprites/viseme-a.png
```

Use manual import and pack/export when `FAL_KEY` is unset or generation is
disabled. Missing generation credentials should never block review of already
available source frames.

### Hardware Verification Checklist

Use hardware verification state to prevent simulator-only data from being
mistaken for device-proven behavior. Current model states are:

- `unverified`: data exists but has not passed simulator or hardware review
- `simulated-only`: validates and plays in Device Studio only
- `partially-verified`: some channels or assets have hardware evidence, but the
  whole behavior or asset bundle is not fully accepted yet
- `verified-on-hardware`: measured on the named device and accepted for that
  device/profile/firmware path
- `unsafe`: failed hardware intake or is known unsafe for the target

Before promoting anything to `verified-on-hardware`, capture:

- target profile ID, physical device identity, firmware build, and operator
- behavior ID or sprite manifest ID under test
- transport mode used during the session and exported event log
- for Stack-chan, measured yaw/pitch limits, neutral pose, binding/no-binding
  notes, supply voltage, and whether pivots match the preview assumptions
- for Waveshare round LCD, display orientation, round clipping, safe area,
  color/alpha appearance, touch support if used, and any frame-rate or tearing
  observations
- pass/fail notes for interrupt behavior and recovery to neutral/rest state

A behavior is only as verified as its least verified safety-sensitive channel.
For example, a Stack-chan behavior with verified expressions but unverified
servo movement remains simulator-only for motion. A Waveshare behavior can be
verified for display rendering without implying anything about servos, LEDs,
microphones, or speakers.

## Behavioral Simulator, Not Emulator

Device Studio simulates behavior at the companion-device contract layer. It
models what the user and hub can observe: screen state, face expression, viseme,
servo pose, LED state, touch events, behavior playback, command/event logs, and
hub message flow.

It is not an ESP32 CPU or peripheral emulator. It does not execute Xtensa or
RISC-V instructions, emulate FreeRTOS scheduling, model Wi-Fi/BLE stacks, mimic
flash partitions, simulate SPI LCD controller timing, validate LVGL frame
buffers, or prove PWM timing on a real servo driver. Those belong to firmware
development, hardware benches, and board-specific integration tests.

This boundary is deliberate. The studio should make behavior and protocol work
fast enough to iterate without hardware, while staying honest about what has not
been measured on a physical device. Host-generated motion is simulator data
until a real unit verifies it.

## Tooling Boundary

Device Studio is tooling. It is not the production hub runtime and must not
become a required component of normal hub startup.

The hub remains responsible for:

- realtime websocket transport
- PSFN Framework conversation execution
- STT/TTS provider orchestration
- turn, interrupt, and session lifecycle
- production satellite capability vocabulary

Device Studio is responsible for:

- profile-aware previews for ESP32-class devices
- behavior authoring and playback
- mock transport scenarios that do not require credentials or hardware
- live transport to the existing websocket hub as one simulated satellite
- structured command/event logging for debugging
- provenance and hardware verification state for profile and behavior data
- exports for later firmware or asset pipeline work

Production hub behavior should remain unchanged for the MVP. If the studio later
needs structured embodiment messages, those messages must be optional,
capability-gated, documented, typed, and covered by tests. Do not overload
existing text or audio messages with hidden JSON payloads.

## System Shape

```text
Device Studio browser app
  -> profile registry
  -> behavior timeline engine
  -> preview renderers
       Stack-chan Three.js physical pan/tilt preview
       2D LCD avatar preview for square/round screens
  -> transport adapter
       live websocket adapter to PSFN Satellite Hub
       mock adapter with deterministic hub-like events
  -> command/event log
  -> import/export pipeline

Existing PSFN Satellite Hub
  -> unchanged realtime websocket server
  -> PSFN Framework runtime
  -> optional future embodiment protocol extensions

Physical ESP32 firmware
  -> later consumer of exported behavior/assets
  -> source of hardware verification results
```

The studio's internal state should be driven by the same profile and behavior
timeline model in both live and mock modes. Renderers consume resolved playback
state; they should not keep separate hardcoded behavior state.

## Live Hub Mode

Live mode connects to the existing realtime websocket endpoint, normally:

```text
ws://<hub-host>:8787/
```

In this mode Device Studio acts like a simulated satellite. It sends `hello`
with a stable device identity, optional session/channel identity, and satellite
capabilities. It can send typed turns with `user.text`, send `interrupt`, and
use `ping`/`pong` for connection health. Audio input/output can be added later,
but the MVP can exercise conversation and behavior mapping with text.

Representative live `hello`:

```json
{
  "type": "hello",
  "deviceId": "device-studio-stackchan-dev",
  "deviceName": "Device Studio Stack-chan",
  "sessionId": "device-studio:stackchan-dev",
  "satelliteId": "device-studio-stackchan-dev",
  "satelliteName": "Device Studio Stack-chan",
  "capabilities": {
    "input": ["text", "wake_event"],
    "output": ["text", "subtitle", "expression", "gaze", "servo", "animation", "action"],
    "control": ["interrupt", "presence", "session_attach"],
    "safety": ["local_only"]
  }
}
```

The existing hub already supports these websocket concepts:

- `session.ready` from hub to client when the websocket connects.
- `hello` from client to hub, followed by `hello.ack` and `status:
  call_initialized`.
- `user.text` from client to hub for typed turns.
- `message` events for live and final user/assistant text.
- `text` signals such as `audio-init` and `audio-end` around streamed audio.
- `audio` output chunks for clients that advertise `streamed_audio`.
- `interrupt` from client to hub and `assistant.interrupted` from hub to client.
- `ping` and `pong` for health checks.
- `error-event` for hub-side protocol or runtime failures.

Live mode should log every structured websocket message before reducing it into
preview state. For example, an assistant text delta can update subtitles and
drive a local viseme estimator; `audio-init` can open a speaking segment;
`assistant.interrupted` can stop behavior playback and mark the preview as
interrupted.

Live mode must not require Device Studio-specific server changes unless an
extension is deliberately introduced. When no extension is available, behavior
selection is local to the studio: the transport adapter maps hub text/audio
lifecycle events into local expression, viseme, and timeline state.

## Mock Mode

Mock mode uses the same transport adapter interface as live mode but does not
connect to the hub. It emits deterministic hub-like events in-process so the UI,
behavior engine, preview, and event log can be tested without Deepgram,
ElevenLabs, PSFN Framework, network access, or physical hardware.

Mock mode should cover these scenarios:

- connection open, `session.ready`, `hello.ack`, and `status` flow
- assistant live text deltas and final message
- user final message echo for a typed turn
- speaking lifecycle with `audio-init` and `audio-end` events
- interrupt while a behavior is playing
- recoverable protocol or runtime error surfaced as an `error-event`
- local behavior command playback without hub involvement

Mock and live modes should produce the same command/event log schema. The event
source distinguishes `mock`, `live`, `user`, `transport`, `behavior`,
`import/export`, and `hardware verification`.

## Device Profile Model

A device profile describes the capabilities and safety constraints of one
device class or board variant. It is not a firmware image. It is data consumed
by the studio model, renderers, transport adapter, and export pipeline.

Profile fields should include:

- `id`, `name`, `version`, and `description`
- device family such as `stackchan`, `round-lcd`, or `generic-esp32-display`
- display shape, width, height, orientation, color format target, and safe area
- touch capability, coordinate space, and gesture support
- audio capability, including microphone and speaker availability
- expression channels supported by the face renderer
- viseme channels supported by the face renderer or sprite set
- movement channels with semantic IDs, ranges, units, neutral value, and
  clamp behavior
- LED and backlight channels
- realtime hub capabilities advertised in `hello`
- renderer hints for 2D LCD or Stack-chan Three.js pan/tilt preview
- provenance and hardware verification state

Representative profile shape:

```json
{
  "id": "stackchan.reference",
  "name": "Stack-chan Reference",
  "family": "stackchan",
  "display": {
    "shape": "square",
    "width": 320,
    "height": 240,
    "safeArea": { "x": 0, "y": 0, "width": 320, "height": 240 }
  },
  "touch": { "supported": false },
  "audio": { "microphone": true, "speaker": true },
  "movement": [
    {
      "id": "head.yaw",
      "label": "Head yaw",
      "unit": "deg",
      "min": -20,
      "max": 20,
      "neutral": 0,
      "hardwareVerification": {
        "status": "unverified",
        "label": "Servo range requires hardware intake"
      }
    },
    {
      "id": "head.pitch",
      "label": "Head pitch",
      "unit": "deg",
      "min": -15,
      "max": 15,
      "neutral": 0,
      "hardwareVerification": {
        "status": "unverified",
        "label": "Servo range requires hardware intake"
      }
    }
  ],
  "leds": [{ "id": "status.rgb", "kind": "rgb" }],
  "expressions": ["neutral", "happy", "laughing", "angry", "sad", "surprised"],
  "visemes": ["rest", "closed", "a", "e", "i", "o", "u", "m"],
  "hubCapabilities": {
    "input": ["text", "wake_event"],
    "output": ["text", "subtitle", "expression", "gaze", "servo", "animation", "action"],
    "control": ["interrupt", "presence", "session_attach"],
    "safety": ["local_only"]
  },
  "provenance": {
    "source": "host-generated",
    "note": "Initial host-side profile; replace ranges after hardware intake."
  },
  "hardwareVerification": {
    "status": "unverified",
    "label": "Host-side profile; hardware intake required"
  }
}
```

Unsupported channels must degrade cleanly. If a behavior contains `head.yaw`
but the selected profile is screen-only, playback ignores that channel, logs a
`behavior.channel.unsupported` event, and continues rendering the supported
expression, viseme, screen, LED, and touch state.

## Target Profile Examples

Stack-chan target profile:

- Screen and face renderer are first-class.
- Expression and viseme channels drive the face.
- Two movement channels model common pan/tilt or yaw/pitch servo behavior.
- LED state can represent status or emotion where the concrete unit supports it.
- Audio I/O may be represented in capabilities, but the studio MVP can use typed
  turns and local speaking lifecycle events before streaming real audio.
- Servo limits must start as unverified unless measured on a real device.

Waveshare ESP32-S3 1.85 inch round LCD profile:

- Display is a 360x360 round screen with round clipping in the renderer.
- Touch is enabled only for board variants with verified touch input.
- Expression and viseme state are rendered on screen.
- Movement channels are absent, so Stack-chan motion degrades to no-op events.
- The profile should remain screen-centric and should not imply servos, LEDs, or
  microphone/speaker support unless the exact hardware intake confirms them.

## Behavior Timeline Model

A behavior timeline is the semantic source of playback. It describes what the
companion should do over time, independent of any one renderer or firmware
implementation.

Core fields:

- `id`, `name`, `version`, and `description`
- `durationMs`
- optional `loop`, `tags`, and target profile families
- ordered `frames`, each with an `atMs` timestamp
- expression, viseme, movement, LED, display, and audio/speaking state per frame
- easing or interpolation hints where needed
- provenance and hardware verification state

Representative timeline:

```json
{
  "id": "behavior.happy_greeting",
  "name": "Happy greeting",
  "durationMs": 1400,
  "frames": [
    {
      "atMs": 0,
      "expression": "happy",
      "viseme": "rest",
      "movement": { "head.yaw": 0, "head.pitch": 0 },
      "leds": { "status.rgb": "#44ff88" }
    },
    {
      "atMs": 350,
      "expression": "laughing",
      "viseme": "a",
      "movement": { "head.yaw": -12, "head.pitch": 5 }
    },
    {
      "atMs": 900,
      "expression": "happy",
      "viseme": "closed",
      "movement": { "head.yaw": 12, "head.pitch": -3 }
    },
    {
      "atMs": 1400,
      "expression": "neutral",
      "viseme": "rest",
      "movement": { "head.yaw": 0, "head.pitch": 0 }
    }
  ],
  "provenance": {
    "source": "host-generated",
    "label": "Device Studio generated draft"
  },
  "hardwareVerification": {
    "status": "simulated-only",
    "label": "Plays in Device Studio only"
  }
}
```

Playback resolves the timeline against the selected profile:

1. Sort frames by `atMs`.
2. Clamp frame times to `0..durationMs`.
3. Validate each semantic channel against the profile.
4. Clamp numeric movement values to the profile's safe range.
5. Interpolate channels that declare interpolation support.
6. Emit one resolved render state per playback tick.
7. Log unsupported or clamped channels with provenance and verification context.

The same behavior can therefore animate Stack-chan movement and face state while
rendering only face state on the Waveshare round LCD profile.

## Expressions and Visemes

Expression state represents emotional or social presentation. Initial expression
IDs should be small and stable: `neutral`, `happy`, `laughing`, `angry`, `sad`,
`surprised`, `sleepy`, and `blink` are enough for the MVP.

Viseme state represents mouth shape for speaking. Initial viseme IDs should be
renderer-neutral: `rest`, `closed`, `a`, `e`, `i`, `o`, `u`, `m`, and `wide`.
Live hub text deltas can drive a simple local text-to-viseme estimate in the
studio. Audio-driven viseme extraction is a later enhancement and should not be
required for the first live websocket integration.

Renderers map semantic expression and viseme IDs into concrete visuals:

- Stack-chan preview maps them to the screen/face surfaces carried by the 3D
  pan/tilt rig.
- Round LCD preview maps them to clipped 2D screen graphics.
- Firmware export maps them to sprite sheets, RGB565 data, or embedded behavior
  tables in a later pipeline.

## Stack-chan 3D Asset Intake

The Stack-chan physical preview uses a manifest before it uses a CAD file. The
repo-local manifest lives in `src/ts/device-studio/assets.ts` and defines:

- canonical source path: `assets/device-studio/stackchan/source/shell.stl`
- generated browser-preview path: `dist/device-studio/assets/stackchan/stackchan-preview.glb`
- generated preview manifest path:
  `dist/device-studio/assets/stackchan/stackchan-preview.manifest.json`
- coordinate system: right-handed, millimeters, Y up, Z forward
- semantic model parts for body, head, display, neck, and LEDs
- pivot mappings for `head.yaw` and `head.pitch`
- source STL files for the case shell, feet, XL330 brackets, and horn

The current checkout includes the small Stack-chan case v1 STL source assets
from `stack-chan/stack-chan` under `assets/device-studio/stackchan/source/`,
with upstream commit and Apache-2.0 license provenance in `UPSTREAM.txt`.
Generated GLB or processed preview outputs should stay generated unless the repo
intentionally decides to store them.

The Three.js preview requires these STL assets. There is no CSS stand-in for
Stack-chan motion. The feet stay fixed, the yaw group carries the upper
brackets/neck around the pan axis, and the pitch group carries the shell,
horn, display, expression, and viseme surfaces around the face-side tilt axis.
The current pivot numbers are still simulator metadata and must remain
`unverified` until a real unit confirms the pivots and movement range.

## Sprite Source Generation and Packing

Sprite generation is optional and server-side. Device Studio tooling may call
fal.ai models to create source artwork for expressions and visemes, but browser
code must never receive `FAL_KEY`. The key belongs only in the local server or
CLI process environment:

```bash
FAL_KEY=<set-in-shell-or-env-file> npm run studio:dev
```

The provider should support model IDs through configuration, starting with:

- `fal-ai/nano-banana`
- `fal-ai/nano-banana/edit`
- `fal-ai/nano-banana-2`
- `fal-ai/nano-banana-2/edit`
- `fal-ai/gpt-image-1.5`
- `fal-ai/gpt-image-1.5/edit`

Generated art is just one possible input. Manually supplied PNGs and cached
generated PNGs must flow through the same deterministic sprite packer. The
packer produces a PNG atlas plus JSON manifest that records frame IDs,
expression/viseme kind, source provenance, profile display size, safe area or
round clipping metadata, atlas rectangles, and a content hash. Firmware exports
must be reproducible without network calls.

Browser reference uploads are sent to the local studio server as data URLs. The
server owns `FAL_KEY`, uploads those references to fal storage, and forwards the
resulting URLs to image-to-image or edit models. Frame imports are separate from
references: imported frames are assigned only to the currently selected
expression or viseme target, while imported sheets are sliced by the row/column
and target controls.

The headless CLI packs local PNG frames after TypeScript compilation:

```bash
npm run studio:sprites -- \
  --profile waveshare.esp32-s3-touch-lcd-1.85 \
  --out-atlas dist/device-studio-sprites/avatar.png \
  --out-manifest dist/device-studio-sprites/avatar.json \
  --frame expression:neutral:assets/device-studio/sprites/neutral.png \
  --frame viseme:a:assets/device-studio/sprites/viseme-a.png
```

The initial PNG reader intentionally supports 8-bit RGBA, non-interlaced PNG
sources. That keeps the packer dependency-free and deterministic while leaving
room for broader image-format intake later.

## Movement, LEDs, and Display Channels

Movement channels use semantic IDs rather than board pins. Examples:

- `head.yaw`
- `head.pitch`
- `body.bob`
- `gaze.x`
- `gaze.y`

Each channel declares a unit, range, neutral value, and verification state.
Movement values are never treated as hardware-safe just because they render in
the studio. The preview can show out-of-range authoring attempts after clamping,
but exported data should preserve the warning in the event log or validation
result.

LED and display channels should follow the same pattern:

- `status.rgb` for RGB LEDs
- `backlight.level` for screen brightness
- `display.expressionOverlay` for renderer-specific overlays if needed

Avoid putting firmware pin numbers or driver details in behavior timelines. Pins
belong in firmware or board-specific export profiles, not in semantic behavior.

## Provenance Labels

Profiles, behaviors, frames, assets, and hardware verification changes should
carry provenance. Provenance is visible in the UI so workers can distinguish
confirmed device data from host-generated data.

Recommended provenance source values:

- `official`: copied from a confirmed official source or vendor docs
- `device-derived`: measured or captured from a real device
- `host-generated`: generated inside Device Studio or by local tooling
- `user-authored`: manually authored or imported by an operator
- `test-fixture`: fixture data for tests and local examples

Provenance should include a note and optional URL, commit, artifact path, or
operator field. Do not mark generated servo ranges as official or hardware-safe
without evidence.

## Hardware Verification States

Verification state is separate from provenance. A value can be officially sourced
but still untested in this repo's target firmware path.

Recommended states:

- `unverified`: exists as data, but no simulator or hardware check has passed
- `simulated-only`: validates and plays in Device Studio only
- `partially-verified`: some channels or assets have hardware evidence, but the
  whole profile, behavior, or pack is not fully accepted
- `verified-on-hardware`: measured on the named hardware and accepted as safe
- `unsafe`: failed hardware intake or is known unsafe for the target device

Verification can apply at multiple levels: profile, movement channel, behavior,
individual frame, exported asset bundle, and firmware intake report. A behavior
is only as verified as its least verified safety-sensitive channel.

The event log should record every verification transition:

```json
{
  "type": "hardware.verification.changed",
  "timestamp": "2026-05-11T16:00:00.000Z",
  "source": "hardware verification",
  "profileId": "stackchan.reference",
  "target": "movement.head.yaw",
  "from": "simulated-only",
  "to": "verified-on-hardware",
  "operator": "bench-intake",
  "note": "Measured on reference unit at 5V supply; no binding observed."
}
```

## Structured Command and Event Log

The studio log is append-only debugging data. It is not a second issue tracker.
Each event should be structured JSON with enough context to replay what happened
during a simulation or live hub session.

Common fields:

- `timestamp`
- `source`: `live`, `mock`, `user`, `transport`, `behavior`, `import/export`,
  or `hardware verification`
- `mode`: `live` or `mock`
- `profileId`
- `sessionId`
- `transportMessageType` when a websocket message is involved
- `behaviorId` and `frameAtMs` when timeline playback is involved
- `provenance` and `verification` where relevant
- `payload` with the original structured message or reduced state

Important event types:

- `transport.connecting`
- `transport.hello.sent`
- `transport.message.received`
- `transport.error`
- `user.turn.sent`
- `interrupt.sent`
- `behavior.select`
- `behavior.playback.start`
- `behavior.frame.apply`
- `behavior.channel.unsupported`
- `behavior.channel.clamped`
- `behavior.import`
- `behavior.export`
- `profile.select`
- `hardware.verification.changed`

The UI should make the source visible with labels such as live hub, mock hub,
host-generated, official, user-authored, simulated-only, partially-verified, and
verified-on-hardware.

## Optional Protocol Extensions

For the MVP, no new hub protocol message is required. Device Studio can connect
as a normal realtime satellite, advertise previewable output capabilities in
`hello`, and reduce existing `message`, `text` audio lifecycle, `audio`,
`assistant.interrupted`, `action`, `user.text`, and `interrupt` events into local
simulator state. Expression, viseme, movement, LED, and display playback are
owned by the studio behavior engine until a hub feature explicitly needs to
command or observe those states across the websocket.

If later implementation needs server-driven embodied behavior, add explicit
messages rather than encoding JSON inside `text.data` or
`message.data.content`.

Extension rules:

- Add shared TypeScript protocol types and focused tests.
- Keep every new message optional and capability-gated.
- Preserve old Pi-class realtime clients and Voxta facade behavior.
- Include a version or schema field when a payload can evolve.
- Make unknown or unsupported features degrade without crashing clients.
- Document whether each message is client-to-hub, hub-to-client, or bidirectional.
- Add mock transport coverage before relying on the message in the UI.

Candidate messages:

`embodiment.state`

```json
{
  "type": "embodiment.state",
  "schema": "device-studio.embodiment-state.v1",
  "sessionId": "device-studio:stackchan-dev",
  "profileId": "stackchan.reference",
  "state": {
    "expression": "happy",
    "viseme": "a",
    "movement": { "head.yaw": -10, "head.pitch": 4 },
    "leds": { "status.rgb": "#44ff88" }
  },
  "provenance": { "source": "host-generated" },
  "hardwareVerification": { "status": "simulated-only" }
}
```

`behavior.command`

```json
{
  "type": "behavior.command",
  "schema": "device-studio.behavior-command.v1",
  "commandId": "cmd_123",
  "behaviorId": "behavior.happy_greeting",
  "action": "play",
  "params": { "loop": false },
  "source": "hub",
  "requiresConfirmation": false
}
```

`device.input`

```json
{
  "type": "device.input",
  "schema": "device-studio.device-input.v1",
  "profileId": "waveshare-esp32-s3-round-1_85",
  "input": {
    "kind": "touch",
    "x": 184,
    "y": 210,
    "phase": "tap"
  }
}
```

These are guidance, not required MVP messages. If no extension is implemented,
close the extension work with an explicit note that existing hub messages plus
local studio state were sufficient.

## MVP

The MVP should provide enough surface for parallel workers to build and test the
Device Studio without consulting the original screenshot or chat context:

- repo-local browser app scaffold separated from production hub runtime
- profile selector with Stack-chan and Waveshare round LCD examples
- live/mock mode switch and visible connection state
- mock transport that exercises UI and behavior playback without credentials
- live websocket adapter for `hello`, typed turns, interrupts, message events,
  audio lifecycle markers, and structured errors
- profile-aware preview for screen/expression/viseme state
- Stack-chan Three.js preview sufficient to inspect yaw/pitch behavior against
  the STL-mounted physical rig
- behavior library and timeline frame playback
- import/export of behavior JSON
- command/event log with source, provenance, and verification labels
- validation that unsupported channels degrade cleanly

## Non-Goals

Device Studio should not attempt to:

- emulate ESP32 CPUs, peripherals, Wi-Fi, display drivers, or FreeRTOS
- flash firmware or replace firmware-specific integration tests
- become a required production hub service
- change hub startup behavior for existing clients
- certify motion safety without hardware intake
- certify CAD pivots or motion safety without physical unit calibration
- require paid STT/TTS/provider credentials for mock mode
- store project work tracking outside bd

## Test Strategy

Tests should be layered around contracts rather than visuals alone.

Model tests:

- validate required profile and timeline fields
- reject duplicate channel IDs and invalid frame ordering
- calculate duration and frame playback state deterministically
- clamp movement values by profile range
- log unsupported channel degradation for screen-only profiles
- preserve provenance and verification state through import/export

Transport tests:

- parse live websocket `session.ready`, `hello.ack`, `status`, `message`,
  `text`, `audio`, `assistant.interrupted`, `pong`, and `error-event`
- verify `hello`, `user.text`, `interrupt`, and `ping` outbound shapes
- run the same reducer against live-adapter fixtures and mock-adapter events
- ensure optional extension messages are ignored or surfaced cleanly when not
  supported

Renderer and playback tests:

- use fake clocks for timeline playback
- verify Stack-chan movement channels affect resolved pose state
- verify Waveshare round LCD preview clips to a round display model
- verify expression and viseme changes are renderer-neutral before they become
  sprites or meshes
- use screenshot or canvas-pixel checks later for nonblank 2D/3D renderers

Integration tests:

- run mock mode without network or provider credentials
- connect live mode to a local hub when credentials/config are available
- confirm existing hub tests still pass when protocol code changes
- verify import/export artifacts are deterministic
- verify production hub behavior is unchanged unless a documented extension is
  added with tests

For this docs-only contract change, a repository TypeScript check is sufficient
to confirm no runtime files were accidentally modified.

## Integration Plan

Use this order so work remains parallel-friendly and scoped:

1. Land this architecture/protocol contract in docs.
2. Add shared TypeScript profile and behavior timeline types with validation.
3. Add the Device Studio app scaffold outside the production hub runtime.
4. Add Stack-chan and Waveshare profile fixtures with provenance and verification
   fields.
5. Build mock transport and the shared transport reducer before live websocket
   coupling.
6. Add the live websocket adapter using the existing realtime protocol.
7. Add profile-aware 2D LCD rendering and Stack-chan movement preview.
8. Add behavior authoring, import/export, and structured command/event logging.
9. Add optional embodiment protocol extensions only if local state plus existing
   hub events are insufficient.
10. Run final QA across mock mode, live mode, import/export, and unchanged
    production hub behavior.

Each step should keep generated or host-side data visibly marked until hardware
verification promotes it. Production hub code should only change when a protocol
extension is intentionally introduced, documented, and tested.
