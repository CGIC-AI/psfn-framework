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
   - `src/index.ts`
   - `src/gateway-main.ts`
   - `src/agent-main.ts`
   - `src/bootstrap/composition.ts`
   - `src/bootstrap/parity.ts`
2. Config and persistence contracts
   - `src/types.ts`
   - `src/settings.ts`
   - `src/config/settings-contract.ts`
   - `src/config/runtime-config.ts`
   - `src/persistence/layout.ts`
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

- `src/index.ts`: disabled fail-closed entrypoint with dotenv
- `src/gateway-main.ts`: host-side gateway holding secrets and external egress
- `src/agent-main.ts`: isolated agent process, no dotenv import, gateway-backed providers

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
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`

See `src/config/settings-contract.ts` for the owner map and schema metadata.

### Two-root persistence

PSFN uses split persistence topology.

- `system-data`: system-owned config and operator/runtime state
- `companion-data`: character, prompts, sessions, notes, memories, and related companion artifacts

`src/persistence/layout.ts` enforces fail-closed path rules. Production mode rejects overlapping mutable roots.

## Architecture Map

Key directories that matter now:

```text
src/
  agent/              agent loop, tool orchestration, background continuation
  backup/             scheduled backup and restore verification
  beads/              gateway-backed bd tools
  bootstrap/          shared parity and composition wiring
  capabilities/       tiers, confirmations, safeguards, eligibility
  channels/           admin, api, discord, telegram, wyoming
  compositional/      compose/evaluate policy and helpers
  contacts/           trust-aware contact state and tools
  context-feedback/   post-turn context scoring
  emotion/            classifiers, state, persona adaptation
  gateway/            RPC server/client, policy, TLS, SSRF, audit
  git/                repo ops and self-modification tools
  identity/           character card, prompt stack, versioning
  llm/                routing, retries, discovery, model budgets
  memory/             extraction, retrieval, decay, writer
  modules/            runtime module registry and loader
  persistence/        layout, cutover, path helpers
  repl/               think and sub-think tooling
  self-model/         internal state and metacognition
  session/            journal, provenance, compaction, manifests
  settings/           schema/coercion/runtime settings helpers
  shards/             child-agent orchestration
  skills/             skill storage and tools
  values/             values journal and tools
  vault/              Obsidian integration
  voice/              connectors, transports, runtime, policies
```

## Architecture Highlights

### Registries and adapters

- channels, STT, and TTS resolve through registries/manifests with fail-closed activation and parity across runtime modes
- key files: `src/runtime/channel-lifecycle.ts`, `src/runtime/bootstrap-helpers.ts`, `src/channels/config.ts`, `src/voice/connectors/stt/`, `src/voice/connectors/tts/`

### Config ownership and Garden exposure

- mutable runtime settings are owned by canonical JSON files, guarded by owner-file validation, and exposed through Garden/admin APIs
- key files: `src/config/settings-contract.ts`, `src/config/settings-contract-guard.ts`, `src/channels/admin/api-routes.ts`, `admin-ui/`

### Persistence and layout

- system-owned state lives under `system-data`; companion artifacts live under `companion-data`; cutover helpers and path guards enforce the topology
- key files: `src/persistence/layout.ts`, `src/migrate-persistence-layout.ts`, `src/config/runtime-config.ts`, `src/runtime/bootstrap-helpers.ts`

### Cognition and context

- retrieval, extraction, appraisal, nested `sub_think`, context manifests, observation masking, and context feedback all feed runtime decision-making
- key files: `src/compositional/policy.ts`, `src/memory/extraction/`, `src/memory/retrieval.ts`, `src/intention/`, `src/repl/`, `src/session/`, `src/context-feedback/`

### Affect, self-model, and background work

- emotion state, active concerns, self-model snapshots, metacognitive flags, background continuation, and shard lifecycle management are first-class runtime surfaces
- key files: `src/emotion/`, `src/intention/`, `src/self-model/`, `src/agent/background-completion-delivery-queue.ts`, `src/agent/background-completion-policy.ts`, `src/shards/manager.ts`

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
- shard and think tools
- promoted-tool management tools

Tool surface split:

- direct agent tools are registered as `core` or `extended` and participate in `load_tools`, promotion, and adaptive-tool telemetry
- REPL-only helpers exist only inside `think` / `sub_think` sandbox execution and are not direct tool-catalog entries
- shared names can appear in both places, so docs and Garden should call out whether a tool is direct, REPL-only, or both

Main wiring locations:

- `src/bootstrap/composition.ts`
- `src/bootstrap/parity.ts`
- `src/agent-main.ts`

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
