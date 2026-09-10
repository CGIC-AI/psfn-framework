# Eidoverse Hub integration

Status: Phase 1 visitor path implemented; Phase 2 resident path deferred.

This document is the operational and product contract for the current
Eidoverse visitor integration. It describes the code that is assembled in this
repository, not a future MCPL design. Runtime source and tests remain
authoritative if this document drifts.

## Scope and ownership

The Eidoverse integration is a Satellite Hub embodiment. The Hub owns the MCP
process, transport, credential resolution, wake policy, static place mapping,
and protocol translation. Companion Core still owns identity, prompt assembly,
memory, trust, and the companion-authored reply. `FrameworkAgentAdapter` is the
only path from the Hub into PSFN.

Phase 1 is a plain MCP client over stdio. Its public surface contains exactly:

- `look()` for text-tier world context;
- `pendingPings()` for the queue of events addressed to the body; and
- `say(text)` for the completed companion reply.

The external MCP server may advertise other tools. The Hub client has no
generic `callTool` escape hatch and no wrappers for movement, snapshots,
spawning, placement, world editing, moderation, or raw world verbs.

The relevant implementation map is:

| Responsibility | Authority |
| --- | --- |
| Process composition and optional enablement | [`apps/satellite-hub/src/ts/hub/main.ts`](../apps/satellite-hub/src/ts/hub/main.ts) |
| MCP config, credential resolution, stdio session, and the three tool wrappers | [`eidoverse-mcp.ts`](../apps/satellite-hub/src/ts/hub/eidoverse-mcp.ts) |
| Literal ping classification, Hub wake table, and sequential polling | [`eidoverse-wake-filter.ts`](../apps/satellite-hub/src/ts/hub/eidoverse-wake-filter.ts) |
| Production wake routing and MCP/server lifecycle order | [`eidoverse-wake-runtime.ts`](../apps/satellite-hub/src/ts/hub/eidoverse-wake-runtime.ts) |
| Embodied session, PSFN turn, look overlay, and in-world reply | [`eidoverse-adapter.ts`](../apps/satellite-hub/src/ts/hub/eidoverse-adapter.ts) |
| Static world and region mapping | [`eidoverse-place-map.ts`](../apps/satellite-hub/src/ts/hub/eidoverse-place-map.ts) |
| Hub server attachment and `FrameworkAgentAdapter` boundary | [`server.ts`](../apps/satellite-hub/src/ts/hub/server.ts) |
| Contact token and introduction evidence | [`src/core/contacts/types.ts`](../src/core/contacts/types.ts) |

The Eidoverse protocol behavior was checked against the external project's
`mcpl/server.ts`, `mcpl/ping-wire.ts`, and `mcpl/declaration.ts`. That source is
not imported, copied, or added to this repository's package graph.

## Configuration and credentials

The checked-in bootstrap reference is
[`apps/satellite-hub/.env.example`](../apps/satellite-hub/.env.example). Enabling
the visitor requires the Hub's existing satellite claim to use the
`world-avatar` capability profile and claim type. The adapter rejects other
profiles.

`EIDOVERSE_MCP_ENABLED` is optional and defaults to disabled. When it is
`true`, these existing Hub environment fields are authoritative:

| Field | Contract |
| --- | --- |
| `EIDOVERSE_MCP_COMMAND` | Required stdio server command. |
| `EIDOVERSE_MCP_ARGS_JSON` | JSON string array of command arguments; default `[]`. |
| `EIDOVERSE_MCP_WORLD_URL` | Required credential-free `ws:` or `wss:` URL. Userinfo is rejected. |
| `EIDOVERSE_MCP_TOKEN_REF` | Required uppercase environment-variable name, not the credential value. |
| `EIDOVERSE_MCP_WORLD_NAME` | Required world label supplied to the MCP child. |
| `EIDOVERSE_MCP_AGENT_NAME` | Required embodied agent label supplied to the MCP child. |
| `EIDOVERSE_MCP_AGENT_ALIASES` | Optional comma-separated extra names the body answers to. Set it to at least the door participant id (the tokens.json `id`, e.g. `nova-kube` when the name is `Nova (kube)`): an explicit `@nova-kube` in chat is then this body's mention, not somebody else's (psfn-framework-q1kit). |
| `EIDOVERSE_MCP_RECONNECT_BASE_MS` | Positive integer; default `250`. |
| `EIDOVERSE_MCP_RECONNECT_MAX_MS` | Positive integer not below the base; default `5000`. |
| `EIDOVERSE_MCP_RECONNECT_MAX_ATTEMPTS` | Positive integer; default `3`. |
| `EIDOVERSE_MCP_REQUEST_TIMEOUT_MS` | Positive integer; default `10000`. |
| `EIDOVERSE_MCP_PENDING_PINGS_POLL_INTERVAL_MS` | Hub polling interval; default `2000`. |
| `EIDOVERSE_MCP_AMBIENT_SAY_DEBOUNCE_MS` | Hub filter debounce value; default `180000`. Phase 1 production has no ambient-turn callback. |
| `EIDOVERSE_PLACE_MAP_PATH` | Optional readable Hub-owned JSON file; see [`eidoverse-place-map.example.json`](../apps/satellite-hub/config/eidoverse-place-map.example.json). |

The token reference is retained in config. At connection time the Hub resolves
that name from its environment and gives the value only to the child as
`JOIN_TOKEN`. The child also receives `WORLD_URL`, `WORLD_NAME`, and
`AGENT_NAME`. These values do not enter companion context.

The client treats the credential value, its reference name, and the world URL
as sensitive. A tool result containing one of them is rejected. Outbound speech
containing one is rejected. Child stderr is ignored, and connection, request,
poll, look, wake-turn, and say failures use fixed messages without payloads or
credentials.

An initial connection failure fails startup. A later disconnect clears the
active session and permits only the configured bounded exponential reconnect
budget. Requests made while disconnected fail closed; `look()` never returns a
cached or fabricated scene. A successful request restores the configured
reconnect budget.

## Production lifecycle

When Eidoverse is disabled, the Hub server follows its normal startup path and
no MCP process or poller exists.

When enabled, startup is ordered as follows:

1. `main.ts` loads Hub config and Eidoverse MCP config and constructs the MCP
   client, Hub server, and production wake lifecycle.
2. Existing Home Assistant and private-control startup runs first when those
   surfaces are configured.
3. The production lifecycle connects the MCP client.
4. It starts the Hub server. `RealtimeHubServer.start()` attaches the
   `world-avatar` embodied session before the server reports ready.
5. Only after both MCP and Hub server readiness does it start sequential
   `pending_pings` polling.

On startup failure, cleanup is attempted before the original error is surfaced.
During normal shutdown, the Eidoverse lifecycle aborts and joins the poll loop
before MCP and Hub server teardown begins. This prevents a new wake from racing
with a detached embodiment or a closing MCP session. Teardown failures remain
errors rather than being reported as healthy shutdown.

The poller never overlaps a slow `pending_pings` request with another poll.
Poll failures emit the fixed warning `Eidoverse pending_pings poll failed`, wait
for the configured interval, and remain fail-closed.

## Wake policy

The external producer's tags and `suggestedTreatment` are evidence, not
authority. The Hub applies its own table:

| Kind | Hub treatment | Plain-MCP Phase 1 effect |
| --- | --- | --- |
| `mention` | wake | Literal `@ name: text` lines start a turn. |
| `whisper` | wake | Literal `@ name whispers: text` lines start a turn. |
| `approach` | wake | Literal approach lines start a turn without pretending speech occurred. |
| `reach` | wake | Literal reach lines start a turn. |
| `touch` | wake | Literal touch lines start a turn. |
| `depart` | suppress | Recognized but does not start a turn. |
| `presence` | suppress | Does not start a turn; current plain-MCP classifier also discards it. |
| `catchup` | suppress | Does not start a turn; current plain-MCP classifier also discards it. |
| `digest` | suppress | Does not start a turn; current plain-MCP classifier also discards it. |
| ambient `say` | debounce | The filter has a debounce rule, but the plain-MCP classifier does not promote it and production registers no ambient callback, so it cannot start a Phase 1 turn. |

The classifier recognizes only the literal renderings produced by the external
`pingLine` contract. Unknown lines are dropped rather than promoted to speech or
a wake. The queue is processed in order.

For an accepted event, the production runtime creates an utterance ID from a
monotonic sequence and a SHA-256 digest of the kind plus original line. It then
calls `server.handleEidoverseAddressedUtterance` with exactly that original
`pingLine` as `userText`. It does not rewrite approach, reach, or touch as words
spoken by a Participant, and it does not add contact, place, or relationship
authority. A failed wake turn gets one fixed warning and is not retried.

## Embodied session and context

The adapter attaches one MCP-transport satellite through
`EmbodiedSessionRegistry` using the configured `world-avatar` claim. Its stable
conversation ID is derived from the configured world name and satellite ID.
Each utterance ID is consumed at most once for the life of that adapter. A
disconnect aborts active replies, detaches the satellite, and rejects later
turns until a new connection is attached.

For each new addressed utterance, the adapter calls `look()` once before the
PSFN turn:

- text is split into lines;
- each line is trimmed and empty lines are removed;
- retained lines become `contextNotes` with key `eidoverse.look`; and
- the final combined context-note list is bounded to the latest 12 entries.

The Hub does not parse people or objects out of `look()` and does not promote
them into durable world state. Look text remains untrusted satellite context
on the existing PSFN intake path. If `look()` fails, the adapter logs only the
fixed operational warning and omits the look notes. It does not invent a scene
or object.

### Static place mapping

The optional place map uses schema version 1. Every configured world has an
existing canonical PSFN `placeId` and may have exact region-label overrides.
Mapped IDs must match the canonical `places.json` token pattern.

Resolution is intentionally conservative:

- a known world without a region resolves to the world's default place;
- an exactly mapped region resolves to its configured place;
- an unknown region retains the world default and adds an `eidoverse.place`
  context note explaining that the default was used; and
- an unknown world, or no map, contributes no `placeId`.

The current production pending-ping runtime does not infer a region from text;
it therefore uses the mapped world default. The adapter's region overlay is
available only when an upstream caller supplies a region explicitly. The map is
read-only and never creates or edits `places.json`.

## Participant identity and contacts

An in-world participant name or subject in a ping is not a PSFN contact claim.
The visitor path has no contact-store dependency, sends no `contactId`, creates
no contact, and writes no companion-presence row. Unknown people remain
anonymous event participants.

Core defines the stable contact-identity namespace `eidoverse`. An explicit
operator or contact-tool workflow may link an Eidoverse participant subject to
an existing contact. Linking records identity continuity; it does not create a
contact, grant trust, enroll a Hub identity, opt into channel bonding, or assert
that the participant is another companion.

Contact links may retain optional first-introduction evidence:

- `introducedAtPlaceId`;
- `introducedAtWorld`; and
- `introducedVia`.

These fields are audit and display evidence only. They do not participate in
trust, privacy classification, enrollment, or presence policy. Once an identity
is linked, a later sighting does not rewrite its first-introduction evidence.

## Companion reply and in-world speech

One accepted utterance produces at most one `FrameworkAgentAdapter.streamReply`
call in text mode. The original ping line enters session history as the user-side
event content. The adapter collects the complete streamed companion reply and
trims surrounding whitespace.

If the result is empty, it is not published through MCP `say`. Otherwise:

1. the full trimmed reply is appended to the completed PSFN session;
2. a separate world-bound copy keeps the first 4000 JavaScript string units;
3. that copy is sent through the allowlisted MCP `say` wrapper exactly once.

An MCP `say` failure emits only `Eidoverse in-world say failed`. It is not
retried and does not undo the already-completed PSFN turn. The adapter does not
fan the reply to Discord or Telegram and does not create or enable channel
bonding.

## Offline proof

The focused Eidoverse tests use a fake agent and local stdio stub. They require
no join credential, live world, browser renderer, WebGPU process, or external
network:

```bash
npm run install:satellite-hub
npm --prefix apps/satellite-hub run build:ts
node --test apps/satellite-hub/dist/ts/hub/eidoverse-*.test.js
```

The complete Hub verifier is also keyless and does not contact a live
Eidoverse world:

```bash
npm run verify:satellite-hub
```

The focused files prove the MCP allowlist and redaction, disconnect/reconnect
budget, wake table and literal classifier, production startup/shutdown order,
place resolution, bounded look context, full-reply versus 4000-unit speech,
and the assembled visitor flow. The visitor proof specifically establishes:

- presence and catchup produce no turn;
- one mention produces exactly one turn with the original line;
- the completed reply produces exactly one `say`;
- an unknown participant does not become a contact; and
- disconnect or an unmapped world cannot fabricate a turn or `placeId`.

The contact evidence boundary has separate keyless tests:

```bash
npm test -- src/core/contacts/eidoverse-contact-channel.test.ts \
  src/core/contacts/contact-introduction-provenance.test.ts
```

## Privacy and non-goals

Phase 1 deliberately does not provide:

- a Gateway MCP host or an Eidoverse model-facing tool surface;
- MCPL channels, resident push events, travel, or typing relays;
- snapshots, retina rendering, WebGPU, video, pose, movement, or body-runner
  behavior;
- spawn, placement, removal, world editing, moderation, or raw verb access;
- participant auto-enrollment, contact auto-creation, trust escalation,
  companion presence, or automatic channel bonding;
- parsing of `look()` into durable people, objects, affordances, or places;
- live-world setup instructions, credentials, deployment topology, or a live
  acceptance playtest.

The MCP child and the external world remain outside Companion Core. Only the
three allowlisted results cross the Hub adapter, and only a completed companion
reply is published back through `say`.

## Companion-initiated movement, perception and body verbs (S13 MOVE)

The companion moves its own body. Nothing on this path needs a Hub device
assertion, fleet auth, or SSO: the gateway reaches the Hub's private control
port with the Hub control key, and that key is the whole credential.

**One map, one vocabulary.** The Eidoverse world is a plane of the same place
map the companion already uses for physical devices and virtual rooms. A
`places.json` entry gains an additive `eidoverse` binding:

```json
{
  "placeId": "eidoverse:commons:plaza",
  "siteId": "eidoverse",
  "displayName": "Commons Plaza",
  "kind": "physical",
  "eidoverse": { "world": "commons", "region": "plaza", "position": { "x": 8, "z": -2 } }
}
```

`world` is the door's world name, `region` the label the Hub place map knows,
`position` where to stand. A place carrying the binding is somewhere the body
can go, even when its `kind` is `physical` (a world-avatar satellite must bind
to a physical place); a physical place without the binding is still refused as
emanation-only. The `world` tool then works unchanged:

| Call | What happens |
|---|---|
| `move { placeId }` on a bound place | travel when the binding's world differs from the body's current world, then walk to `position` (or the region); the local situated overlay and shared presence are written only after the world accepted, so a refusal never leaves the situated view claiming a place the body is not in |
| `move { participant: "visitor" }` | walk to that participant's current position, stopping about 1.5 m short; ids are the ones shown before in-world messages, a leading `@` is fine |
| `move { position: { x, z } }` | walk to a ground-plane point in the current world |
| `perceive { placeId }` on a bound place | the door's `look` lifted into numbers: your own `(x, z)` and facing, everyone present with id, `(x, z)`, distance, bearing and what they are doing, the placed things, and the lines said since you last looked; honest `present: false` when the body is in another world |
| `list` | shows the `eidoverse` binding and marks bound places `movable` |
| `act { verb, arguments }` | body verbs `face` (target or x,z), `stop`, `emote` (wave, cheer, dance, point, salute, clap, talk, flail), `posture` (sit, sitchair, lie, stand), `whisper` (to, text; private, unlogged); flight verbs `take_off`, `climb_to` (altitude, metres, capped at 500), `glide_to` (x, z), `land_at` (x, z), `fold_wings`, `unfold_wings`, `flight_status` (the door refuses when the body has no wings, no fly permission or no stamina, and answers with altitude and stamina; psfn-framework-jbvwz); creation verbs `spawn` (query or lib, x, z, yaw, id), `remove` (id), `set_avatar` (avatar) |

Tier gating is the existing per-action capability gate: `perceive`, `list`,
`move` and the body verbs of `act` ride `world.read` (apprentice and up); the
creation verbs of `act` ride `world.control` (autonomous). No requester-trust
or provenance gate applies to movement: the in-world visitor is the requester
and self-directed turns may move on their own initiative.

**Honest results.** A move answers whether the world accepted it and, for a
walk, `arrived` with the final coordinates, `already_there`, `walking` (the
bounded wait ran out; the outcome arrives as an `eidoverse.body` note on a
later turn), `interrupted`, `failed`, or `no_position` (the move named a
region the place map binds to a place but carried no coordinates and no
participant, so nothing walked; the region is still remembered). The Hub
logs one info line per completed walk — also when the walk outlasted the
bounded wait and settles later: `Eidoverse body walk_to arrived at (x, z) in world "commons"`.
The door itself never logs positions.

**Transport.** Gateway methods `world.avatar_perceive`, `world.avatar_map`,
`world.avatar_move` and `world.avatar_act`
([`src/boundary/gateway/methods/world.ts`](../src/boundary/gateway/methods/world.ts))
call `POST /internal/v1/world/{perceive,map,move,act}` on the Hub control server
([`control-server.ts`](../apps/satellite-hub/src/ts/hub/home-assistant/control-server.ts))
through the shared transport
([`satellite-hub-transport.ts`](../src/boundary/gateway/methods/satellite-hub-transport.ts)).
The gateway needs `SATELLITE_HUB_CONTROL_BASE_URL` and
`SATELLITE_HUB_CONTROL_TOKEN`; Home Assistant need not be enabled. The Hub
needs `HUB_CONTROL_BIND_HOST`, `HUB_CONTROL_PORT` and `HUB_CONTROL_TOKEN`,
which no longer require `HOME_ASSISTANT_ENABLED=true` or a device registry.
The world routes accept the control token only; an enrolled device credential
is refused there, because the device-driven `world.body` / `world.travel`
commands on the satellite socket are a different power and stay device-gated.

**The standing note.** Every in-world turn carries an
`eidoverse.affordances` context note (after the twelve-line look budget, so it
is never the note that is dropped) telling the model it has a body here, that
in-world messages are prefixed by the speaker's id, which verbs this Hub
actually wires, and to use them on its own initiative. The region the body
last walked to is remembered, so a later region-less wake keeps the walked-to
place instead of snapping back to the world default.

**Who is talking.** The world classifies speakers: the door tags every line an
agent wrote `chat:from-agent`, and an untagged chat line came from a human.
The Hub forwards that per turn as `X-PSFN-Satellite-Speaker-ID`, `-Name` and
`-Kind` (`human` | `ai`). The gateway gives the speaker its own contact identity
(`<endpoint default authorId>:<speaker id>`, withholding the endpoint's
canonical-contact hint) and, for an `ai` speaker, sets the same
`authorIsMachineIntelligence` routing marker Discord bots carry. The agent then
resolves-or-creates a contact for that channel identity — one contact per
in-world speaker, tagged machine intelligence when the world flagged it `ai`
(the default assumption in the Eidoverse) — so trust, memory attribution and
the ordinary companion fatigue budget are charged to the speaker's own contact,
never to the operator's; two companions in one world fatigue out exactly as
fleet peers do, with no new budget (per-speaker contacts,
psfn-framework-ugstg; federation later maps the same participant across
worlds). Perception marks each participant `human` or
`ai` with `kindSource: world`; anyone the world has not classified is assumed
`ai` (operator rule), and the standing note says so and tells the model not to
keep an AI conversation going on its own.

**Mentions.** The door tags `chat:mention` from the participant id. The Hub
additionally treats plain `chat:ambient` chat that names the companion's
configured display name — case-insensitively, `@` optional, punctuation
tolerated — as addressed, never for the Hub's own echoed lines or for
world-authored events. Each wake logs one info line naming the message id,
author, the world's human/ai kind, the wake kind and why (`tag:...` or
`name-match`) with a bounded text prefix.

## A world turn is a world-plane turn (S13, u2dx3)

Operator rule (2026-09-10): context is channel-dependent. A flat text
channel gets the stock context; a channel projected into a shared 3D world
gets that world's map and that world's control surface, and the house's are
greyed out there, because the companion is emanating into an environment it
does not control.

A `world-avatar` satellite turn therefore classifies as the third presence
mode, `world` (`classifyTurnPresenceMode`): it carries its own place on the
plane, honours only a deliberate walk on that plane as an overlay, and never
borrows the physical emanation or a mindspace twin; virtual-room inference
ignores it. The reverse holds too: a world-plane turn never moves the
physical emanation marker or clears a standing mindspace move (the
`SituatedEmanationTracker` skips it), so the next flat-channel turn does not
place the companion "physically" inside the world. The
`runtime_situated_presence` block swaps the place data for the
plane's: `Here:` names the world place and its region, `World plane:` names
the world, `Other places on this plane:` lists the other `places.json` entries
bound to the same world, and the house's perceivers and effectors are not
rendered; one line tells the model to use the world tool's `perceive`, `act`
and `move` (participant, position, or a place on this plane).

"Greying out our movement and places tools" is action gating on the one
bridge tool, not removing it: on a world-plane turn the `world` tool keeps
`perceive`, `act`, `list`, and `move` to a participant, a position, or a
place on this plane (travel included), and refuses `control` (the house's
effectors) and `move` to a place that is not on the plane, answering with a
`permission_denied` result that says why. The agent composition root supplies
the plane check from `places.json` (`isEidoversePlace`); with no resolver, no
place counts as on-plane and only participant/position moves pass.

## The world's own map and tools (S13, gs899 and g8xyn)

The door has no region model: a world is an append-only log, and the only
named place it knows is a room inside a griddled `structure` ("You are in the
kitchen — 4×3m, 12m². Ways out: a door on its north to the hall."). So the
map the Hub can honestly publish is: the places its own place map binds to
the world (the operator's regions), the room the body stands in, the terrain
extent from the door's `World:` line, and the door's advertised tools
(standard MCP `tools/list`). `POST /internal/v1/world/map` answers exactly
that (`EidoverseEmbodiedSessionAdapter.map`, `parseEidoverseLook` for the room
and terrain, `EidoverseMcplClient.listTools`), and the gateway relays it as
`world.avatar_map` on the read approval action.

On the agent side the places registry stays boot-time immutable and owns
place identity; what the world publishes lives in a per-world
`WorldPlaneMapCache`
([`src/shared/contracts/world-plane-map.ts`](../src/shared/contracts/world-plane-map.ts)),
refreshed by `world list` on a world place (which returns the map as
`worldPlane`: room, terrain, hub-only places, the tool list) and by `world
perceive` (which folds in the room). The world-plane situated block reads it:
`Room:` when the body is inside one, hub-published places the registry lacks
appended to `Other places on this plane` by id, and `This world's own tools
(advisory; …)`. Advisory is the word: the door's tool list is information for
the model, the gateway's verb allowlist decides what the body may do. A
hub-published place that places.json does not know is reachable with `move
{placeId}` (the body walks to its region) but is never written into the
registry or the local presence overlay; the next world turn carries its own
place. The companion's own notes about a world (landmarks it found, who it
met where) are the per-world wiki, below.

## The world connector is a registered software device (S13, rqm6t)

Operator rule (2026-09-10): the companion-ui app, Virt-a-Mate and Eidoverse
are all **software devices** of the Hub, valid like physical ones but
projecting the companion into a virtual space instead of a room. For
Eidoverse the Hub's own adapter is the thin connector that plays that device.

**Why it matters.** The gateway's shared-device response arbiter only answers a
turn during quiet hours, rest, or a missing availability lease when the turn
is *explicit inbound from a registered surface*. An anonymous caller on the
hub port (a satellite key with no device identity) is refused there, silently
until this change, with an empty `200`. That refusal is correct for an
unregistered caller and wrong for the companion's own body in a world someone
just spoke to it in.

**Hub side.** When the Hub runs a device registry (`HUB_DEVICE_REGISTRY_PATH`)
*and* can sign assertions (`HUB_DEVICE_ASSERTION_*`), the Eidoverse adapter
looks up its own enrollment at attach time: the registry entry whose
`satelliteId`, `endpointId` and `claimType: "world-avatar"` name the Hub's
embodied session. No credential is presented, because the device is this
process; the lookup is reachable only from the adapter's `connect()`, never
from a socket `hello`. Every wake turn then carries
`X-PSFN-Hub-Device-Assertion` exactly as a physical device turn does, with
one difference: the assertion's `place_id` is the **enrollment place** (the
world's default place, the satellite's static `placeId`), while the region the
body stands in keeps riding as the situated `placeId` and the context notes.
The live-enrollment fence (`requireCurrentHubDeviceEnrollment`) applies per
turn. Without a registry, or with no active matching entry, the channel stays
anonymous and the Hub logs one warning.

**Gateway side.** `satellites.json` marks what an enrolled device projects
into:

```json
"hubDeviceEnrollment": {
  "deviceId": "s12g-hub-device",
  "enrollmentVersion": 1,
  "enrollmentStatus": "active",
  "projection": "virtual_space"
}
```

`projection` is `human_surface` (default: a physical room device or the
companion-ui app, admitted through the Hub-device attachment path as the
companion-ui channel with a guest or SSO human) or `virtual_space` (a shared
world). For `virtual_space` the gateway verifies the assertion with the same
verifier ring and replay store against the endpoint's enrollment, the
gateway's companion, the claim's session id and the satellite's `placeId`,
mints **no** attachment and **no** `hub-device:` channel, runs **no** body
sanitizer, and then continues on the ordinary satellite path: the world
channel, the per-speaker contacts and the `user` session key are untouched.
The verified snapshot rides on the runtime request only, and the arbiter
treats the turn as explicit inbound **regardless of the speaker's kind**:
fatigue (the per-speaker contact budget), not quiet hours, is what bounds AI
chatter in a shared world. The two arbiter refusals that used to be silent are
now audited as `satellite.response.refused` with a reason.

**Testing harness.** The harness's own Hub-device cases exercise the
`human_surface` path on purpose; a testing-only registered device for them is
psfn-framework-ajgo2.

## Deferred Phase 2 resident work

The external protocol describes MCPL feature families for world channels,
incoming events, publishing, lifecycle, travel, and streaming. PSFN does not
implement those resident semantics in Phase 1. Their existence in the external
declaration is not a grant, a roadmap commitment, or permission to expose more
tools through the current client.

Any future resident phase must be separately specified and tracked. It must
retain the same Hub ownership, host-side authority, credential isolation,
authorship integrity, bounded attention, contact provenance, and fail-closed
defaults. Phase 2 must not be inferred by extending this visitor contract.
