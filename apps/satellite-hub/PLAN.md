# PSFN Satellite Hub Plan

## Direction

PSFN Satellite Hub should become the embodied interaction layer for agents.
PSFN sees one hub-backed channel. The hub owns satellite transport, voice
orchestration, media conversion, interrupt handling, and capability fan-out to
whatever embodied surface is attached.

PSFN Framework is the sole agent runtime. The Hub remains extensible at the
satellite, voice, media, and embodiment boundaries; it does not host or select
alternate agent brains.

## Core Model

The hub is a session router with modular adapters.

PSFN Framework provides conversation intelligence:

- PSFN through its OpenAI-compatible API and channel headers.

Satellites provide embodied I/O:

- `psfn-vrm` as the thinnest visual/test surface for the MVP.
- Amica as the richer avatar surface when available.
- VaM/Voxta as a VR embodiment and action/vision/playback surface.
- ESPHome and Pi/PSFN realtime devices as mic/speaker satellites.
- Future Live2D, robot head, browser avatar, or custom hardware adapters.

Shared services provide reusable voice and media capability:

- STT with realtime and fallback tiers.
- TTS with streaming, file, local playback, and text-only fallback tiers.
- VAD, endpointing, barge-in, and interruption.
- Audio format conversion and artifact storage.
- Caption/subtitle event fan-out.

## Architectural Contract

Each satellite declares capabilities instead of hardcoding behavior:

- Input: text, microphone PCM, final transcript, vision upload, button/wake event.
- Output: text, subtitle, streamed audio, local-file audio, animation/action,
  app trigger, expression, gaze, servo/robot movement.
- Control: interrupt, mute, sleep/wake, presence, session attach/detach.
- Safety: action allowlists, confirmation requirements, trust level, local-only
  restrictions, and per-satellite permissions.

The hub normalizes those capabilities into one embodied session. Multiple
satellites can attach to the same session. For example, a Pi can provide mic
input while VaM renders the avatar, or PSFN-VRM can render visual state while
ESPHome handles speaker output.

Only one component should own a user turn. For the main PSFN path, the hub
receives satellite input, calls PSFN once, then fans out assistant deltas,
audio, captions, actions, and state updates to attached satellites. Duplicate
PSFN calls for the same utterance are a correctness bug.

## MVP

The first MVP should prove one solid hub channel working end-to-end with either
Amica or `psfn-vrm`. `psfn-vrm` is the preferred first test surface if it is
thinner and easier to drive deterministically.

MVP behavior:

- A hub session can be created and assigned a stable embodied session id.
- A PSFN-backed agent turn can be streamed through the hub.
- A satellite can attach, receive assistant text deltas, and render final state.
- Voice input can come from the existing realtime Pi/PSFN path or typed text.
- TTS can run through the shared provider layer, with graceful fallback to text
  captions when audio is unavailable.
- Interrupts cancel active audio and stop or supersede the current assistant
  turn.
- The hub can expose one PSFN channel identity while preserving satellite
  identity in metadata.

## First Implementation Shape

Refactor toward these explicit modules:

- `framework/`: the PSFN OpenAI-compatible API and channel bridge.
- `satellites/`: PSFN-VRM, Amica, VaM/Voxta, ESPHome, Pi realtime, and future
  hardware/avatar adapters.
- `voice/`: STT, TTS, VAD, endpointing, interrupt, and audio fallback policy.
- `media/`: audio conversion, local-file publishing, HTTP media serving, and
  artifact storage.
- `sessions/`: embodied session registry, attached satellite list, capabilities,
  current turn state, and event fan-out.
- `protocol/`: typed hub wire events and capability declarations.

This should preserve the current working TypeScript realtime path while keeping
PSFN-specific assumptions behind a clear Framework client boundary.

## PSFN Integration

PSFN should treat the hub as one channel type for embodied interaction. The hub
should send stable channel identity and satellite metadata so memory, trust,
and prompt policy can remain PSFN-owned.

Initial PSFN work likely requires:

- A channel type for embodied hub sessions.
- A channel id format that can remain stable across devices and surfaces.
- Runtime metadata for active satellites and their capabilities.
- A prompt policy that supports embodied interaction without forcing every
  satellite to invent its own persona behavior.
- Tool/action gates for high-impact outputs, especially VaM app triggers and
  physical robot motion.

## VaM / Voxta Path

VaM should be implemented as a satellite adapter, not a separate agent runtime.
The adapter should provide a Voxta-compatible facade:

- SignalR `/hub` handshake and `SendMessage` / `ReceiveMessage` framing.
- Voxta app authentication and capability negotiation.
- Chat lifecycle events expected by the AcidBubbles plugin.
- Local WAV output for VaM playback.
- Vision upload request handling.
- Strictly allowlisted `appTrigger` and action support.

VaM does not need to own microphone input. It can render the embodied response
while another satellite, such as the Pi/PSFN realtime client, provides mic
input and barge-in.

## Framework Boundary

The hub should not bake cognition assumptions into the satellite layer. Its
PSFN Framework client should expose a streaming turn interface:

- Start turn with user text, context, session id, and optional media references.
- Stream assistant text deltas.
- Emit structured actions when the runtime supports them.
- Cancel or interrupt an active turn.
- Report final turn state and usage metadata when available.

PSFN Framework remains the sole implementation. VRM, Amica, VaM, apps, and
hardware attach as satellites rather than alternate runtimes.

## Fallback Policy

The hub should degrade by capability, not by special-case device code.

Examples:

- Realtime STT unavailable: accept final transcript input or typed text.
- Streaming TTS unavailable: use non-streaming TTS.
- Audio unavailable: send captions/subtitles only.
- Local-file playback required: convert or synthesize to the required format.
- Action support unavailable: drop actions explicitly with an event, not
  silently.
- Physical or app-trigger action denied: emit a denied action event with reason.

## Immediate Next Step

Start by defining the typed hub protocol and embodied session registry around
the existing TypeScript realtime server. Then implement one thin visual
satellite, preferably `psfn-vrm`, and keep Amica as the richer compatibility
target. Once that is stable, add the VaM/Voxta satellite facade and route
PSFN/Pi voice ingress into the same session.
