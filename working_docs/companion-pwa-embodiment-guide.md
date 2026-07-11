# Companion PWA Embodiment — Build Guide

Date: 2026-07-11
Epic: `psfn-framework-7ang` (children `.1`–`.9`)
Surfaces: `companion-ui/` (React PWA), `~/PSFN-Satellite-Hub` (tracked hub repo), `psfn-framework` core (companion relay, intake).

Goal: the standalone mobile chat PWA becomes an embodied surface — the sprite
renders the companion's real emotional state and tool activity, touch
(headpats/hugs/kisses) reaches her as descriptive stimuli she can respond to,
a full-screen avatar view with voice works as a portable satellite, and phone
GPS gives her location awareness as place semantics only.

---

## 1. Ground truth (what exists today)

### companion-ui (`companion-ui/`)

- React + Vite PWA; manifest + service worker in `public/`; talks ONLY to the
  hub websocket, never PSFN core (see `companion-ui/README.md` boundaries).
- Protocol is a local mirror of the hub contract:
  `src/lib/protocol/events.ts`, `src/lib/protocol/framing.ts`.
  **The hub wins on drift — re-mirror, never invent shapes here.**
- The sprite is a floating `<button>` with a CSS-drawn face
  (`src/ui/companion-sprite.tsx:16-33`) driven by six purely *operational*
  states — `attentive | speaking | listening | thinking | tool_use | error`
  (`src/ui/types.ts:15`, `deriveSpriteState` at `companion-sprite.tsx:44`).
  No emotion input, no touch behavior, one undifferentiated `tool_use`.
- One thread view, no tabs; activity/settings are overlay drawers.
- Mic modes (Dictation / Voice Chat) exist in the composer but are
  **fail-closed by design** — no audio transport implemented.
- `tool.activity` frames already arrive (tool name + phase) and fold into the
  Activity drawer.

### Hub (`~/PSFN-Satellite-Hub`, tracked repo — the in-tree copy is read-only)

- One WS endpoint, JSON frames; contract in `src/ts/shared/protocol.ts`.
  Output capability enum already reserves `expression`, `animation`,
  `tool_activity` (`protocol.ts:281-292`).
- PSFN→hub is an authenticated SSE stream consumed by
  `src/ts/hub/companion-bridge.ts`; it fail-closes on unknown event kinds
  (`parseCompanionEventData`, `:404-415`). Relay to clients is capability-gated
  in `src/ts/hub/server.ts relayCompanionEvent()` (`:570-597`) with
  `canReceive*` helpers in `embodied-session.ts:167-177`.
- Hub already streams voice to satellites: PCM 16k mono in / mp3 out,
  bracketed by `audio-init`/`audio-end` (`server.ts:795-815`, format advertised
  in `session.ready`, `server.ts:296`). The Node pi-client proves the contract.
- Device Studio (`src/ts/device-studio-app/`) is an authoring tool, not the
  chat app, but two pieces are worth porting/reusing:
  - gesture classification thresholds (`display-preview.ts:559-578` —
    double-tap 340ms, long-press 550ms, move 18px);
  - the sprite-sheet toolchain: `SpriteSheetManifest`
    (`src/ts/device-studio/sprites.ts:59-78`) + fal.ai generation
    (`sprite-cli.ts`, `fal-provider.ts`).

### PSFN core (`psfn-framework`)

- Emotion is **dimensional + open vocabulary**, not an enum:
  - VAD (`valence/arousal/dominance`, each signed −1..1) + slow mood EMA +
    open `discrete: Record<string, number>` + confidence
    (`src/core/emotion/state.ts:3`). The text classifier emits up to 28
    discrete labels (`text-classifier.ts:43`) — the sprite mapping MUST have a
    fallback for unknown labels.
  - ACAC self-report: `agency/connection/authenticity/curiosity`, each 0..1
    with rationale text (`src/core/emotion/acac.ts:5`).
  - Everything consolidates into `InternalState.emotional`
    (`src/core/self-model/state.ts:80`) — the single read source.
- Companion relay (PSFN→hub) kinds are exactly
  `approval.requested | approval.resolved | artifact.created | tool.activity`
  (`src/shared/contracts/companion-relay.ts:23`), each mapped to a
  deny-by-default `SatelliteTelemetryScope`. Redaction at emission
  (`src/channels/backplane/companion-relay/redaction.ts`); agent-side
  forwarder (`agent-forwarder.ts`); gateway-side fan-out (`relay.ts`).
- Tool taxonomy: 16 `FirstPartyToolDomain`s
  (`src/core/agent/tool-surface/registry.ts:4`); the relay carries the tool
  *name* only — name→domain mapping is a client concern (or a payload
  extension).
- Ingress: everything is a `SubstrateMessage`
  (`src/shared/contracts/runtime.ts:308`); `routing.responseMode:
  'respond' | 'observe'` (`runtime.ts:255`) is the built-in seam for stimuli
  that should color state without forcing a reply. Intake firewall classifies
  primary-user content as trusted but still screens it.
- Location is place semantics, never coordinates: `SituatedLocation`
  (`src/core/self-model/state.ts:67`), resolved from
  `routing.satellite.placeId` with 6h staleness handling
  (`src/core/self-model/situated-location.ts`). The S10 world/places surface
  is epic `psfn-framework-vinz` — the GPS bead feeds it, doesn't fork it.

---

## 2. The sprite model (three layers)

Priority when layers conflict: **touch reaction > tool animation > speaking
mouth > emotional base**. The emotional base always sets the face; overlays
modulate it.

### Layer 1 — emotional base (from `emotion.snapshot`)

VAD/mood quadrant picks the base; a discrete label that clears a score
threshold upgrades it; unknown labels fall back to the VAD base (mandatory —
the vocabulary is open).

| Signal | Expression id |
|---|---|
| VAD ≈ 0 | `neutral` |
| V+ A− | `content` |
| V+ A mid | `happy` |
| V+ A+ | `excited` |
| discrete joy high + arousal | `laughing` |
| discrete love high | `love` (blush + hearts) |
| ACAC curiosity high / discrete curiosity | `curious` (head tilt) |
| discrete surprise | `surprised` |
| V− A− | `sad` |
| low arousal, late / sleeptime | `tired` → `asleep` |
| V− A+ D− | `anxious` |
| V− A+ D+ | `grumpy` |
| V+ D+ | `smug` |
| touch-reaction states | `embarrassed`, plus reaction frames below |
| during generation | `thinking` |

~16 ids, frozen before art generation. Each id ships in **two crops**:
full body (avatar view) and head-only (mini sprite).

### Layer 2 — operational overlay (exists today)

`speaking / listening / thinking / error` become modulators, not
replacements — she can be *tiredly* speaking or *excitedly* thinking.
`attentive` = no overlay. Voice playback amplitude drives the mouth (v1
lipsync).

### Layer 3 — tool-domain animations (splits today's `tool_use`)

Client maps `toolName → FirstPartyToolDomain → bucket` (table mirrored from
`registry.ts`):

| Domains | Animation |
|---|---|
| `memory`, `knowledge` | scribbling in a notebook |
| `analysis`, `orientation` | magnifying glass / gears |
| `boundary`, `system`, `tracked_work` | wrench / tiny terminal |
| `media`, `self_expression` | painting |
| `contacts`, `sessions`, `notification` | envelope / phone |
| `scheduler` | clock |
| `subagents`, `shards`, `adaptive_tooling` | tiny clones helping |

`started` loops, `completed` sparkles, `failed` dizzy-puff.

---

## 3. New wire surfaces (contract summary)

All additions follow existing patterns; nothing bypasses capability gating or
redaction.

| Addition | Direction | Pattern to copy |
|---|---|---|
| `emotion.snapshot` | PSFN → hub → client | `tool.activity` end-to-end |
| `touch.interaction` | client → hub | `approval.decision` |
| `POST /v1/companion/stimuli` | hub → PSFN | `submitApprovalDecision` back-channel |
| `device.location` | client → hub (terminates at hub) | new; coords never forwarded |

### `emotion.snapshot` payload (redacted at PSFN emission)

Rounded VAD + mood vectors, top-K discrete labels+scores, confidence, ACAC
axis **scores only**. Never: ACAC rationales, active concerns, salient
entities. New `emotion` telemetry scope, deny-by-default per satellite in
`satellites.json`. Emit post-turn and on `vad_shift` appraisals
(`appraisal.ts:47`).

### Touch stimuli

- Client sends only an enum shape: `{kind: headpat|petting|hug|kiss, region,
  count, durationMs}` — **PSFN owns the descriptive wording** from a fixed
  template set (keeps the injection surface closed; no client free-text).
- Client coalesces bursts (~2–3s quiet window): a petting session is ONE
  event with count+duration, never N messages. The PSFN endpoint still rate
  limits independently.
- Lands as a primary-user `SubstrateMessage` with satellite presence stamped;
  `respond` for deliberate affection, `observe` for incidental touches.
- Instant *local* reaction animation on the client (blush/hearts) — never
  wait on the round trip.

### GPS

- `watchPosition` foreground-only (browser PWAs get no background GPS —
  accepted v1 limit: "she knows where you are when the app is open").
- Significant-change filter (~100m + min interval) before sending.
- **Raw coordinates terminate at the hub.** Hub geofences configured zones
  (home first, HA zones later), binds/unbinds the phone-satellite `placeId`,
  posts zone transitions as stimuli (`left home` = observe, `arrived home` =
  respond), passes coarse labels via `contextNotes`
  (`embodied-session.ts:45-69`) when unzoned.
- Hard invariant: no lat/lon in any PSFN prompt, message, log, or relay
  payload — labels only, sanitized.

---

## 4. Build order and bead map

```
7ang.1 PSFN emotion.snapshot relay        ─┐
7ang.2 hub relays emotion.snapshot         ├─ .1 → .2 → .3 → .9
7ang.3 sprite v2 (3-layer, CSS face)      ─┘         │
7ang.9 sprite art (fal.ai sheets, swap)   ←──────────┘
7ang.4 PSFN touch/stimuli ingress         ─┐
7ang.5 hub+UI touch path, pettable mini    ├─ .4 → .5 → .6   (.3 also → .6)
7ang.6 avatar view + gesture vocabulary   ─┘
7ang.7 browser voice (composer + avatar)      independent
7ang.8 GPS place semantics                    .4 → .8 (uses stimuli endpoint)
```

Two independent tracks after `.1`/`.4` land; `.7` anytime. Suggested spike
alongside `.1`: iOS PWA quirks on the actual phone (AudioContext unlock,
mic permission persistence, wake lock, geolocation-while-foregrounded).

### Per-bead seam checklists

**`.1` PSFN `emotion.snapshot`** — `companion-relay.ts` (kind + payload +
scope map), `event-bus.ts` (topic), `redaction.ts` (redactor), forwarder
emit from post-turn `InternalState` + `vad_shift`, `relay.ts` subscription +
publish-params parser, scope grant documented for `satellites.json`.

**`.2` hub relay** — `protocol.ts` (message + `emotion` output capability),
`companion-bridge.ts` projector, `embodied-session.ts` `canReceiveEmotion` +
presets, `server.ts` relay case, `transport.ts` parsing.

**`.3` sprite v2** — re-mirror protocol; quadrant map + overlay + fallback;
name→domain table; layer priority; extend the CSS face with
`data-emotion`-driven shapes. Tests: quadrant mapping, unknown-label
fallback, layer priority.

**`.4` stimuli ingress** — `companion-relay-routes.ts` endpoint, fail-closed
validation, server-side templates, presence stamping, `responseMode`, rate
cap, intake screening intact.

**`.5` touch path** — hub `touch.interaction` message + handler + bridge
POST (capability-gated); UI mini-sprite tap = headpat, burst coalescing,
instant local reaction; mirror protocol.

**`.6` avatar view** — `thread | avatar` switcher (no router); hit regions
(head/cheek/body) × gestures (port Device Studio thresholds); region×gesture
→ stimulus kind; thread state preserved across switch.

**`.7` voice** — getUserMedia → AudioWorklet → 16k PCM frames up; mp3
reassembly between `audio-init`/`audio-end` → Web Audio down; amplitude →
sprite mouth; wake lock in avatar view; `hello` capabilities updated; iOS
quirks explicit.

**`.8` GPS** — UI watchPosition + settings-drawer permission UX +
`device.location`; hub zone config + geofence + place binding + transition
stimuli + contextNotes. Privacy invariant test: grep-level assertion that
lat/lon never crosses the hub→PSFN boundary.

**`.9` art** — freeze ids; operator approves ONE reference sheet before bulk
generation; two crops per expression + 7 tool loops + touch-reaction frames;
manifest under `companion-ui/public/`; CSS face stays as fail-visible
fallback; lazy-load avatar-view sheets.

---

## 5. Invariants (apply to every bead)

- Fail closed: unknown frames rejected, capabilities deny-by-default, no
  silent fallback on malformed payloads.
- Redaction at emission: internal-state details never leave PSFN unredacted;
  emotion payload carries scores, not prose.
- Client sends enums, PSFN authors prose (touch templates) — no free-text
  stimulus passthrough.
- Coalesce affection bursts client-side AND rate-limit server-side.
- Raw GPS coordinates never leave the hub.
- Protocol changes land hub-first, then re-mirror into
  `companion-ui/src/lib/protocol/` — the mirror never leads.
- companion-ui never calls PSFN core or `/api/admin/*`.
- Per-package gates: companion-ui `npm run test|typecheck|lint|build`; repo
  root `npm run lint` before closing any bead.
