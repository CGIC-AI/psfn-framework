# Architecture

This is the current runtime shape. For the component graph, start with [`docs/architecture-diagram.mmd`](./architecture-diagram.mmd); for behavior, trust the code in `src/`. For the post-Sprint 8 source-backed deep dive, see [`docs/sprint-8-architecture-report.md`](./sprint-8-architecture-report.md).

## Canonical Runtime Model

- `src/app/startup/index.ts` is disabled and exits fail-closed.
- `src/app/gateway/main.ts` is the host-side process. It owns secrets, outbound network access, policy checks, SSRF defense, confirmation queues, audit logging, gateway-backed tool execution, and the public OpenAI-compatible API edge.
- `src/app/operator/main.ts` is the operator-plane process. It hosts Garden HTTP/UI and proxies admin traffic over the private admin transport.
- `src/app/agent/main.ts` is the isolated agent process. It loads companion state, enforces startup network isolation, connects to the gateway over the Unix socket, and runs the companion loop plus the private admin transport.

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
- initializes SQLite-backed companion data
- loads the character card and prompt registry
- composes `SessionManager`, `SubstrateAgent`, `MemoryStore`, `MemoryRetriever`, `MemoryExtractor`, `Scheduler`, the gateway-routed API backend, and the private admin transport
- wires contacts, values, skills, safeguards, core memory, shards, analysis workbench tools, image tools, and post-turn actions

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
- `EpisodicSynthesizer` runs from rest/me-time sleeptime work after user inactivity. It can create multiple episodes for one day and links longer themes as graph arcs.
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
- Eligibility gates and capability tiers are enforced before privileged tools run.
- Safeguards audit cooling-off, restart protection, and external communication rate limits.

### Channels and voice

- Channel adapters are manifest-driven and loaded through `src/app/startup/support/channel-lifecycle.ts`.
- Current runtime surfaces include Discord, Telegram, the gateway-hosted OpenAI-compatible API, the operator-hosted Garden surface, Wyoming, and PSFN/OpenHome-related adapter entries.
- Voice connectors are plugin-style STT/TTS adapters resolved from runtime settings and capability eligibility.

### Scheduler and background work

- `Scheduler` handles heartbeat/reflection tasks, maintenance, one-shot tasks, backups, and deferred work.
- Rest/me-time configuration gates sleeptime episodic processing so background review can happen during explicit inactive windows without blocking foreground chat.
- Post-turn actions and intention appraisal live outside the main response path but stay in the same audited runtime.

## Persistence Topology

- System-owned mutable config lives under `system-data/`.
- Companion-owned state lives under `companion-data/`.
- Continuous mode can still use the legacy shared `data/` root.
- Production mode forbids overlapping mutable roots and fails closed on partial split-root configuration.

The path contract is defined in `src/persistence/layout.ts` and summarized in [`docs/specifications.md`](./specifications.md).

## Persistence Ports

Persistence is shaped around domain ports, not raw database adapters.

- L0 archive operations belong to `SessionArchivePort` and continue to use JSONL as the canonical backing format.
- Searchable transcript mirrors and projections belong to `TranscriptProjectionPort` and `TranscriptSearchPort`.
- Durable state that may move across SQLite or PostgreSQL belongs behind async-safe domain ports such as `MemoryStorePort`, `ContactStorePort`, `ConcernStorePort`, `PendingFollowUpStorePort`, `BehavioralPatternStorePort`, `GatewayAuditStorePort`, and `TurnRecordStorePort`.
- Raw SQLite or PostgreSQL adapter code stays behind those ports and is not a composition-root seam.
- Backend choice happens in composition/runtime wiring so callers only see the port contracts.

## Extension Surfaces

These are the main extension points that already exist in code:

- model/provider registries
- channel adapter factory manifests
- module registry and loader
- skills runtime
- gateway-backed git, filesystem, vault, image, shell, and beads tool surfaces

If documentation and diagrams disagree with the code, prefer the entrypoints and composition files first.
