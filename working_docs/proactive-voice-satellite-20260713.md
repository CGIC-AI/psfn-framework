# Proactive Voice on Satellites — Findings & Design Sketch (2026-07-13)

Investigation notes: what it would take for the companion to *initiate* speech on a
voice satellite (Waveshare) the way she can already initiate Discord messages.
No beads filed; this is a working document.

The two constraints that motivated this:

1. **Time** — never speak in the middle of the night while the partner is asleep.
2. **Place** — speak on the device in the room where the partner actually is,
   using the motion detectors that record the last place he was moving around.

Good news up front: almost every building block already exists. The proactive
pipeline, the quiet-hours gate, the room ontology, the presence ingestion path,
and the hub-side audio push primitive are all implemented. What is missing is
(a) a PSFN→hub outbound "speak" command seam, (b) a channel-type generalization
of the outbound dispatcher, and (c) the actual sensor feed from the motion
detectors into the telemetry ingest endpoint.

---

## 1. What exists today

### 1.1 Proactive outbound (Discord) — the pipeline to reuse

All companion-initiated messaging funnels through **one** path:

```
TRIGGER
  ├─ appraisal decides followUp.delivery = 'external'
  │    (src/core/intention/appraisal/action-translation.ts:150)
  ├─ weighted-thought outreach lane (standalone, disabled by default)
  │    (src/core/scheduler/weighted-thought-outreach-lane.ts)
  └─ temporal-wakeup morning lane (daily ~08:00 local)
       (src/core/scheduler/temporal-wakeup.ts:798 outward phase)
        ↓  post-turn action kind 'intention.outbound_message'
heartbeat-post-turn-runtime handler (src/core/scheduler/heartbeat-post-turn-runtime.ts:962-1074)
  → dedupe via outreach outbox ledger (src/core/intention/outreach-outbox.ts)
  → provenance gate
  → TIME GATE: evaluateProactiveOutboundTimeGate
      (src/core/intention/proactive-time-gate.ts:109)
  → ProactiveOutboundDispatcher.dispatch (src/core/intention/proactive-outbound.ts:52)
      → channelType must be 'discord'                    ← hard-coded (line 76)
      → isApprovedPrimaryChannel(channelId)              ← allowlist = the single
        (wired main.ts:829: id === heartbeatChannelId)     configured heartbeat DM
      → rate limiter (scope 'proactive-outbound')
      → MessageSender.send → gateway.discordSend → DiscordAdapter.send
```

Key properties worth preserving in any voice extension:

- **Fail-closed target allowlist.** Broader channel resolution is explicitly
  deferred (comment in `main.ts:822-824` referencing future bead `1xb.2`).
- **Quiet hours already work.** `evaluateProactiveOutboundTimeGate` blocks with
  reason `quiet_hours` and returns `nextEligibleAtMs`, and the handler
  *reschedules* rather than drops. The window currently reuses the
  episodic-processing rest window (`config/scheduler.seed.json:11-17`,
  default **00:00–09:00 local**), timezone via
  `resolveActiveTimezone()` (`src/shared/time/active-timezone.ts`).
- **Ledgered delivery.** Every attempt lands in the outreach outbox JSONL with
  a terminal phase (sent/blocked/failed/skipped) — voice should ride the same
  ledger so a blocked voice attempt is visible and debuggable.

### 1.2 Voice output path — the push primitive already exists

The Wyoming/voice endpoint runtime moved out of PSFN into the Satellite Hub
(`src/boundary/gateway/voice-surfaces.ts:94-97` throws if `WYOMING_ENABLED`).
The hub (canonical copy `~/PSFN-Satellite-Hub`; the in-repo snapshot is stale)
has two transports, and **both can push audio unsolicited**:

- **ESPHome route** (Waveshare satellites, native API :6053):
  `hub/devices/voice_runtime.py:187-195` — `_speak_text` synthesizes TTS to a
  file, serves it via `StaticAudioServer`, then calls
  `send_voice_assistant_announcement_await_response(media_id=url, start_conversation=…)`.
  This is a *general announcement primitive*, not tied to a turn. It can even
  set `start_conversation=True` to open the mic after speaking — i.e. a
  proactive utterance can become a conversation. There's an ack path
  (`handle_announcement_finished`, `hub/voice_flow.py:115-118`) usable as a
  delivery confirmation.
- **Realtime WS route** (:8787): the protocol has downstream push types
  (`AudioOutMessage`, `ActionMessage` — `src/ts/shared/protocol.ts:148-166`)
  and the hub *already* pushes server-initiated events to devices via
  `CompanionBridge` → `relayCompanionEvent` (`src/ts/hub/server.ts:640-667`)
  for approvals/artifacts/tool activity. Capability vocabulary already includes
  `streamed_audio` output.

**Addressing exists.** PSFN's satellite registry (`satellites.json`,
`src/channels/backplane/satellite-registry.ts`) models satellite → endpoints
with auth, capabilities, and a **`placeId`** binding to the room ontology. The
hub's device registry (`src/ts/hub/device-registry.ts`) binds live `deviceId` →
`satelliteId`/endpoint. So "speak on the bedroom satellite" is expressible.

**The missing seam:** there is no PSFN-originated "announce to satelliteId=X"
event, and no PSFN→hub delivery channel keyed by satellite id. Today the hub
*pulls* companion events (SSE `GET /companion/events`) and reacts to inbound
turns/stimuli. The recently-landed **touch-stimulus path** is the exact inverse
template: hub POSTs typed stimuli to `POST /companion/stimuli`
(`src/channels/api/server/companion-touch-stimulus-route.ts`), authenticated by
satellite claim, rate-limited per (satellite, kind), with typed payloads only.

### 1.3 Presence, motion, rooms — mostly built

Sprint 10's location stack is substantially implemented:

- **Room ontology:** Site → Place → Affordance (`src/shared/contracts/places-registry.ts`),
  `config/places.seed.json` models the four rooms, each with a
  `binary_sensor.<room>_mmwave` **presence perceiver** — the cheap motion
  detectors are already first-class in the model.
- **Sensor ingress:** `POST /v1/telemetry/ingest` → bus topic
  `external.telemetry.ingested` (`src/shared/telemetry/sensor-ingest-port.ts:18`)
  → **sensor-cognition bridge** (`src/core/agent/perception/sensor-cognition-bridge.ts`)
  which authenticates the claimed origin fail-closed, maps satellite→place, and
  emits typed `PresencePerceptionEvent`s (it already understands
  detected/cleared/occupied/absent and mmwave binary-sensor states).
- **Conversation-follows-you:** `presence-follow.ts` sink auto-hands off the
  active emanation to the room where a confident, trusted presence event fired
  (bus topic `presence.emanation.follow`). This is precisely the "which device"
  logic proactive voice needs — it just currently drives *emanation handoff for
  an ongoing conversation*, not outbound initiation.
- **Durable location state:** companion presence store
  (`shared.companion_presence`, Postgres), situated self-model location
  (`src/core/self-model/state.ts` `situated.location`, ~6h staleness window),
  active emanation state.

**Gaps on this leg:**

1. **The actual sensor feed isn't flowing.** The motion detectors live behind
   Home Assistant, and the hub's `/internal/v1/home-assistant/*` proxy that the
   gateway is built to call (`src/boundary/gateway/methods/home-assistant.ts`,
   hub control :8788) **does not exist yet** — the hub README states "No Home
   Assistant is in the runtime path." Something has to relay HA motion state
   into `POST /v1/telemetry/ingest` (options in §2.1).
2. **No durable "partner last-seen place".** The contacts model still has only
   conversational `lastSeen`; the Sprint-10 stretch item (physical last-seen,
   E3) wasn't built. Presence events are consumed live but the "last place he
   was moving, and when" fact isn't persisted anywhere queryable at decision
   time.

---

## 2. Design sketch

### 2.1 Get motion state flowing (prerequisite)

Two viable relays, not mutually exclusive:

- **HA automation → telemetry ingest (fast path).** An HA automation on
  `binary_sensor.*_mmwave` state changes POSTs
  `{scope: 'presence', source, payload}` to `POST /v1/telemetry/ingest` with
  satellite claim headers. Zero new PSFN code — the bridge already parses
  mmwave payloads. Downside: HA needs a credential for the ingest endpoint and
  network reach to PSFN.
- **Hub as relay (fits the architecture).** The hub grows the
  `/internal/v1/home-assistant/*` control proxy it's already expected to serve
  (needed anyway for world control) plus an HA websocket subscription that
  forwards motion state changes to the ingest endpoint using its existing
  satellite identity. Keeps HA credentials in one place (the hub), matches the
  "hub is the transport layer" posture.

Either way, add a small **partner-presence projection**: persist
`(placeId, lastMotionAt, confidence)` for the primary partner from
`PresencePerceptionEvent`s — either a new tiny Postgres store next to
`companion_presence` or finally the contacts `physicalLastSeen` field. This is
the queryable fact the router needs.

### 2.2 The outbound seam: a typed "announce" event, PSFN → hub → satellite

Mirror the touch-stimulus seam in reverse, reusing the hub's existing pull:

1. PSFN emits a typed companion event `companion.announce`
   `{announceId, satelliteId, text, mode: 'announce' | 'announce_then_listen', reason}`
   on the existing SSE `/companion/events` stream the hub already consumes.
2. Hub resolves `satelliteId` → connected device (device registry / embodied
   session), synthesizes TTS with the *same voice it already uses for turns*
   (both hub routes own TTS today — PSFN should send text, not audio), and
   plays it: ESPHome route via `send_voice_assistant_announcement_await_response`
   (with `start_conversation=True` for `announce_then_listen`), realtime route
   via the existing `audio`/`action` push messages.
3. Hub POSTs a delivery ack back (`announceId`, played/failed/device-offline),
   analogous to the touch ack — PSFN marks the outbox entry terminal on ack,
   and a failure triggers the Discord fallback (explicitly, logged — no silent
   fallback, but this is a *delivery* fallback of an already-approved message,
   not a policy bypass).

Optional polish: a soft **chime before speech** so an unprompted voice doesn't
startle (hub-side, one config flag; the announcement primitive plays arbitrary
media so a chime-prefixed file is trivial).

### 2.3 Generalize the dispatcher: channel-typed delivery ports

`ProactiveOutboundDispatcher` currently hard-codes `channelType !== 'discord' →
blocked`. Restructure it as a registry of **delivery ports keyed by
channelType** (`discord`, `satellite_voice`), each carrying its own:

- **approval policy** — Discord keeps `id === heartbeatChannelId`; voice
  approves only satellites present in `satellites.json` whose endpoint declares
  an announce capability (add `announce` to endpoint `maxCapabilities`, exactly
  parallel to how touch is gated by the `touch` control cap).
- **rate limit scope** — new `proactive-voice` scope, stricter than Discord
  (unprompted speech is far more intrusive than a ping; something like 2/day to
  start).
- **quiet hours** — see §2.4.

The upstream handler (dedupe → provenance → time gate → dispatch → ledger)
stays untouched; voice entries ride the same outreach outbox.

### 2.4 Time gating: reuse the gate, give voice its own window

`evaluateProactiveOutboundTimeGate` is already channel-agnostic and handles
wrap-around-midnight windows and reschedule-to-next-eligible. Two changes:

1. **Decouple voice quiet hours from the episodic rest window.** Today the
   quiet window is borrowed from `episodicProcessing` (00:00–09:00). A Discord
   message at 23:30 is fine; a voice speaking in the bedroom at 23:30 is not.
   Add a distinct owner-file field in `scheduler.json`, e.g.
   `proactiveVoice: { quietStartLocalTime: "22:00", quietEndLocalTime: "09:00", timeZone: "local" }`,
   validated through the settings contract like everything else.
2. **Wall-clock is necessary but not sufficient — require motion recency.**
   The stronger "he's awake and around" signal is the motion detectors
   themselves: only speak if `lastMotionAt` for the target place is within N
   minutes (e.g. 10–15). This handles asleep-on-the-couch-at-3pm and
   went-out-for-the-evening, which no clock window can. Combined rule:

   ```
   speak_on(place) iff
     now outside voice quiet hours (local tz)
     AND partner lastMotionAt(place) within threshold
     AND satellite bound to place is online (hub liveness)
   else → deliver via Discord path (or reschedule, per trigger semantics)
   ```

### 2.5 Device selection: place-first, never wrong-room

Routing should be **place-first**: resolve the partner's current place from the
partner-presence projection (§2.1), then map `placeId → satelliteId` via the
registry binding, then confirm the device is actually connected (hub embodied
sessions / device registry — liveness is session-scoped today, which is
sufficient: the hub makes the final online check at delivery time).

Explicit non-goals worth writing down:

- **No "any online satellite" fallback.** Speaking in an empty room (or worse,
  the wrong occupied room) is strictly worse than falling back to Discord.
  Stale/absent presence → Discord, full stop.
- **Presence identity stays fail-closed.** The sensor-cognition bridge already
  refuses unauthenticated origins and the identity resolver won't fabricate
  identity. Motion alone says "someone is in the kitchen" — for a household of
  one this is acceptable to treat as the partner; if guests become a real
  scenario, voice content should be gated the way the trust model gates
  everything else (don't speak private content to an unrecognized presence).

### 2.6 Conversation continuity

A proactive utterance must land in the session record like any other companion
turn (the temporal-wakeup lane already appends internal frame notes before
outward dispatch — same discipline). If `announce_then_listen` opens the mic
and the partner replies, that reply arrives through the normal hub turn path
with `routing.source: 'satellite'` and the existing dual-presence
classification does the right thing (physical turn, room foregrounded).

---

## 3. Suggested build order

Each phase is independently shippable and fail-closed without the next:

1. **Presence feed** — HA motion → `/v1/telemetry/ingest` relay (§2.1) + the
   partner-presence projection. Verifiable on its own via the perception bridge
   telemetry counters (`agent.perception.bridge.telemetry`) and presence notes.
2. **Announce seam** — `companion.announce` event + hub playback via the
   ESPHome announcement primitive + delivery ack. Testable by hand-firing an
   event at the bedroom satellite; no trigger wiring yet.
3. **Dispatcher generalization** — channel-typed delivery ports, voice quiet
   hours owner, motion-recency + liveness routing rule, Discord fallback,
   outbox/rate-limit integration. At this point the existing triggers
   (appraisal `external`, morning wake) can choose voice automatically.
4. **Conversation mode** — `start_conversation` / announce-then-listen, chime
   polish, per-satellite announce capability rollout beyond the bedroom.

---

## 4. Open questions for the operator

- **Voice vs Discord: replace or record?** Recommendation: route selection
  (voice when present + awake, Discord otherwise), with the utterance text
  always recorded in the session either way. Ever both simultaneously? I'd say
  no — duplicated outreach feels like spam.
- **Voice quiet-hours window** — 22:00–09:00 proposed; pick real values.
- **Motion-recency threshold** — 10–15 min proposed.
- **Rate limit** for proactive voice — 2/day proposed to start.
- **Chime-before-speech** — yes/no, and which sound.
- **Should the morning wake lane prefer voice?** It's the most natural first
  user of this ("good morning" in the room he's actually in), and its quiet-
  hours interaction is trivially safe since it fires at 08:00.

## 5. Key file index

| Concern | Where |
|---|---|
| Outbound dispatcher (to generalize) | `src/core/intention/proactive-outbound.ts` |
| Delivery handler + gates | `src/core/scheduler/heartbeat-post-turn-runtime.ts:962` |
| Quiet-hours gate (reusable) | `src/core/intention/proactive-time-gate.ts` |
| Quiet-hours config today | `src/system/config/scheduler-config.ts`, `config/scheduler.seed.json:11` |
| Outreach ledger | `src/core/intention/outreach-outbox.ts` |
| Triggers | `appraisal/action-translation.ts:150`, `weighted-thought-outreach-lane.ts`, `temporal-wakeup.ts` |
| Satellite registry / placeId / capabilities | `src/channels/backplane/satellite-registry.ts` (`satellites.json`) |
| Touch-stimulus seam (template to invert) | `src/channels/api/server/companion-touch-stimulus-route.ts`, `companion-stimuli.ts` |
| Hub announcement primitive | `~/PSFN-Satellite-Hub/hub/devices/voice_runtime.py:187` |
| Hub push/event relay | `~/PSFN-Satellite-Hub/src/ts/hub/server.ts:640`, `src/ts/shared/protocol.ts:148-166` |
| Hub device registry / liveness | `~/PSFN-Satellite-Hub/src/ts/hub/device-registry.ts`, `embodied-session.ts` |
| Sensor ingress → perception | `src/shared/telemetry/sensor-ingest-port.ts`, `src/core/agent/perception/sensor-cognition-bridge.ts` |
| Conversation-follows-you | `src/core/agent/perception/presence-follow.ts` |
| Room ontology + mmwave perceivers | `src/shared/contracts/places-registry.ts`, `config/places.seed.json` |
| HA/world gateway method (hub proxy missing) | `src/boundary/gateway/methods/home-assistant.ts` |

*Caveat: the in-repo `PSFN-Satellite-Hub/` snapshot is stale (Jun 17); hub
references above are from the canonical `~/PSFN-Satellite-Hub` checkout.*
