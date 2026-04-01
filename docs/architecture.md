# Architecture

This is the current runtime shape. For the component graph, start with [`docs/architecture-diagram.mmd`](./architecture-diagram.mmd); for behavior, trust the code in `src/`.

## Canonical Runtime Model

- `src/index.ts` is intentionally not a runnable monolith. It validates the runtime mode contract and exits fail-closed.
- `src/gateway-main.ts` is the host-side process. It owns secrets, outbound network access, policy checks, SSRF defense, confirmation queues, audit logging, and gateway-backed tool execution.
- `src/agent-main.ts` is the isolated agent process. It loads companion state, enforces startup network isolation, connects to the gateway over the Unix socket, and runs the companion loop.
- `src/runtime.ts` still exists as the single-process `SubstrateRuntime` used for parity, tests, and historical wiring. It is no longer the primary operational entrypoint.

## Composition Layer

Shared runtime construction is concentrated in:

- `src/bootstrap/composition.ts`
- `src/bootstrap/parity.ts`
- `src/bootstrap/post-turn-actions.ts`
- `src/bootstrap/channel-runtime.ts`

Those helpers keep the split runtime and the single-process parity runtime aligned on core wiring:

- identity loading
- session runtime
- memory runtime
- prompt/runtime settings surfaces
- shard and think tooling
- heartbeat/scheduler wiring
- channel adapter manifests

## Gateway Responsibilities

`src/gateway-main.ts` builds the privileged edge:

- `GatewayServer` exposes JSON-RPC over the NDJSON Unix socket.
- `LLMClient` and embedding creation happen on the gateway side so provider secrets stay out of the agent.
- Gateway policy resolves filesystem scope, URL policy, SSRF checks, and approval-gated actions.
- Optional operator surfaces live here too: ntfy notifications, confirmation queue, beads tools, vault tools, shell execution, and git-backed mutations.
- Discord, Telegram, and Wyoming host-facing adapters are started from the gateway side when enabled.

## Agent Responsibilities

`src/agent-main.ts` builds the companion runtime:

- loads config, owner-file state, and trust policy
- initializes SQLite-backed companion data
- loads the character card and prompt registry
- composes `SessionManager`, `SubstrateAgent`, `MemoryStore`, `MemoryRetriever`, `MemoryExtractor`, `Scheduler`, and admin/API servers
- wires contacts, values, skills, safeguards, core memory, shards, think tools, image tools, and post-turn actions

The agent talks to the gateway through `GatewayClient`, which acts as the LLM and embeddings provider inside the isolated process.

## Core Subsystems

### Sessions and context

- L0 session history is append-only JSONL under `sessions/`.
- `SessionManager` handles compaction, token budgeting, continuity, internal role envelopes, and prompt-aware context assembly.
- Reflection-oriented append-only notes live separately under `notes/reflections/` for heartbeat journals, per-day journals, and long-process reflection logs.
- Session integrity can be HMAC-backed in split mode through the gateway-provided integrity provider.

### Memory

- `MemoryStore` uses SQLite plus `sqlite-vec`.
- `MemoryRetriever` combines semantic retrieval, lexical fallback, trust filtering, emotional continuity, and optional compositional reranking.
- `MemoryExtractor` runs post-turn extraction, crash-recovery extraction, compaction extraction, and profile refresh flows.

See [`docs/memory.md`](./memory.md) for the memory contract.

### Identity and prompts

- Character card loading and prompt composition live under `src/identity/`.
- Prompt layers, prompt registry entries, north-star state, and core memory are persisted in companion-owned files.
- Admin surfaces mutate prompt/runtime state through the JSON owner-file contract rather than through `.env`.

### Trust, safeguards, and capabilities

- Trust policy is loaded from `trust-policy.json`.
- Eligibility gates and capability tiers are enforced before privileged tools run.
- Safeguards audit cooling-off, restart protection, and external communication rate limits.

### Channels and voice

- Channel adapters are manifest-driven and loaded through `src/runtime/channel-lifecycle.ts`.
- Current runtime surfaces include Discord, Telegram, the OpenAI-compatible API, Garden admin, Wyoming, and PSFN/OpenHome-related adapter entries.
- Voice connectors are plugin-style STT/TTS adapters resolved from runtime settings and capability eligibility.

### Scheduler and background work

- `Scheduler` handles heartbeat/reflection tasks, maintenance, one-shot tasks, backups, and deferred work.
- Post-turn actions and intention appraisal live outside the main response path but stay in the same audited runtime.
- Deferred continuation post-turn delivery is intentionally limited to explicit `deferred-tool-handoff:*` completions keyed by continuation id. Arbitrary background process watchers must define a separate runtime contract if they need restart-safe state or user notification semantics.

## Persistence Topology

- System-owned mutable config lives under `system-data/`.
- Companion-owned state lives under `companion-data/`.
- Continuous mode can still use the legacy shared `data/` root.
- Production mode forbids overlapping mutable roots and fails closed on partial split-root configuration.

The path contract is defined in `src/persistence/layout.ts` and summarized in [`docs/specifications.md`](./specifications.md).

## Extension Surfaces

These are the main extension points that already exist in code:

- model/provider registries
- channel adapter factory manifests
- module registry and loader
- skills runtime
- gateway-backed git, filesystem, vault, image, shell, and beads tool surfaces

The companion-facing tool stack is intentionally narrower than the raw implementation surface. See [`docs/tool-surface.md`](./tool-surface.md) for the current target taxonomy and migration map.

If documentation and diagrams disagree with the code, prefer the entrypoints and composition files first.
