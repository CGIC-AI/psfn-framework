# CLAUDE.md - PSFN Substrate Framework

This file is the technical orientation note for coding assistants working on PSFN.

For task tracking, use `bd` and follow [AGENTS.md](./AGENTS.md).

## What This Repo Is

PSFN is a TypeScript runtime for long-lived AI companions.

The codebase currently supports:

- split gateway/agent runtime with policy enforcement
- persistent session and memory systems
- trust-aware privacy and contact modeling
- self-modification surfaces for prompts, code, modules, skills, values, and vault notes
- voice, chat, admin, and protocol adapters across multiple channels
- registry-driven adapters, schema-owned config, compositional cognition, and internal-state modeling

## Source Of Truth

When checking behavior, prefer this order:

1. Runtime entrypoints and composition
   - `src/app/gateway/main.ts`
   - `src/app/agent/main.ts`
   - `src/app/operator/main.ts`
   - `src/app/startup/composition/composition.ts`
2. Config and persistence contracts
   - `src/system/config/runtime-config-contracts.ts`
   - `src/system/config/load-config.ts`
   - `src/system/config/settings-contract-guard.ts`
   - `src/system/config/startup-owner-files.ts`
   - `src/persistence/layout.ts`
   - `src/persistence/runtime-factory.ts` (Postgres-only runtime persistence)
3. Product/runtime overview and deeper design docs
   - `README.md`
   - `docs/specifications.md`
   - `docs/architecture.md`
   - `docs/memory.md`
   - `docs/operations.md`
   - `docs/setup.md`
4. Bootstrap template only
   - `.env.example`

`.env.example` is a starter template, not the canonical authority for mutable runtime settings.

## Runtime Entry Points

```bash
npm run split               # same launcher, explicit name
npm run gateway             # gateway only
npm run agent               # agent only
npm run yolo                # split launcher with broader fs.read policy
npm run agent:docker
npm run agent:docker:continuous
```

Entry point roles:

- `src/app/startup/index.ts`: disabled fail-closed entrypoint with dotenv
- `src/app/gateway/main.ts`: host-side gateway holding secrets and external egress
- `src/app/agent/main.ts`: isolated agent process, no dotenv import, gateway-backed providers

## Configuration And Persistence Model

Configuration uses strict owner-file contracts.

### Env scope

Use `.env` for:

- secrets
- process wiring
- host/port/socket configuration
- layout/runtime mode selection
- explicit bootstrap-only overrides

Do not use `.env` as the source of truth for mutable runtime settings that now live in JSON owners.

### JSON owner files

Canonical mutable config owners live in the system-owned config domain:

- `settings.json`
- `models.json`
- `providers.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`
- `charge-policy.json`
- `backup.json`

See `src/system/config/settings-contract-guard.ts` and `src/system/config/startup-owner-files.ts` for the owner map and schema metadata.

### Two-root persistence

PSFN uses split persistence topology.

- `system-data`: system-owned config and operator/runtime state
- `companion-data`: character, prompts, sessions, notes, memories, and related companion artifacts

`src/persistence/layout.ts` enforces fail-closed path rules. Production mode rejects overlapping mutable roots.

## Architecture Map

Key directories that matter now:

```text
src/
  app/                entrypoints (gateway, agent, operator, startup composition, maintenance, e2e)
  boundary/           gateway RPC/policy/SSRF/audit, sandbox execution, fs/git/web/shell/vault/beads adapters, credential vault
  channels/           api, discord, telegram, wyoming, voice, backplane transports
  core/               SubstrateAgent, prompts/identity, scheduler, session, emotion, self-model, intention, contacts, tools
  faculties/          memory (extraction/retrieval/episodic/sleeptime), skills, subagents, shards, media, core-memory, values, context-feedback
  operator/garden/    Garden server, admin routes, services, audit/telemetry
  persistence/        runtime layout, sessions, JSONL journals, Postgres stores/migrations, backups, repair
  primitives/         LLM provider ports, images, voice transports, request context
  shared/             contracts, event bus, telemetry, routing, logger, utilities
  system/             config owner files, settings contract, capabilities, trust, lifecycle
```

## Architecture Highlights

### Registries and adapters

- channels, STT, and TTS resolve through registries/manifests with fail-closed activation and parity across runtime modes
- key files: `src/channels/`, `src/primitives/voice/`, `src/app/startup/composition/composition.ts`

### Config ownership and Garden exposure

- mutable runtime settings are owned by canonical JSON files, guarded by owner-file validation, and exposed through Garden/admin APIs
- key files: `src/system/config/settings-contract-guard.ts`, `src/system/config/startup-owner-files.ts`, `src/operator/garden/api-routes.ts`, `admin-ui/`

### Persistence and layout

- system-owned state lives under `system-data`; companion artifacts live under `companion-data`; cutover helpers and path guards enforce the topology
- key files: `src/persistence/layout.ts`, `src/app/maintenance/migrate-persistence-layout.ts`, `src/persistence/runtime-factory.ts` (PostgreSQL-only runtime stores), `src/system/config/load-config.ts`

### Cognition and context

- retrieval, extraction, appraisal, analysis workbench context, context manifests, observation masking, and context feedback all feed runtime decision-making
- key files: `src/faculties/memory/extraction/`, `src/faculties/memory/retrieval.ts`, `src/core/intention/`, `src/core/session/` (context manifests, attribution guard), `src/core/tools/analysis-workbench/`, `src/faculties/context-feedback/`

### Affect, self-model, and background work

- emotion state, active concerns, self-model snapshots, metacognitive flags, background continuation, and shard lifecycle management are first-class runtime surfaces
- key files: `src/core/emotion/`, `src/core/intention/`, `src/core/self-model/`, `src/core/agent/post-turn-action-runtime.ts`, `src/core/scheduler/heartbeat-post-turn-runtime.ts`, `src/faculties/shards/manager.ts`

## Channels And Interfaces

Implemented runtime surfaces:

- Discord text and voice
- Telegram text plus attachments, polling, and webhook modes
- OpenAI-compatible API at `/v1/chat/completions`
- API voice websocket runtime
- Garden admin UI at `/garden`
- Wyoming TCP server and service registry

Notes:

- `/garden` is the primary admin surface.
- Admin request routing is `/login`, `/garden`, and `/api/admin/*`.
- The admin API surface under `/api/admin/*` is extensive and actively used by the Garden UI.

## Tools And Agent Surfaces

Do not rely on hardcoded tool counts in docs. The live set is wired across runtime composition.

Current implemented tool families include:

- memory and scratchpad tools
- core-memory tools
- contacts and trust tools
- prompt and character-card tools
- git repo tools
- vault tools
- skills tools
- values tools
- session and focus tools
- heartbeat and scheduling tools
- lifecycle tools
- beads issue tools
- shard and analysis workbench tools
- promoted-tool management tools

Tool surface split:

- direct agent tools are registered as `core` or `extended` and participate in `load_tools`, promotion, and adaptive-tool telemetry
- REPL-only helpers exist only inside `analysis_workbench` sandbox execution and are not direct tool-catalog entries
- shared names can appear in both places, so docs and Garden should call out whether a tool is direct, REPL-only, or both

Main wiring locations:

- `src/app/startup/composition/composition.ts`
- `src/app/agent/main.ts`
- `src/persistence/runtime-factory.ts`

## Validation Commands

Use the narrowest command set that proves the change.

Common commands:

```bash
npm run build
npm test
npm run lint
npm run verify:repository-hygiene
npm run verify:settings-contract
npm run verify:backup-restore
npm run smoke:chat
npm run e2e
npm run e2e:voice
```

For runtime parity and plugin wiring, targeted tests are often better than full-suite runs.

## Current Development Posture

Treat the repo as active implementation, not as a planning branch. Determine current work from `bd`, the entrypoints above, and the live code paths rather than roadmap language.

## Working Rules

- Fail closed.
- No swallowed errors.
- No legacy compatibility shims.
- No silent fallback behavior for required config or security-sensitive paths.
- Verify new code is actually wired to a runtime entrypoint or registry path.
- Keep docs, config ownership, and tests aligned in the same change.


<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:ca08a54f -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   bd dolt push
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->
