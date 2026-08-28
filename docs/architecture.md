# Architecture

Last updated: 2026-07-12.

This is the current runtime shape. For the component graph, see [`docs/architecture-diagram.mmd`](./architecture-diagram.mmd). For the end-to-end anatomy of a single chat turn (inbound queueing, in-turn continuations, reply disposition, post-turn lanes), see [`docs/chat-turn-lifecycle.md`](./chat-turn-lifecycle.md). For current feature status and active work, see [`docs/development-status.md`](./development-status.md). Historical sprint snapshots (Sprint 8 architecture report, Sprint 9 reviews) are archived off-repo with the working-docs archive.

## Canonical Runtime Model

- `src/app/startup/index.ts` is disabled and exits fail-closed.
- `src/app/gateway/main.ts` is the host-side process. It owns secrets, outbound network access, policy checks, SSRF defense, confirmation queues, audit logging, gateway-backed tool execution, intake screening for boundary-crossing content, and the public OpenAI-compatible API edge.
- `src/app/operator/main.ts` is the operator-plane process. It hosts Garden HTTP/UI and proxies admin traffic over the private admin transport.
- `src/app/agent/main.ts` is the isolated agent process. It loads companion state, enforces startup network isolation, connects to the gateway over the Unix socket, and runs the companion loop plus the private admin transport.
- `src/app/cert-manager/main.ts` is an optional sidecar process hosting the private CA for the satellite backplane: a token-authenticated loopback API (`npm run cert-manager`) that issues and auto-renews the mTLS certificates `satellites.json` client-cert bindings pin. It shares only `src/shared/` with the runtime. See [`docs/certificates.md`](./certificates.md).

```text
External channels / API / Garden
        |
        v
Gateway process
  - secrets, provider credentials, outbound network
  - LLM and embedding clients
  - URL, filesystem, shell, git, vault, beads, media policy
        |
        | JSON-RPC over Unix socket
        v
Agent process
  - companion loop, prompt stack, memory/retrieval
  - scheduler, post-turn work, internal state
  - private admin transport and model-facing tools
        |
        v
PostgreSQL + JSONL/session files + owner-file roots
```

### Runtime terminology

A **PSFN installation** may host one or more peer Companion Cores. A
**Companion Core** owns the authoritative identity-and-continuity state of
exactly one companion; the isolated OS process that runs it is an **agent
process**. A peer companion has
its own root identity and is not a shard, subagent, or satellite.

This is architectural authority, not a consciousness claim. The runtime can
observe behavior and persisted state, store companion-authored self-reports,
and derive explicitly labelled models; none of those alone proves inner
experience.

The **Gateway** is the Core's privileged policy/credential edge. The
**Satellite Hub** is an endpoint transport and relay service; a **satellite** is
a device/app endpoint, an **embodiment** is the form through which a companion
is perceived, and **emanation** is that companion's active situated presence in
an embodiment. CogSec is the cross-boundary cognitive-security system; its
intake firewall is only its pre-hoc half.

## Composition Layer

Shared runtime construction is concentrated in:

- `src/app/startup/composition/composition.ts`
- `src/app/startup/composition/parity.ts`
- `src/app/startup/composition/post-turn-actions.ts`
- `src/app/startup/composition/channel-runtime.ts`

Those helpers keep the split runtime and shared wiring aligned on core wiring:

- identity loading
- session runtime
- memory runtime
- prompt/runtime settings surfaces
- shard and analysis workbench tooling
- heartbeat/scheduler wiring
- channel adapter manifests

## Gateway Responsibilities

`src/app/gateway/main.ts` builds the privileged edge:

- `GatewayServer` exposes JSON-RPC over the NDJSON Unix socket.
- `LLMClient` and embedding creation happen on the gateway side so provider secrets stay out of the agent.
- Gateway policy resolves filesystem scope, URL policy, SSRF checks, and approval-gated actions.
- The native external MCP client, credential custody, TLS transport, system-trust
  policy, and CogSec boundary all live in the gateway.
- Optional operator-facing support surfaces live here too: ntfy notifications, confirmation queue, beads tools, vault tools, shell execution, and git-backed mutations.
- Discord, Telegram, Wyoming, and installable channel plugins (Multica and Buzz) are started from the gateway side when enabled.

### Gateway RPC trust and approval classes

The default Unix-socket transport is a single-host trust boundary. The gateway
sets the socket mode to `0770`; access is therefore delegated to the operating
system owner/group assigned to that socket. Unix transport frames do not carry
TLS identity or repeat caller credentials on every RPC. Processes with socket
filesystem access are trusted to reach the connection protocol, so deployments
must not grant that owner/group to unrelated workloads. WSS is the remote-host
alternative and requires mutual TLS plus the configured peer SPIFFE identity.

In a companion cluster, filesystem admission is not companion ownership. An
agent connection must identify once with its role-bound companion credential;
the gateway then binds that connection to exactly one manifest companion. An
unknown companion, missing or wrong-role credential, duplicate live owner, or
attempt to re-identify as a sibling is rejected. Subsequent RPC authorization
uses that immutable connection binding rather than caller-supplied companion
parameters.

Gateway policy distinguishes two escalation decisions:

- `AUTONOMOUS_TIER_REQUIRED` may execute directly only for the authenticated
  companion's autonomous tier; lower tiers enter the durable Garden approval
  queue.
- `REQUIRES_HUMAN_APPROVAL` enters that queue at every tier. Home Assistant
  operations outside the explicit autonomous affordance and all generic git
  mutations are in this class.

Unknown policy decisions deny. If a queued confirmation cannot reach Discord or
ntfy, the request remains inspectable in Garden and the Approval Notifications
runtime-health subsystem becomes unavailable with the delivery error.

## Agent Responsibilities

`src/app/agent/main.ts` builds the companion runtime:

- loads config, owner-file state, and trust policy
- initializes PostgreSQL-backed companion runtime stores through `createAgentPersistenceRuntime`
- loads the character card and prompt registry
- composes `SessionManager`, `SubstrateAgent`, `MemoryStore`, `MemoryRetriever`, `MemoryExtractor`, `Scheduler`, the gateway-routed API backend, and the private admin transport
- wires contacts, values, skills, safeguards, core memory, subagents, shard internals, analysis workbench tools, media/journal/wiki tools, and post-turn actions
- exposes the parent `repo` projection as read-only at every capability tier;
  a future mutable repository or self-modification path requires its own
  explicit authority contract rather than this generic approval queue

The agent talks to the gateway through `GatewayClient`, which acts as the LLM and embeddings provider inside the isolated process.

## Core Subsystems

### Sessions and context

- L0 session history is append-only JSONL under `sessions/`.
- The archive/projection split is intentional: canonical archive truth stays in JSONL, while fast-search copies belong behind projection/search ports.
- `SessionManager` handles the sliding active context window, token budgeting, continuity, internal role envelopes, focus knowledge, observation masking, and prompt-aware context assembly.
- Auto-compaction is a durable between-turn background job driven by the configured session-history budget. It summarizes older selected context into untrusted carry-forward notes, retains a recent verbatim tail, and leaves canonical L0 history intact. Foreground assembly never starts the rolling-summary model call; it uses the latest committed summary plus deterministic bounded history while work is pending.
- Session integrity can be HMAC-backed in split mode through the gateway-provided integrity provider.

### Memory

- Runtime memory/session composition requires PostgreSQL-backed ports.
- SQLite-backed stores and migration readers are removed; runtime and maintenance composition use PostgreSQL-backed ports, while focused tests may use port fakes.
- `EpisodicStore` owns the L0.1 `l01_episodes` and `l01_episode_arcs` tables. These records are bounded landmarks with L0 span/artifact provenance, not generic transcript summaries and not L2 typed memories.
- `EpisodicSynthesizer` runs from the gated episode-synthesis lane (scheduler timer or turn threshold, then a deterministic new-messages + relevance-minimum gate). It can create multiple candidate episodes for one day and links longer themes as graph arcs; nightly rest-window sleeptime consolidates them.
- `MemoryRetriever` combines L0.1 landmark-chain retrieval, semantic retrieval, lexical fallback, trust filtering, emotional continuity, and optional compositional reranking.
- `MemoryExtractor` runs post-turn extraction, crash-recovery extraction, compaction extraction, Recent Contact Shape refresh, and typed biographical-candidate admission flows.
- Garden exposes episodic memory through a dedicated operator page for episode, provenance, arc, and thread inspection.

See [`docs/memory.md`](./memory.md) for the memory contract.

### Identity and prompts

- Character card loading and prompt composition live under `src/core/identity/`.
- Prompt layers, prompt registry entries, north-star state, and core memory are persisted in companion-owned files.
- Admin surfaces mutate prompt/runtime state through the JSON owner-file contract rather than through `.env`.

### Trust, safeguards, and capabilities

- Trust policy is loaded from `trust-policy.json`.
- Channel privacy vocabulary is `private | invite_only | public` plus a `broadcast` flag; the Context Envelope contract (dimensions, derivation, precedence, migration) is documented in [context-envelope.md](./context-envelope.md).
- Eligibility gates and capability tiers are enforced before privileged tools run.
- Safeguards audit cooling-off, restart protection, and external communication rate limits.

### Cognitive security (intake firewall)

- Untrusted inbound content — web fetches, parsed documents, image OCR
  transcripts, tool observations, and voice transcripts — is wrapped in a
  taint-tracked `IntakeEnvelope` (`src/shared/contracts/intake-envelope.ts`)
  and screened before it can reach prompt assembly, memory, wiki, persona,
  trust state, or tool egress.
- Screening composes on both sides of the socket: the gateway builds the full
  L1 deterministic scanner pipeline plus the optional in-process ONNX
  injection classifier (`src/boundary/gateway/intake/compose-screening.ts`);
  the agent process runs an L1-only screening service for in-process surfaces
  (`src/app/agent/main.ts`). Inbound images are screened through the
  `intake.screen_image` gateway RPC.
- Seven sink gates (`src/core/cogsec/intake/sink-gates.ts`,
  `src/core/session/intake-sink-gating.ts`) consume envelope state/labels,
  including strict managed-skill write screening and a lethal-trifecta
  assessment on tool egress; a per-session canary token
  (`src/core/cogsec/canary/`) plants an egress tripwire at the gateway.
- Quarantined items are held in a durable store and resolve only through the
  Garden Cognitive Security queue with a server-side double-confirm release.
- Rollout mode is owned by `intake-policy.json` (`off`/`shadow`/`enforce`;
  the seed ships `shadow`, which screens and journals but changes no delivered
  content). Companion-facing firewall notices use fixed, operator-reviewed
  wording and are structurally excluded from emotion appraisal and memory
  candidacy.

See [`docs/cognitive-security.md`](./cognitive-security.md) for the threat
model, layer-by-layer contract, quarantine lifecycle, and operator runbook.

### External MCP client

PSFN is the MCP host and client; external MCP servers are untrusted capability
providers, never an alternate way to expose companion internals. The gateway
owns one protocol client per `(companion, server)` session and uses the official
TypeScript SDK's Streamable HTTP transport over HTTPS/TLS. Gateway credential
custody, DNS/IP policy, TLS verification, redirect denial, response bounds,
authentication, companion authorization, capability checks, trust ceilings,
per-tool allowlists, and confirmation all remain outside the agent process.

The model sees one stable first-party tool named `mcp`, not one injected tool
definition per remote server. Its actions form a staged-loading boundary:

1. `catalog` reads operator-owned server summaries without connecting.
2. `search` lazily connects only to eligible servers and returns screened tool
   summaries.
3. `inspect` returns one screened input schema only when selected.
4. `call` rechecks server/tool/capability/sensitivity/confirmation policy and
   returns only a CogSec-screened result.
5. `release` closes the selected session and drops its loaded schemas. Idle TTL
   and companion disconnect perform the same unload automatically.

Remote schemas are therefore absent from the fixed provider tool payload and
from later turns unless selected again. Explicit release clears protocol
connections and loaded definitions; the content-free static screening cache is
not conversational context and may remain until broker shutdown. This gives
multiple configured servers a cheap catalog without dumping every schema into
the context window.

The gateway authorizes each action with a connection-scoped, single-use opaque
permit minted only for the exact MCP tool call returned by the model provider.
The permit binds the normalized server/tool/arguments payload, expires quickly,
and is consumed once. The trusted turn runtime derives sensitivity from the
sources already admitted into that generation; the agent-side gateway client
carries it only on the provider request, and the gateway binds it into the
returned permit before the MCP action exists. `mcp.execute` cannot choose or
lower it. A missing lineage denies calls. Screened MCP catalog/search/inspect
metadata preserves the existing sensitivity so progressive discovery remains
usable; remote call results and all other admitted tool outputs immediately
tighten the next model step to confidential. Autonomous work-spec or
shard-originated generations receive no MCP permit.

The label-integrity boundary is the trusted companion turn runtime versus
model-, tool-, and server-authored content. Arbitrary code execution inside the
authenticated agent process is not claimed as contained: that process already
authors the complete provider-bound prompt. Even under that boundary, the
gateway independently retains MCP credentials, server/tool allowlists,
capability checks, approvals, exact-payload permit consumption, CogSec output
screening, and network transport policy.

All MCP ingress crosses CogSec. Tool descriptions and schemas are canonicalized
and hashed with SHA-256. An exact `(companion, hash)` hit reuses the prior
screening decision; any byte-level semantic change produces a new hash and is
screened again. The hash means "screened at this content version," not trusted.
Tool-call results are dynamic and are screened on every invocation regardless
of server trust or prior hashes. Raw remote metadata/output never crosses the
broker's returned port.

An allowlist entry is effective only when its operator-recorded per-tool hash
matches the current screened definition. `list_changed`, TTL refresh, or a
reconnect that changes a same-name tool therefore removes its authorization.
Before dispatch, arguments are validated locally against that exact screened
JSON Schema using the SDK validator. Server trust and per-tool sensitivity
ceilings both apply; the tool ceiling may narrow but never widen server trust.

### Channels and voice

- First-class adapters (Discord, Telegram, API) load through the gateway channel-surface composition. Additional text channels register as plugins via `ChannelPluginHost` (`src/channels/plugins/`, [`docs/channel-plugins.md`](./channel-plugins.md)). Multica is the tracer plugin and never transits Satellite Hub. Endpoint transports such as Wyoming/OpenHome are owned by the Satellite Hub repository.
- Voice connectors are plugin-style STT/TTS adapters resolved from runtime settings and capability eligibility.
- Same-cluster companion↔companion conversation runs through the normal turn
  pipeline as ordinary channels (`src/shared/contracts/companion-channels.ts`):
  a many-to-many room (`companion-room:<placeId>`) and a 1:1 DM
  (`companion-dm:<a>:<b>`), routed by the gateway companion lane
  (`src/boundary/gateway/companion-channels.ts`) and governed by the existing
  fatigue budgets. Active only under multi-companion topology (a `companions.json`
  with more than one entry); see [`docs/multi-companion.md`](./multi-companion.md).

### Locations, presence, and world

- A soft-registry `places.json` (`src/shared/contracts/places-registry.ts`,
  loaded by `src/channels/backplane/places-registry.ts`) models sites, places,
  and affordances (perceivers/effectors). An absent file degrades to no world
  surface rather than failing boot; a malformed file fails closed.
- A situated-presence context section
  (`src/core/agent/substrate-agent/runtime-context-sections/situated-presence.ts`)
  renders where the companion is, what it perceives, what it can act on, and who
  else is co-present. A turn with no resolvable place renders no block — the
  companion never fabricates a location.
- Every turn is classified into one of two presence modes by device origin
  (`turn-presence-mode.ts`): `physical` (a satellite/voice endpoint — the
  companion emanates into a real room) or `mindspace` (a plain chat channel —
  the companion is co-located with the partner in a virtual twin of the
  last-known physical room, resolved via a place's `mirrorsPlaceId` twin link).
- The last-known situated location is durable companion state inside the
  Postgres `internal_state_snapshots` row. Restart hydration restores this
  location independently even when the surrounding affect/attention snapshot
  is older than the freshness window and is correctly withheld as stale. Turn
  execution awaits each state write before advancing, so a completed turn
  cannot outrun its latest snapshot; a failed write fails the turn boundary.
- The `world` tool (`src/boundary/integrations/world/`) exposes
  `perceive`/`list`/`move`, with `control` staged off by default
  (`WORLD_CONTROL_RUNTIME_ENABLED = false`) until proven on hardware. HA control
  is a privileged gateway method holding the token behind a scoped SSRF lane.
- Cross-companion presence (`companion_presence` in the shared schema) and the
  shared-world wiki are multi-companion deltas layered on this model — see
  [`docs/multi-companion.md`](./multi-companion.md) and
  [`docs/memory.md`](./memory.md).

### Scheduler and background work

- `Scheduler` handles heartbeat/reflection tasks, maintenance, one-shot tasks, backups, and deferred work.
- Rest/me-time configuration owns sleeptime entirely: heavy passes (sleep consolidation, arc weaving, dream meaning, orientation rewrite) run only from the rest-window scheduler task, never from turn cadence. The lightweight near-turn lane and the gated episode-synthesis lane cover daytime work.
- Post-turn actions and intention appraisal live outside the main response path but stay in the same audited runtime. Their outputs (whispers/pending follow-ups) re-enter later turns through the agent followUp queue behind the Participant-facing boundary — see [`docs/chat-turn-lifecycle.md`](./chat-turn-lifecycle.md) §2 and §4.

## Persistence Topology

- System-owned mutable config lives under `system-data/`.
- Companion-owned state lives under `companion-data/`.
- `WORKSPACE_PATH` is one companion's Personal Workspace, not runtime state.
- A governed Shared Companion Workspace is planned for explicitly shared files
  and common reference material; the existing Shared-world Wiki is a narrower,
  site-scoped operator-owned knowledge surface.
- Continuous mode can still use the legacy shared `data/` root.
- Production mode forbids overlapping mutable roots and fails closed on partial split-root configuration.

The path contract is defined in `src/persistence/layout.ts` and summarized in [`docs/specifications.md`](./specifications.md).

## Multi-Companion Topology

Every deployment is a cluster of one or more companions, enumerated by a mandatory
system-owned `companions.json` manifest. The default topology is one gateway,
one agent process, one Companion Core, and one companion — a one-entry manifest.
A multi-companion topology (a manifest with more than one entry) runs N agent
processes behind the one gateway, each running a peer Companion Core. Each
companion has its own companion ID, data dir, character card, and Postgres
schema, all connecting to the single gateway over the existing socket protocol.
Topology is derived from the manifest entry count (there is no
`PSFN_MULTI_COMPANION` flag); a one-entry cluster is byte-identical to the old
single-companion behavior.

Tenancy is schema-per-companion (`config.postgresSchema` pins each agent's
Postgres `search_path`) plus one `shared` schema for cross-companion world data.
Operability uses one authenticated Garden frontend for the cluster overview and
authorized companion administration. The public canonical HTTPS origin serves
that bundle at `/fleet` and at
`/companions/<companion-uuid>/garden/...`; `/v1/fleet/portal` supplies only the
current principal's bounded projection. Per-companion operator processes remain
private upstreams behind the gateway. The former raw cluster-status listener is
retired, and `/fleet/status.json` is not a browser surface. The full topology,
flag/manifest contract, launcher supervisor mode, and cluster operations are
documented in
[`docs/multi-companion.md`](./multi-companion.md).

Workspace-backed files are isolated by a deterministic Personal Workspace per
companion. The supervisor injects only the authenticated companion's root and
the gateway binds filesystem-adjacent surfaces to that same root. The separate
Shared Companion Workspace is Garden-governed, reviewed, and never an implicit
skills/modules/prompt/memory source.
Key files: `src/system/config/companions-config.ts`,
`src/persistence/postgres.ts`, `src/persistence/runtime-factory.ts`,
`src/boundary/gateway/fleet-portal-http-routes.ts`,
`scripts/resolve-companion-fleet.ts`.

## Persistence Ports

Persistence is shaped around domain ports, not raw database adapters.

- L0 archive operations belong to `SessionArchivePort` and continue to use JSONL as the canonical backing format.
- Searchable transcript mirrors and projections belong to `TranscriptProjectionPort` and `TranscriptSearchPort`.
- Durable state belongs behind async-safe domain ports such as `MemoryStorePort`, `ContactStorePort`, `ConcernStorePort`, `PendingFollowUpStorePort`, `BehavioralPatternStorePort`, `GatewayAuditStorePort`, and `TurnRecordStorePort`.
- Raw adapter code stays behind those ports and is not a composition-root seam.
- The live runtime and persistence-aware maintenance commands compose PostgreSQL implementations. No SQLite implementation or reader remains behind the domain ports.

## Extension Surfaces

These are the main extension points that already exist in code:

- model/provider registries
- channel adapter factory manifests
- module registry and loader
- skills runtime
- native gateway MCP client broker and protocol-client port
- gateway-backed git, filesystem, vault, media, shell, web, journal, and beads tool surfaces

## Current Model-Facing Surface

The direct first-party surface is declared in `src/core/agent/tool-surface/registry.ts` and implemented by the agent/gateway composition roots. The current important surfaces are:

- adaptive control: `tool_search`, `toolset`, and `response_control action=no_reply`
- workspace and external primitives: `fs`, `repo`, `shell`, `web`, `analysis_workbench`
- external integrations: `mcp` with `catalog|search|inspect|call|release`
- companion state: `memory`, `scratchpad`, `contact`, `session`, `identity`, `orient`, `north_star`, `schedule`, `self_status`, `system`, `skill`, `wiki`, `journal`
- operations and lifecycle: `beads`, `notify`, `generate_image`, `selfie_create`, `vault`
- bounded workers: `subagent action=spawn|message|wait|cancel|status`

Shard execution is implemented as an internal long-horizon runtime with fold-back lineage and review, but the direct model-facing `shard` surface is still a reserved extended control-plane entry. Use `subagent` for bounded worker control until the shard surface is fully registered and documented as live.

If documentation and diagrams disagree with the code, prefer the entrypoints and composition files first.
