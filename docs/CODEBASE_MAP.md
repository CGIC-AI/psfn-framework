---
last_mapped: 2026-06-29
branch: sprint_9_final
code_audit_anchor: 1956b844
package_version: 0.1.0
tracked_runtime_source_files: 1492
tracked_runtime_test_files: 501
tracked_runtime_source_lines: 462950
---

# Codebase Map

This is a human-maintained map of the current PSFN codebase. The runtime entrypoints and contracts in `src/` remain the source of truth when this map drifts.

## System Shape

PSFN is a split TypeScript runtime for long-lived AI companions:

```text
External channels, API clients, Garden browser
        |
        v
Gateway process
  - provider secrets and outbound network
  - LLM and embedding clients
  - URL, filesystem, shell, git, vault, beads, media policy
  - Discord, Telegram, API, voice, Wyoming host surfaces
        |
        | JSON-RPC 2.0 over NDJSON Unix socket
        v
Agent process
  - companion loop and prompt/runtime state
  - Postgres-backed memory, contacts, intentions, scratchpad
  - L0 JSONL sessions and L0.1 episodic synthesis
  - scheduler, post-turn actions, private admin transport
        |
        v
PostgreSQL + JSON owner files + session JSONL + workspace files
```

The legacy `src/app/startup/index.ts` entrypoint is disabled and exits fail-closed. Use the split runtime (`npm run split`) or launch gateway, agent, and operator separately.

## Entry Points

| Entry | File/script | Purpose |
| --- | --- | --- |
| Split launcher | `npm run split`, `scripts/start-gateway-agent.sh` | Starts gateway + agent + operator through the supported local path. |
| Gateway | `src/app/gateway/main.ts` | Host-side privileged edge; loads `.env`, owner-file config, provider clients, channel surfaces, RPC server, public API, and voice surfaces. |
| Agent | `src/app/agent/main.ts` | Isolated companion runtime; enforces startup network isolation, connects to gateway, composes persistence/runtime, and runs the companion loop. |
| Operator | `src/app/operator/main.ts` | Garden/operator HTTP/UI surface plus private admin transport proxying. |
| Containerized agent | `npm run agent:docker`, `npm run agent:docker:continuous` | Docker profiles for isolated agent operation. |
| Garden build/dev | `npm run garden:build`, `npm run garden:dev` | Builds or serves the Svelte 5 admin UI. |

## Top-Level Tree

```text
src/
  app/
    gateway/                 # Privileged host process
    agent/                   # Isolated companion process
    operator/                # Garden/operator process
    startup/                 # Shared split-runtime composition and parity wiring
  boundary/                  # Gateway RPC, custody, filesystem/git/web/shell/vault/beads/media adapters
  channels/                  # Discord, Telegram, OpenAI-compatible API, voice, Wyoming, backplane config
  core/                      # SubstrateAgent, prompt stack, scheduler, turns, tools, identity, intention
  faculties/                 # Memory, wiki, skills, values, media, subagents, shards, core memory
  operator/garden/           # Admin server, API routes, services, audit, telemetry, action pipe
  persistence/               # Runtime layout, Postgres migrations, sessions, backups, repair, lifecycle
  primitives/                # LLM provider ports, request context, voice primitives
  shared/                    # Runtime contracts, telemetry, event bus, routing, utilities
  system/                    # Config, owner files, settings, capabilities, trust, lifecycle, logging

admin-ui/                    # Svelte 5 Garden SPA
config/                      # Seed owner files; templates only, not runtime authority
deployment/                  # Repo-owned systemd and deployment artifacts
docker/                      # Agent container config
docs/                        # Current markdown docs and historical specs
proxy/                       # LiteLLM proxy config
satellites/                  # Satellite/remote host integration work
```

## Runtime And Composition

| Area | Main files | Notes |
| --- | --- | --- |
| Startup config | `src/system/config/load-config.ts`, `src/system/config/startup-owner-files.ts`, `src/system/config/runtime-config.ts` | Loads env-owned wiring, hydrates JSON owner files, validates strict ownership, and rejects unsafe production TLS/network overrides. |
| Layout | `src/persistence/layout.ts` | Resolves system data, companion data, workspace, logs, tmp, backup, and production split-root invariants. |
| Gateway RPC | `src/boundary/gateway/server.ts`, `src/boundary/gateway/client.ts`, `src/boundary/gateway/protocol.ts` | NDJSON JSON-RPC transport between privileged gateway and isolated agent, including reverse RPC for voice/channel paths. |
| Composition | `src/app/startup/composition/composition.ts`, `src/app/agent/core-runtime.ts` | Builds sessions, memory, prompt runtime, tools, scheduler, shard/subagent internals, and admin surfaces. |
| Agent loop | `src/core/agent/substrate-agent.ts` | Main pi-agent-core integration, prompt/context assembly, tool dispatch, streaming, post-turn actions, and observability. |
| Scheduler | `src/core/scheduler/` | Heartbeat, daily/weekly reflection templates, reminders, follow-ups, rest-window work, maintenance, backups, and scheduled prompts. |

## Persistence

Runtime persistence is Postgres-first:

| Data | Runtime backing | Notes |
| --- | --- | --- |
| L0 sessions | Append-only JSONL | Canonical conversation history remains file-backed and rebuildable. |
| Session projection/search | PostgreSQL projection | Searchable copies are projections and can be repaired from JSONL. |
| L0.1 episodes | PostgreSQL | `l01_episodes`, spans, arcs, lineage, candidates, reviews, watermarks. |
| L2 typed memories | PostgreSQL + `pgvector` | `l2_memories.embedding` is searched database-side; missing pgvector fails closed. |
| Contacts/intentions/concerns | PostgreSQL | Trust, channel identity, machine-intelligence flags, follow-ups, and active concerns. |
| Scratchpad | PostgreSQL table + JSON mirror | `scratchpad_entries` with optional `notes/scratchpad.json` mirror. |
| Owner config | JSON owner files | `settings.json`, `models.json`, `providers.json`, `scheduler.json`, `capability-tier.json`, `trust-policy.json`, `charge-policy.json`, `backup.json`, `skills.json`, and managed `channels.json`. |
| Workspace docs/wiki | `WORKSPACE_PATH` | Personal files, generated media, wiki, authored skills/modules, experiments. Must not overlap runtime roots. |

SQLite and sqlite-vec code remains for legacy migration, repair, parity tests, and adapter tests. New runtime behavior should not pick SQLite as a fallback.

## Memory Subsystems

| Layer | Code | Responsibility |
| --- | --- | --- |
| L0 | `src/core/session/`, `src/persistence/sessions/` | Append-only channel journals, active context windows, continuity, compaction, integrity boundaries. |
| L0.1 | `src/faculties/memory/episodic/`, `src/shared/contracts/episodic-memory.ts` | Bounded lived episode landmarks with spans, artifacts, salience, affect, arcs, dream-pass meaning, and Garden visibility. |
| L1 | `src/core/turns/snapshot.ts`, `src/core/session/manager.ts` | Prompt-facing active context assembled from sessions, memory, orientation, scratchpad, and tool/runtime state. |
| L2 | `src/faculties/memory/postgres-store.ts`, `src/faculties/memory/retrieval.ts`, `src/faculties/memory/writer.ts` | Typed long-term memories, embeddings, trust filtering, contradiction handling, salience decay, and provenance. |
| Group memory | `src/faculties/memory/group-*`, `src/operator/garden/services/group-memory-diagnostics-service.ts` | Direct/group/auto extraction, attribution, salience gates, watermarks, backfill, and diagnostics. |
| Wiki/journal/scratchpad | `src/faculties/wiki/`, `src/boundary/integrations/journal/`, `src/faculties/memory/tools.ts` | Separate durable reference docs, durable markdown journal notes, and temporary working context. |

## Tool Surface

Canonical first-party tool metadata lives in `src/core/agent/tool-surface/registry.ts`; implementation wiring is spread across agent composition and gateway services.

| Category | Current surfaces |
| --- | --- |
| Adaptive control | `tool_search`, `toolset`, `response_control` |
| Workspace/external primitives | `fs`, `repo`, `shell`, `web`, `analysis_workbench` |
| Companion state | `memory`, `scratchpad`, `contact`, `session`, `identity`, `orient`, `north_star`, `schedule`, `self_status`, `system`, `skill`, `wiki`, `journal` |
| Operations/media | `beads`, `notify`, `media`, `selfie_create`, `vault` |
| Workers | `subagent`; direct `shard` is reserved while shard internals mature |

Retired aliases such as `session_new`, `fs_read`, `repo_diff`, `notify_operator`, `image_create`, and `spawn_subagent` must not be reintroduced as top-level callable names. Use `docs/tool-surface.md` when changing this layer.

## Garden And Operator UI

| Area | Files | Notes |
| --- | --- | --- |
| Server/routes | `src/operator/garden/server.ts`, `src/operator/garden/api-routes*.ts` | REST/admin API, health/login, multipart handling, WebSocket events, client route serving. |
| Services | `src/operator/garden/services/` | Dashboard, memory, episodic memory, sessions, contacts, settings, scheduler, prompts, charge, action pipe, audit, tools. |
| Frontend | `admin-ui/src/` | Svelte 5 SPA served at admin host root when `admin-ui/build` exists. There is no `/garden` prefix for integrated production serving. |
| Settings | `src/operator/garden/services/settings-service.ts` | Saves JSON owner-file domains rather than env-owned mutable settings. |

## External Channels

| Channel | Code | Notes |
| --- | --- | --- |
| Discord | `src/channels/discord/` | Text, typing, voice integration, per-channel serialization, group-memory topology. |
| Telegram | `src/channels/telegram/` | Polling/webhook, allowlist, identity linking, long-running status. |
| API | `src/channels/api/` | OpenAI-compatible `/v1/chat/completions`, streaming, auth, voice WebSocket primitives. |
| Wyoming | `src/channels/wyoming/`, `satellites/` | Home Assistant Voice PE integration and satellite/shard delegation work. |
| Backplane config | `src/channels/backplane/config.ts` | `channels.json` owner, credential refs, group-memory overrides, external channel profiles. |

## Safety And Boundaries

- Gateway owns secrets, network, URL policy, SSRF checks, filesystem/shell policy, and privileged host tools.
- Agent startup enforces network isolation and should not receive provider/API secrets.
- Owner files are strict; mutable settings should not drift back to `.env`.
- Production roots must not overlap; `WORKSPACE_PATH` is personal writable files, not runtime state.
- Unknown providers, malformed settings, unavailable `pgvector`, unsafe TLS overrides, missing backup encryption keys, and missing security-sensitive dependencies fail closed.
- Group memory changes extraction only; observed group messages must never trigger unsolicited replies.
- Shard/subagent outputs carry provenance and review state; shard-derived memory does not silently overwrite core state.

## Validation Commands

Common commands:

```bash
npm run lint
npm run build
npm test
npm run verify:settings-contract
npm run verify:startup-owner-files
npm run verify:backup-restore
npm run smoke:chat
npm run e2e
npm run e2e:voice
```

Use targeted tests when the change surface is narrow, but this repo requires `npm run lint` before closing tracked code work.

## Where To Look First

| Question | Start here |
| --- | --- |
| How does the runtime start? | `src/app/gateway/main.ts`, `src/app/agent/main.ts`, `src/app/operator/main.ts` |
| Why did startup reject config? | `src/system/config/load-config.ts`, `src/system/config/startup-owner-files.ts`, `src/persistence/layout.ts` |
| How is memory retrieved or written? | `src/faculties/memory/retrieval.ts`, `src/faculties/memory/writer.ts`, `src/faculties/memory/postgres-store.ts` |
| What can the model call? | `src/core/agent/tool-surface/registry.ts`, `docs/tool-surface.md` |
| How are settings edited? | `src/operator/garden/services/settings-service.ts`, `src/system/settings/contracts.ts` |
| What is the live operator procedure? | `docs/operations.md` |
| What work remains? | `docs/development-status.md` and `bd ready --json` |
