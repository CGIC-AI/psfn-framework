# Architecture

Last updated: 2026-07-05.

This is the current runtime shape. For the component graph, see [`docs/architecture-diagram.mmd`](./architecture-diagram.mmd). For the end-to-end anatomy of a single chat turn (inbound queueing, in-turn continuations, reply disposition, post-turn lanes), see [`docs/chat-turn-lifecycle.md`](./chat-turn-lifecycle.md). For the post-Sprint 8 source-backed snapshot, see [`docs/sprint-8-architecture-report.md`](./sprint-8-architecture-report.md); for current feature status and active work, see [`docs/development-status.md`](./development-status.md).

## Canonical Runtime Model

- `src/app/startup/index.ts` is disabled and exits fail-closed.
- `src/app/gateway/main.ts` is the host-side process. It owns secrets, outbound network access, policy checks, SSRF defense, confirmation queues, audit logging, gateway-backed tool execution, and the public OpenAI-compatible API edge.
- `src/app/operator/main.ts` is the operator-plane process. It hosts Garden HTTP/UI and proxies admin traffic over the private admin transport.
- `src/app/agent/main.ts` is the isolated agent process. It loads companion state, enforces startup network isolation, connects to the gateway over the Unix socket, and runs the companion loop plus the private admin transport.

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
- Optional operator-facing support surfaces live here too: ntfy notifications, confirmation queue, beads tools, vault tools, shell execution, and git-backed mutations.
- Discord, Telegram, and Wyoming host-facing adapters are started from the gateway side when enabled.

## Agent Responsibilities

`src/app/agent/main.ts` builds the companion runtime:

- loads config, owner-file state, and trust policy
- initializes PostgreSQL-backed companion runtime stores through `createAgentPersistenceRuntime`
- loads the character card and prompt registry
- composes `SessionManager`, `SubstrateAgent`, `MemoryStore`, `MemoryRetriever`, `MemoryExtractor`, `Scheduler`, the gateway-routed API backend, and the private admin transport
- wires contacts, values, skills, safeguards, core memory, subagents, shard internals, analysis workbench tools, media/journal/wiki tools, and post-turn actions

The agent talks to the gateway through `GatewayClient`, which acts as the LLM and embeddings provider inside the isolated process.

## Core Subsystems

### Sessions and context

- L0 session history is append-only JSONL under `sessions/`.
- The archive/projection split is intentional: canonical archive truth stays in JSONL, while fast-search copies belong behind projection/search ports.
- `SessionManager` handles the sliding active context window, token budgeting, continuity, internal role envelopes, focus knowledge, observation masking, and prompt-aware context assembly.
- Auto-compaction is deferred between turns by default. It summarizes older selected context into untrusted carry-forward notes, retains a recent verbatim tail, and leaves canonical L0 history intact.
- Session integrity can be HMAC-backed in split mode through the gateway-provided integrity provider.

### Memory

- Runtime memory/session composition requires PostgreSQL-backed ports.
- SQLite-backed stores remain legacy/migration/test surfaces and must not be selected by runtime defaults.
- `EpisodicStore` owns the L0.1 `l01_episodes` and `l01_episode_arcs` tables. These records are bounded landmarks with L0 span/artifact provenance, not generic transcript summaries and not L2 typed memories.
- `EpisodicSynthesizer` runs from the gated episode-synthesis lane (scheduler timer or turn threshold, then a deterministic new-messages + relevance-minimum gate). It can create multiple candidate episodes for one day and links longer themes as graph arcs; nightly rest-window sleeptime consolidates them.
- `MemoryRetriever` combines L0.1 landmark-chain retrieval, semantic retrieval, lexical fallback, trust filtering, emotional continuity, and optional compositional reranking.
- `MemoryExtractor` runs post-turn extraction, crash-recovery extraction, compaction extraction, and profile refresh flows.
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

### Channels and voice

- Channel adapters are manifest-driven and loaded through `src/app/startup/support/channel-lifecycle.ts`.
- Current runtime surfaces include Discord, Telegram, the gateway-hosted OpenAI-compatible API, the operator-hosted Garden surface, and the Satellite Hub claim/config boundary. Endpoint transports such as Wyoming/OpenHome are owned by the Satellite Hub repository.
- Voice connectors are plugin-style STT/TTS adapters resolved from runtime settings and capability eligibility.
- Same-cluster companion↔companion conversation runs through the normal turn
  pipeline as ordinary channels (`src/shared/contracts/companion-channels.ts`):
  a many-to-many room (`companion-room:<placeId>`) and a 1:1 DM
  (`companion-dm:<a>:<b>`), routed by the gateway companion lane
  (`src/boundary/gateway/companion-channels.ts`) and governed by the existing
  fatigue budgets. Active only under the multi-companion flag; see
  [`docs/multi-companion.md`](./multi-companion.md).

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
- Post-turn actions and intention appraisal live outside the main response path but stay in the same audited runtime. Their outputs (whispers/pending follow-ups) re-enter later turns through the agent followUp queue behind the user-facing boundary — see [`docs/chat-turn-lifecycle.md`](./chat-turn-lifecycle.md) §2 and §4.

## Persistence Topology

- System-owned mutable config lives under `system-data/`.
- Companion-owned state lives under `companion-data/`.
- Continuous mode can still use the legacy shared `data/` root.
- Production mode forbids overlapping mutable roots and fails closed on partial split-root configuration.

The path contract is defined in `src/persistence/layout.ts` and summarized in [`docs/specifications.md`](./specifications.md).

## Multi-Companion Topology

The default topology is one gateway, one agent, one companion. An opt-in
multi-companion topology runs N agent processes behind the one gateway — each a
distinct companion with its own companion ID, data dir, character card, and
Postgres schema, all connecting to the single gateway over the existing socket
protocol. It is selected by the `PSFN_MULTI_COMPANION` env flag plus a
system-owned `companions.json` fleet manifest, and is inert (byte-identical to
single-companion) when the flag is off.

Tenancy is schema-per-companion (`config.postgresSchema` pins each agent's
Postgres `search_path`) plus one `shared` schema for cross-companion world data.
Operability adds one Garden per companion and a read-only gateway fleet-status
page. The full topology, flag/manifest contract, launcher supervisor mode, and
fleet operations are documented in [`docs/multi-companion.md`](./multi-companion.md).
Key files: `src/system/config/companions-config.ts`,
`src/persistence/postgres.ts`, `src/persistence/runtime-factory.ts`,
`src/boundary/gateway/fleet-status.ts`, `scripts/start-gateway-agent.sh`.

## Persistence Ports

Persistence is shaped around domain ports, not raw database adapters.

- L0 archive operations belong to `SessionArchivePort` and continue to use JSONL as the canonical backing format.
- Searchable transcript mirrors and projections belong to `TranscriptProjectionPort` and `TranscriptSearchPort`.
- Durable state belongs behind async-safe domain ports such as `MemoryStorePort`, `ContactStorePort`, `ConcernStorePort`, `PendingFollowUpStorePort`, `BehavioralPatternStorePort`, `GatewayAuditStorePort`, and `TurnRecordStorePort`.
- Raw adapter code stays behind those ports and is not a composition-root seam.
- The live runtime composes PostgreSQL implementations. SQLite implementations remain for legacy migration utilities, explicit repair flows, and adapter tests.

## Extension Surfaces

These are the main extension points that already exist in code:

- model/provider registries
- channel adapter factory manifests
- module registry and loader
- skills runtime
- gateway-backed git, filesystem, vault, media, shell, web, journal, and beads tool surfaces

## Current Model-Facing Surface

The direct first-party surface is declared in `src/core/agent/tool-surface/registry.ts` and implemented by the agent/gateway composition roots. The current important surfaces are:

- adaptive control: `tool_search`, `toolset`, and `response_control action=no_reply`
- workspace and external primitives: `fs`, `repo`, `shell`, `web`, `analysis_workbench`
- companion state: `memory`, `scratchpad`, `contact`, `session`, `identity`, `orient`, `north_star`, `schedule`, `self_status`, `system`, `skill`, `wiki`, `journal`
- operations and lifecycle: `beads`, `notify`, `generate_image`, `selfie_create`, `vault`
- bounded workers: `subagent action=spawn|message|wait|cancel|status`

Shard execution is implemented as an internal long-horizon runtime with fold-back lineage and review, but the direct model-facing `shard` surface is still a reserved extended control-plane entry. Use `subagent` for bounded worker control until the shard surface is fully registered and documented as live.

If documentation and diagrams disagree with the code, prefer the entrypoints and composition files first.
