# Sprint 8 Technical Architecture Report

> Current status update, 2026-06-29: this report is a Sprint 8 historical architecture snapshot. It remains useful for understanding the integration path, but current runtime contracts have advanced. Prefer [`architecture.md`](./architecture.md), [`memory.md`](./memory.md), [`specifications.md`](./specifications.md), [`operations.md`](./operations.md), and [`development-status.md`](./development-status.md) for live Postgres-only runtime behavior, owner-file contracts, current tool surfaces, and current roadmap status.

This report describes the current `main` branch after the Sprint 8 integration work. It is a source-backed architecture snapshot, not a shakedown artifact log.

## Executive Summary

PSFN is a single-companion substrate for persistent, embodied, trust-aware digital companionship. The project charter defines the deployment model as one companion with one continuity of self across many channels and faculties, with the gateway as the only privileged external edge and owner files as the authority for mutable runtime settings (`docs/PSFN_PROJECT_CHARTER.md:15`, `docs/PSFN_PROJECT_CHARTER.md:104`, `docs/PSFN_PROJECT_CHARTER.md:121`). The README presents the user-facing shape: persistent memory, trust-aware privacy, self-modification, split gateway/agent runtime, Garden admin UI, and a bounded analysis workbench for large evidence sets (`README.md:20`, `README.md:38`, `README.md:51`, `README.md:53`).

Sprint 8 made that shape more operationally coherent. The main outcomes are strict split-runtime composition, JSON owner-file configuration, L0.1 episodic memory, grounded scheduled reflection, charge/budget visibility, a clearer Garden information architecture, and a renamed bounded analysis tool that is guarded away from routine companion workflows.

Key current-code stats:

| Metric | Value |
| --- | --- |
| TypeScript/Svelte tracked source files under `src/` and `admin-ui/src/` | 1,246 |
| Lines across those tracked source files | 350,943 |
| Root Vitest test files under `src/` | 386 |
| Garden Vitest test files under `admin-ui/src/` | 15 |
| Runtime language/tooling | TypeScript 5.9, Node 22+, Svelte 5 Garden |

## Sprint 8 Outcomes

| Outcome | Implementation anchor |
| --- | --- |
| Split runtime became the default operational model: gateway owns secrets/network, agent owns companion loop, operator owns Garden. | `package.json:10`, `package.json:12`, `package.json:14`, `package.json:16`; `docs/architecture.md:5` |
| Owner-file config replaced env sprawl for mutable runtime settings. | `README.md:103`; `src/system/config/startup-owner-files.ts:53`; `src/system/config/runtime-config.ts:12` |
| Production persistence layout rejects ambiguous or overlapping roots. | `src/persistence/layout.ts:197`; `src/persistence/layout.ts:386`; `README.md:135` |
| Memory retrieval now includes L0.1 episodic chains, provenance telemetry, caller context, and trust-gated visibility summaries. | `src/faculties/memory/retrieval.ts:443`; `src/faculties/memory/retrieval.ts:620`; `src/core/turns/snapshot.ts:91` |
| Scheduled reflection waits for memory extraction and grounds on context/provenance instead of contactless static prompt material. | `src/core/scheduler/heartbeat-template-runtime.ts:646`; `src/core/scheduler/heartbeat-template-runtime.ts:790`; `src/core/scheduler/heartbeat-template-runtime.ts:840` |
| Redundant introspection cycles were consolidated into daily and weekly reflection templates. | `src/core/scheduler/heartbeat-policy.ts:44`; `src/core/scheduler/heartbeat-policy.ts:317`; `src/core/scheduler/heartbeat-policy.ts:353` |
| Deep evidence reasoning is exposed as `analysis_workbench`, not a general "think" affordance. | `src/core/tools/analysis-workbench/tools.ts:13`; `src/core/agent/substrate-agent/tool-runtime-facade.ts:711`; `docs/tool-surface.md:15` |
| Charge/budget state is prompt-visible, ledger-backed, and exposed in Garden. | `src/shared/telemetry/run-charge.ts:324`; `src/shared/telemetry/charge-ledger.ts:368`; `src/core/agent/substrate-agent/runtime-context.ts:142`; `admin-ui/src/routes/charge-budget/+page.svelte:284` |
| Garden gained a clearer IA with runtime, memory, review, and configuration sections plus dedicated charge and episodic pages. | `admin-ui/src/lib/nav.ts:25`; `src/operator/garden/server-request-routing.ts:7`; `src/operator/garden/local-admin-contract.ts:136` |

## Entry Points

| Entry | Location | Purpose |
| --- | --- | --- |
| Split launcher | `package.json:10`, `package.json:18` | Starts gateway and agent together through `scripts/start-gateway-agent.sh`. |
| Gateway process | `package.json:12`; `src/app/gateway/main.ts:63` | Host-side privileged edge: loads secrets/config, owns outbound network and gateway services. |
| Agent process | `package.json:14`; `src/app/agent/main.ts:71` | Isolated companion runtime: loads companion state, connects to gateway, runs agent loop and private admin transport. |
| Operator process | `package.json:16`; `src/app/operator/main.ts:20` | Operator/Garden host process for admin UI and admin transport proxying. |
| Docker agent modes | `package.json:22`, `package.json:23` | Containerized production and continuous agent runtime paths. |
| Garden development/build | `package.json:56`, `package.json:57` | Svelte Garden development and build commands. |
| E2E and smoke commands | `package.json:49`, `package.json:50`, `package.json:51` | In-repo end-to-end chat, voice, and cockpit smoke entry points. |
| Settings contract verifier | `package.json:63` | Ensures Garden/settings surfaces remain aligned with owner-file contracts. |

## Runtime Topology

```text
External channels / API clients / Garden operator
        |
        v
Gateway process
  - secrets, provider credentials, network
  - LLM and embeddings proxy
  - filesystem/git/shell/vault/beads gateway services
  - Discord, Telegram, Wyoming, API host adapters
        |
        | Unix socket JSON-RPC
        v
Agent process
  - companion identity and prompt runtime
  - session manager and substrate agent loop
  - memory extraction/retrieval and L0.1 episodic synthesis
  - scheduler, reflection, post-turn actions
  - private admin transport contract
        |
        v
System data + companion data owner roots
  - JSON owner files
  - sessions JSONL
  - SQLite memory/session indexes
  - charge ledger, journals, core memory, prompt state
```

The gateway builds privileged host services before exposing API/channel surfaces (`src/app/gateway/main.ts:98`, `src/app/gateway/main.ts:153`, `src/app/gateway/main.ts:176`). The agent explicitly checks network isolation, connects through the gateway socket, then constructs persistence, core runtime, scheduler runtime, memory writer, episodic store, tools, and admin surface (`src/app/agent/main.ts:94`, `src/app/agent/main.ts:122`, `src/app/agent/main.ts:148`, `src/app/agent/main.ts:211`, `src/app/agent/main.ts:261`, `src/app/agent/main.ts:270`, `src/app/agent/main.ts:333`).

## Key Types

| Type | Location | Purpose |
| --- | --- | --- |
| `SubstrateConfig` | `src/system/config/runtime-config-contracts.ts:50` | Runtime configuration object after env, owner files, models, providers, scheduler, capabilities, and charge policy are resolved. |
| `EditableSettings` | `src/system/settings/contracts.ts:61` | Canonical mutable settings schema used by settings owner files and Garden editors. |
| `SubstrateAgent` | `src/core/agent/substrate-agent.ts:204` | Core agent loop wrapper around pi-agent-core, prompt/context assembly, tools, memory snapshots, and turn execution. |
| `TurnMemorySnapshot` | `src/core/turns/snapshot.ts:91` | Prompt-facing retrieval snapshot containing memory blocks, episodic chains, caller/retrieval modes, and withheld summaries. |
| `PurrMemory` | `src/faculties/memory/types.ts:165` | L2 typed memory record with provenance, scope, sensitivity, contact, confidence, and source metadata. |
| `Episode` and `EpisodeArc` | `src/shared/contracts/episodic-memory.ts:53`, `src/shared/contracts/episodic-memory.ts:73` | L0.1 bounded episode landmarks and graph links across related conversation arcs. |
| `MemoryRetriever` | `src/faculties/memory/retrieval.ts:270` | Retrieval orchestrator for semantic, lexical, emotional, profile, proactive, withheld, and episodic context. |
| `EpisodicSynthesizer` | `src/faculties/memory/episodic/synthesis.ts:449` | Rest-window processor that chunks recent L0 session history into bounded episodes and graph arcs. |
| `ReflectionTemplate` | `src/core/scheduler/heartbeat-policy.ts:16` | Scheduler-owned reflection template model for consolidated daily/weekly introspection. |
| `RunChargeLedger` | `src/shared/telemetry/charge-ledger.ts:368` | JSONL-backed charge telemetry sink and query service for budget/cost auditing. |
| `GatewayServer` | `src/boundary/gateway/server.ts:105` | JSON-RPC socket server for privileged gateway services and reverse RPC. |
| `Scheduler` | `src/core/scheduler/scheduler.ts:106` | Recurring and one-shot scheduled task engine used by heartbeat/reflection/runtime maintenance. |

## Core Runtime Composition

Runtime construction is intentionally concentrated in thin composition roots. `createSessionComposition` builds session storage, session manager, internal role envelopes, and continuity providers (`src/app/startup/composition/composition.ts:97`). It supports SQLite and Postgres-backed projections while preserving L0 session history as canonical JSONL (`src/app/startup/composition/composition.ts:128`). `composeSubstrateAgent` creates the agent around the session manager, prompt registry, capability runtime, tools, and event bus (`src/app/startup/composition/composition.ts:203`).

Memory composition is centralized in `createMemoryRuntime`. It wires `MemoryStore`, `MemoryRetriever`, `MemoryExtractor`, salience decay, compaction extraction, and the pre-compaction extraction handler (`src/app/startup/composition/composition.ts:269`). Core bootstrapping then layers identity, character card versions, emotional state, safeguards, contact runtime, capability runtime, and memory runtime around the agent (`src/app/agent/core-bootstrap.ts:63`, `src/app/agent/core-bootstrap.ts:90`, `src/app/agent/core-bootstrap.ts:115`).

The agent-side `buildAgentCoreRuntime` creates prompt registry, LLM gateway port, session runtime, memory journal, scratchpad mirror, SubstrateAgent, channel tools, prompt/card/settings/session runtime, contacts, intentions, core memory, self model, and memory runtime (`src/app/agent/core-runtime.ts:124`, `src/app/agent/core-runtime.ts:137`, `src/app/agent/core-runtime.ts:150`, `src/app/agent/core-runtime.ts:170`, `src/app/agent/core-runtime.ts:189`, `src/app/agent/core-runtime.ts:218`, `src/app/agent/core-runtime.ts:244`).

## Data Flow

### User Turn

```text
Channel adapter or OpenAI-compatible API
        |
        v
Gateway host surface
        |
        v
GatewayClient reverse RPC / agent request
        |
        v
SubstrateAgent
  - resolve identity and prompt layers
  - build turn context and charge budget context
  - capture memory snapshot
  - choose active tools through capability and adaptive-tool policy
        |
        v
LLM provider through gateway
        |
        v
Response stream + tool calls + memory extraction queue
        |
        v
Session JSONL, memory store, journals, telemetry, Garden events
```

The gateway exposes API and channel surfaces after provider, eligibility, and privileged service registration (`src/app/gateway/main.ts:176`). The agent registers memory, git, beads, vault, skills, web, filesystem, image, shard, and analysis workbench tools before validating model-facing tool wiring (`src/app/agent/main.ts:270`, `src/app/agent/main.ts:290`). Runtime context injects charge guidance into the prompt (`src/core/agent/substrate-agent/runtime-context.ts:142`, `src/core/agent/substrate-agent/runtime-context.ts:879`), while memory retrieval populates the turn snapshot with prompt blocks, provenance, episodic chains, and withheld summaries (`src/faculties/memory/retrieval.ts:443`).

### Scheduled Reflection And Rest Work

```text
Scheduler tick / heartbeat
        |
        v
Rest-window and policy checks
        |
        v
Memory extraction flush
        |
        v
Template context assembly
  - contact context
  - recent messages
  - emotional snapshots
  - concerns and followups
  - memory block and provenance
        |
        v
Reflection LLM call
        |
        v
Reflection journal / values / memory provenance / episodic synthesis
```

The scheduler runtime wires heartbeat, salience decay, compaction guideline review, backups, and post-turn actions (`src/app/agent/scheduler-runtime.ts:47`, `src/app/agent/scheduler-runtime.ts:61`, `src/app/agent/scheduler-runtime.ts:96`, `src/app/agent/scheduler-runtime.ts:130`). Rest-window logic evaluates configured rest/me-time windows and inactivity before allowing background work (`src/core/scheduler/rest-window.ts:95`). The heartbeat template runtime explicitly waits for pending memory extraction before reflection, retrieves reflection memory with request context, and formats internal state plus contact context into the reflection prompt bundle (`src/core/scheduler/heartbeat-template-runtime.ts:646`, `src/core/scheduler/heartbeat-template-runtime.ts:790`, `src/core/scheduler/heartbeat-template-runtime.ts:840`, `src/core/scheduler/heartbeat-template-runtime.ts:986`).

### Garden Admin Flow

```text
Browser Garden route
        |
        v
Operator HTTP server
        |
        v
Private admin transport / in-process admin contract
        |
        v
Domain service
        |
        v
Owner file, store, ledger, journal, memory, session, or event-bus projection
```

Garden routes are explicit client routes, including `charge-budget`, `episodic-memory`, `prompt-monitor`, `settings`, `tools`, and `telemetry` (`src/operator/garden/server-request-routing.ts:7`). The in-process Garden contract builds services for dashboard, audit history, charge ledger, action pipe, shards, adaptive tools, episodic memory, memory, sessions, contacts, settings, scheduler, prompts, and identity (`src/operator/garden/local-admin-contract.ts:94`, `src/operator/garden/local-admin-contract.ts:136`).

## Configuration And Persistence

Configuration ownership is strict. `.env` is for secrets, host/port/socket wiring, runtime mode/layout wiring, and explicit bootstrap overrides. Mutable runtime settings live in canonical JSON owner files such as `settings.json`, `models.json`, `providers.json`, `scheduler.json`, `capability-tier.json`, `trust-policy.json`, `backup.json`, `skills.json`, and `charge-policy.json` (`README.md:80`, `README.md:103`, `README.md:117`). Startup owner-file verification loads and validates those domains and rejects cross-domain keys in `settings.json` (`src/system/config/startup-owner-files.ts:53`, `src/system/config/startup-owner-files.ts:80`, `src/system/config/startup-owner-files.ts:168`).

`hydrateJsonBackedRuntimeConfig` applies owner-file state to runtime config for settings, models, providers, scheduler, capabilities, and charge policy (`src/system/config/runtime-config.ts:12`). Garden settings editors include charge policy and raw subconfig access through the owner-file service, so operator changes go back to canonical files rather than hidden env state (`src/operator/garden/services/settings-service.ts:376`, `src/operator/garden/services/settings-service.ts:840`, `src/operator/garden/services/settings-service.ts:917`).

The persistence layout enforces separate system and companion state in production. `resolveRuntimePathLayout` rejects partial `SYSTEM_DATA_DIR`/`COMPANION_DATA_DIR` configuration, rejects `DATA_DIR` as a production owner, derives workspace/log/tmp/backup roots, and checks for overlap (`src/persistence/layout.ts:197`). Companion state paths include sessions, contacts, reflections, values, scratchpad, memory journal, and core memory (`src/persistence/layout.ts:527`). The runtime exposes a layout snapshot for observability and admin inspection (`src/persistence/layout.ts:312`).

## Memory Architecture

Sprint 8 made memory more layered and inspectable:

| Layer | Responsibility | Anchors |
| --- | --- | --- |
| L0 sessions | Canonical append-only conversation history per channel. | `README.md:24`; `docs/architecture.md:57` |
| L0.1 episodes | Bounded landmarks chunked from L0, with spans, artifacts, provenance refs, salience, affect, thread IDs, and graph arcs. | `src/shared/contracts/episodic-memory.ts:53`; `src/faculties/memory/episodic/store.ts:67` |
| L1 retrieval context | Prompt-facing scoped context assembled from semantic, lexical, emotional, profile, episodic, and withheld candidates. | `src/faculties/memory/retrieval.ts:443`; `src/core/turns/snapshot.ts:91` |
| L2 typed memories | Durable typed memory records with trust, sensitivity, contact, provenance, source, and scope metadata. | `src/faculties/memory/types.ts:165`; `src/faculties/memory/writer.ts:47` |

`EpisodicStore` owns `l01_episodes` and `l01_episode_arcs`, including indexes for recency, thread, salience, and arc traversal (`src/faculties/memory/episodic/store.ts:67`). Episodes are created with strict contract validation and JSON-backed span/artifact/provenance fields (`src/faculties/memory/episodic/store.ts:190`). Arcs are written separately so long-running themes stay graph-linked instead of being collapsed into huge mega-episodes (`src/faculties/memory/episodic/store.ts:298`).

`EpisodicSynthesizer` groups recent messages by day, inactivity gap, max entries, and salience, then builds episode inputs with title, landmark summary, themes, span refs, artifacts, and provenance refs (`src/faculties/memory/episodic/synthesis.ts:157`, `src/faculties/memory/episodic/synthesis.ts:290`, `src/faculties/memory/episodic/synthesis.ts:327`). Its run loop skips already-covered spans, creates episodes, and links candidate arcs to related prior episodes (`src/faculties/memory/episodic/synthesis.ts:449`).

`retrieveEpisodicChains` scans candidate episodes, applies visibility and query-scope matching, scores episodes, and builds bounded chains through arcs (`src/faculties/memory/retrieval/episodic.ts:95`, `src/faculties/memory/retrieval/episodic.ts:198`, `src/faculties/memory/retrieval/episodic.ts:293`). Visibility allows same-channel episodes and otherwise requires contact continuity and trusted non-broadcast scope (`src/faculties/memory/retrieval/episodic.ts:379`). `MemoryRetriever` includes episodic counts, provenance refs, withheld summaries, and fallback prompt blocks when semantic candidates are absent or filtered (`src/faculties/memory/retrieval.ts:620`, `src/faculties/memory/retrieval.ts:668`, `src/faculties/memory/retrieval.ts:785`, `src/faculties/memory/retrieval.ts:893`, `src/faculties/memory/retrieval.ts:1002`).

Memory extraction records source, provenance, channel, turn, reason, and contact information when writing accepted facts (`src/faculties/memory/extraction.ts:426`). The orchestrator reads recent entries, calls the extraction model in chunks, applies boundary and importance caps, and writes accepted facts through the memory writer (`src/faculties/memory/extraction/orchestrator.ts:117`, `src/faculties/memory/extraction/orchestrator.ts:196`, `src/faculties/memory/extraction/orchestrator.ts:241`, `src/faculties/memory/extraction/orchestrator.ts:295`).

## Scheduler, Reflection, And Introspection

Sprint 8 reduced redundant reflection surfaces. The heartbeat policy knows obsolete template IDs, redirects them, and normalizes default policy to consolidated daily and weekly templates (`src/core/scheduler/heartbeat-policy.ts:44`, `src/core/scheduler/heartbeat-policy.ts:79`, `src/core/scheduler/heartbeat-policy.ts:317`, `src/core/scheduler/heartbeat-policy.ts:353`). This preserves coverage for mood, goals, experiential review, values, and metacognition without scattering them across many small scheduled prompts.

The reflection runtime now treats grounding as a hard requirement. It builds stores for policy, values, reflection journals, daily/process logs, loop guards, and cooldowns (`src/core/scheduler/heartbeat-template-runtime.ts:431`). It assembles internal state context with ACAC, metacognitive, concerns, and provenance fields (`src/core/scheduler/heartbeat-template-runtime.ts:547`, `src/core/scheduler/heartbeat-template-runtime.ts:579`). Before a scheduled reflection runs, it waits for pending memory extraction so that today's memories can be visible to reflection (`src/core/scheduler/heartbeat-template-runtime.ts:646`). It then retrieves reflection memory using request context, captures provenance, and includes recent messages, emotional snapshots, concerns, followups, memory block, and provenance in the prompt context (`src/core/scheduler/heartbeat-template-runtime.ts:790`, `src/core/scheduler/heartbeat-template-runtime.ts:840`).

Rest-window configuration belongs to scheduler owner files. The scheduler config schema includes `episodicProcessing`, validates its enabled state, inactivity, lookback, and cadence fields, then loads/saves through the scheduler owner-file domain (`src/system/config/scheduler-config.ts:19`, `src/system/config/scheduler-config.ts:114`, `src/system/config/scheduler-config.ts:149`). The rest-window evaluator determines whether now is an allowed me-time/rest period and when the next eligible interval begins (`src/core/scheduler/rest-window.ts:95`).

## Tool Surface And Analysis Workbench

The current target tool stack is documented in `docs/tool-surface.md`. It distinguishes always-on primitives such as `fs`, `repo`, `shell`, `web`, `analysis_workbench`, `tool_search`, and `toolset` from semantic companion tools such as `memory`, `orient`, `scratchpad`, `contact`, `session`, `identity`, `north_star`, `schedule`, `system`, `subagent`, `vault`, `beads`, `notify`, and `media` (`docs/tool-surface.md:7`, `docs/tool-surface.md:19`). Sprint 8 collapsed many high-entropy aliases but still documents a small set of split compatibility helpers that remain live during migration (`docs/tool-surface.md:38`, `docs/tool-surface.md:69`).

`analysis_workbench` is intentionally narrow. Its description says it is for large files, codebases, logs, transcripts, datasets, or evidence sets that would bloat main conversation context, and explicitly says not to use it for routine reasoning, tool discovery, orient, concerns, scheduler work, simple lookup, basic file/session inspection, or routine state changes (`src/core/tools/analysis-workbench/tools.ts:13`). The tool requires a `task`, supports bounded iteration/token overrides, records trace telemetry, records focus evidence when available, and returns a concise execution header with iterations, tokens, duration, evidence, truncation, and budget stop reason (`src/core/tools/analysis-workbench/tools.ts:24`, `src/core/tools/analysis-workbench/tools.ts:48`, `src/core/tools/analysis-workbench/tools.ts:59`, `src/core/tools/analysis-workbench/tools.ts:104`).

The underlying RLM loop enforces wall-time, invocation rate, daily cost, charge quota, nested-analysis depth, iterations, tokens, sub-query, tool-call, and memory budgets (`src/core/tools/analysis-workbench/loop.ts:42`, `src/core/tools/analysis-workbench/loop.ts:183`, `src/core/tools/analysis-workbench/loop.ts:211`, `src/core/tools/analysis-workbench/loop.ts:271`). Routine memory/ops/reflection intents filter the core `analysis_workbench` tool unless the user explicitly asks for large-evidence analysis (`src/core/agent/substrate-agent/tool-runtime-facade.ts:117`, `src/core/agent/substrate-agent/tool-runtime-facade.ts:125`, `src/core/agent/substrate-agent/tool-runtime-facade.ts:711`).

## Charge And Budget System

Sprint 8 introduced a first-class charge policy and charge ledger. The charge-policy contract defines lanes, surfaces, reference model classes, quotas, costs, and user-facing rationale fields (`src/shared/contracts/charge-policy.ts:1`, `src/shared/contracts/charge-policy.ts:41`). The seed file provides default chat, extraction, analysis, subagent, media, maintenance, and other charge surfaces (`config/charge-policy.seed.json:1`). The charge policy loader validates schema version, unknown keys, quotas, costs, rationale requirements, and saves/loads through owner-file paths (`src/system/config/charge-policy-config.ts:136`, `src/system/config/charge-policy-config.ts:225`).

At runtime, `runWithChargeContext` scopes nested charge accounting and folds child contexts back into parent contexts (`src/shared/telemetry/run-charge.ts:324`). `chargeSurface` enforces quotas and emits `agent.charge` events (`src/shared/telemetry/run-charge.ts:359`). `RunChargeLedger` subscribes to those events, appends JSONL records, and exposes aggregate/list APIs for Garden and audit (`src/shared/telemetry/charge-ledger.ts:151`, `src/shared/telemetry/charge-ledger.ts:193`, `src/shared/telemetry/charge-ledger.ts:264`, `src/shared/telemetry/charge-ledger.ts:368`).

Prompt context includes a charge budget block that tells the companion current turn quota, historical visibility, costed escalation surfaces, zero-cost alternatives, and when to use `analysis_workbench` (`src/core/agent/substrate-agent/runtime-context.ts:142`, `src/core/agent/substrate-agent/runtime-context.ts:164`, `src/core/agent/substrate-agent/runtime-context.ts:879`). Garden creates the charge ledger service from the companion data directory and exposes `/api/admin/charges` with limit/since/until/runId filters (`src/operator/garden/local-admin-contract.ts:103`, `src/operator/garden/local-admin-contract.ts:147`, `src/operator/garden/api-routes.ts:454`). The Garden client has a dedicated endpoint and page for policy editing, active/recent spend, lane quotas, historical windows, and owner-file editing (`admin-ui/src/lib/api/endpoints/charges.ts:21`, `admin-ui/src/routes/charge-budget/+page.svelte:61`, `admin-ui/src/routes/charge-budget/+page.svelte:209`, `admin-ui/src/routes/charge-budget/+page.svelte:315`, `admin-ui/src/routes/charge-budget/+page.svelte:477`).

## Garden And Operator Surfaces

Garden is now organized into five sections: Live Operations, Memory & Identity, Runtime & Tools, Review & Safety, and Configure Garden (`admin-ui/src/lib/nav.ts:25`). Dedicated pages include scheduler, action pipe, memory, L0.1 episodes, identity, model room, models, charge/budget, tools, prompts, prompt monitor, confirmations, telemetry, settings, theme, and primer (`admin-ui/src/lib/nav.ts:26`, `admin-ui/src/lib/nav.ts:33`, `admin-ui/src/lib/nav.ts:40`, `admin-ui/src/lib/nav.ts:48`, `admin-ui/src/lib/nav.ts:54`).

Episodic memory is visible through dedicated admin routes for episodes, threads, arcs, provenance, and detail (`src/operator/garden/api-routes-episodic-memory.ts:40`). The data service validates pagination, ISO time filters, thread IDs, arc kind, and arc direction, then returns episode lists, thread summaries, details, provenance, and related arcs (`src/operator/garden/services/episodic-memory-service.ts:122`, `src/operator/garden/services/episodic-memory-service.ts:125`, `src/operator/garden/services/episodic-memory-service.ts:161`, `src/operator/garden/services/episodic-memory-service.ts:181`, `src/operator/garden/services/episodic-memory-service.ts:200`). The Garden frontend calls those APIs through typed endpoint helpers (`admin-ui/src/lib/api/endpoints/episodic-memory.ts:36`, `admin-ui/src/lib/api/endpoints/episodic-memory.ts:44`, `admin-ui/src/lib/api/endpoints/episodic-memory.ts:60`, `admin-ui/src/lib/api/endpoints/episodic-memory.ts:69`).

Charge and audit are also first-class operator concerns. The admin contract wires charge ledger into audit history, then exposes it as a domain service (`src/operator/garden/local-admin-contract.ts:109`, `src/operator/garden/local-admin-contract.ts:146`). Garden request routing keeps client-page routing separate from API/health/login and SvelteKit build-asset paths, and only serves client routes when Garden UI is enabled (`src/operator/garden/server-request-routing.ts:50`, `src/operator/garden/server-request-routing.ts:78`, `src/operator/garden/server-request-routing.ts:116`).

## External Dependencies

| Dependency | Purpose | Criticality |
| --- | --- | --- |
| `@mariozechner/pi-agent-core` | Core agent runtime and tool-call substrate. | Critical |
| `@mariozechner/pi-ai` | LLM provider interaction substrate. | Critical |
| `better-sqlite3` | Local SQLite persistence for memory/session projections and stores. | Critical |
| `sqlite-vec` | Vector search for memory retrieval. | Critical for embeddings retrieval |
| `pg` | Optional PostgreSQL-backed session projection/adapters. | Optional |
| `@huggingface/transformers` | Local in-process embeddings profile. | Optional, profile-dependent |
| OpenAI-compatible model providers | Chat, extraction, reasoning, embeddings, vision, and media model access through gateway/provider config. | Critical in remote-provider deployments |
| Discord, Telegram, Wyoming, WebSocket voice libraries | Channel and embodiment adapters. | Optional by channel |
| Svelte 5 Garden | Human/operator-facing admin UI. | Foundational operational surface |
| Docker Compose | Production/containerized agent isolation paths. | Deployment-dependent |

Admin chat and runtime surfaces are implemented by the native SvelteKit Garden UI under `admin-ui`, not by an external UI package.

Pinned dependency versions live in `package.json` and the repo overrides high-risk transitive versions such as `undici`, `fast-xml-parser`, `tar`, and `rollup` (`package.json:68`, `package.json:91`).

## Test Infrastructure

| Area | Location | Notes |
| --- | --- | --- |
| Root unit/integration tests | `src/**/*.test.ts` | 386 test files cover gateway, API, scheduler, settings, memory, trust, Garden server routes, tools, and persistence. |
| Garden unit tests | `admin-ui/src/**/*.test.ts` | 15 test files cover provider/model helpers and UI-supporting utilities. |
| E2E scripts | `package.json:49`, `package.json:50`, `package.json:51`, `package.json:53` | Chat, voice, cockpit smoke, and walkthrough scripts. |
| Repository hygiene | `package.json:59`, `package.json:60`, `package.json:61`, `package.json:62` | Public sanitization, identity literal scans, and dependency-cycle verification. |
| Settings contract | `package.json:63` | Required when touching settings owner files or Garden settings surfaces. |
| Startup owner files | `package.json:55` | Verifies owner-file startup contracts. |

High-value Sprint 8 test anchors include charge policy and ledger tests (`src/system/config/charge-policy-config.test.ts:76`, `src/shared/telemetry/charge-ledger.test.ts:1`, `src/operator/garden/api-routes-charge-ledger.test.ts:72`), Garden routing tests (`src/operator/garden/server-request-routing.test.ts:19`), scheduler policy and rest-window tests (`src/core/scheduler/heartbeat-policy.test.ts:1`, `src/core/scheduler/rest-window.test.ts:1`), settings contract tests (`src/system/config/settings-contract-guard.test.ts:18`, `src/system/settings.test.ts:143`), persistence layout tests (`src/persistence/layout.test.ts:73`), and analysis workbench/tool policy tests (`src/core/tools/analysis-workbench/tools.test.ts:1`, `src/core/agent/substrate-agent/tool-runtime-facade.test.ts:1`).

Operational shakedown evidence for Sprint 8 lived outside the tracked repo during testing. This tracked report intentionally captures the code architecture that survived that process, while transient shakedown artifacts remain out of `main`.

## Operational Gotchas

Owner files are authoritative. Do not add new mutable settings by reading `.env` directly; wire the owner-file contract, Garden exposure, and tests together (`README.md:131`, `src/system/config/startup-owner-files.ts:80`, `src/operator/garden/services/settings-service.ts:376`).

The split runtime boundary is security-critical. Gateway holds credentials and network access, while the agent talks through `GatewayClient` and should not gain direct secret/network shortcuts (`docs/PSFN_PROJECT_CHARTER.md:106`, `docs/PSFN_PROJECT_CHARTER.md:209`, `src/app/agent/main.ts:94`).

`analysis_workbench` is not routine reasoning. Direct semantic tools, `tool_search`, and `toolset` are preferred for normal work; the workbench is for bounded large-evidence analysis with explicit budget accounting (`src/core/tools/analysis-workbench/tools.ts:16`, `src/core/agent/substrate-agent/tool-runtime-facade.ts:718`).

Episodic memory is a scoped chain system, not a giant rollup layer. Long themes should be traversed through arcs and retrieved by relevance rather than collapsed into one enormous memory record (`src/faculties/memory/episodic/store.ts:298`, `src/faculties/memory/retrieval/episodic.ts:198`).

Garden must reflect real runtime and owner-file state. If a feature affects live operation, tunable settings, auditing, memory visibility, budget/cost behavior, or safety review, it should have a Garden/API surface rather than remaining hidden in logs or manual JSON edits (`docs/PSFN_PROJECT_CHARTER.md:73`, `docs/PSFN_PROJECT_CHARTER.md:84`, `src/operator/garden/local-admin-contract.ts:136`).

## Forward Work

The Sprint 8 architecture leaves three obvious next architecture threads for Sprint 9:

| Thread | Why it matters | Current anchor |
| --- | --- | --- |
| Turn-level performance telemetry | Needed to distinguish slow model calls from local queueing, tool loops, runtime contention, and healthcheck starvation. | Existing charge/workbench telemetry captures iterations, tokens, duration, warnings, and nested analysis traces (`src/core/tools/analysis-workbench/tools.ts:59`). |
| Companion model-fit evals | Needed to detect personality drift, refusal style changes, tool overuse, and emotional-continuity regressions before swapping primary models. | Eval scripts already exist for model/probe work (`package.json:38`, `package.json:46`). |
| Long-running cost and model-use analytics | Needed for budget planning across chat, extraction, analysis, media, shards, and future modality-heavy use. | Charge policy/ledger and Garden charge page provide the foundation (`src/shared/telemetry/charge-ledger.ts:264`, `admin-ui/src/routes/charge-budget/+page.svelte:355`). |
