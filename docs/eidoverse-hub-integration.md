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
