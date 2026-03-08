# CLAUDE.md - PSFN Substrate Framework

This file is the technical orientation note for coding assistants working on PSFN.

For task tracking, use `bd` and follow [AGENTS.md](./AGENTS.md).

## What This Repo Is

PSFN is a TypeScript runtime for long-lived AI companions.

The codebase currently supports:

- single-process development runtime
- split gateway/agent runtime with policy enforcement
- persistent session and memory systems
- trust-aware privacy and contact modeling
- self-modification surfaces for prompts, code, modules, skills, values, and vault notes
- voice, chat, admin, and protocol adapters across multiple channels
- Phase V foundation work for plugin seams, schema-driven config ownership, compositional cognition, and deeper internal-state modeling

Do not describe this branch as "pre-Phase-V" or "planning only". The branch already contains substantial landed Phase V implementation.

## Source Of Truth

When checking behavior, prefer this order:

1. Runtime entrypoints and composition
   - `src/index.ts`
   - `src/runtime.ts`
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
3. Branch execution ledger
   - `PHASE_V.md`
4. Bootstrap template only
   - `.env.example`

`.env.example` is a starter template, not the canonical authority for mutable runtime settings.

## Runtime Entry Points

```bash
npm run dev
npm run gateway
npm run agent
npm run split
npm run yolo
npm run agent:docker
npm run agent:docker:continuous
```

Entry point roles:

- `src/index.ts`: single-process runtime with dotenv
- `src/gateway-main.ts`: host-side gateway holding secrets and external egress
- `src/agent-main.ts`: isolated agent process, no dotenv import, gateway-backed providers
- `src/runtime.ts`: single-process `SubstrateRuntime`

## Configuration And Persistence Model

Phase V changed the configuration contract in important ways.

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

Phase V landed split persistence topology.

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

## Implemented Phase V Work

This section is about landed code, not future intent.

### Plugin seams and fail-closed registries

Implemented:

- channel adapter manifest loading
- STT provider registry
- TTS provider registry
- eligibility-gated plugin activation
- bootstrap parity across single-process and split runtime

Relevant files:

- `src/runtime/channel-lifecycle.ts`
- `src/runtime/bootstrap-helpers.ts`
- `src/channels/config.ts`
- `src/voice/connectors/stt/`
- `src/voice/connectors/tts/`

### Settings governance

Implemented:

- backend settings schema metadata
- owner-file contract enforcement
- Garden settings schema exposure
- contract tests and settings guard

Relevant files:

- `src/config/settings-contract.ts`
- `src/config/settings-contract-guard.ts`
- `src/channels/admin/api-routes.ts`
- `admin-ui/` settings surfaces

### Persistence/config topology

Implemented:

- split `system-data` and `companion-data`
- env scope reduction for JSON-owned settings
- persistence cutover tooling
- seed-default hydration and migration warnings

Relevant files:

- `src/persistence/layout.ts`
- `src/migrate-persistence-layout.ts`
- `src/config/runtime-config.ts`
- `src/runtime/bootstrap-helpers.ts`

### Compositional cognition

Implemented:

- policy-gated compositional extraction
- retrieval rerank and compose path
- post-turn intention appraisal composition
- nested `sub_think` with budget/depth controls
- shard focused context packs
- compositional telemetry and diagnostics

Relevant files:

- `src/compositional/policy.ts`
- `src/memory/extraction/`
- `src/memory/retrieval.ts`
- `src/intention/`
- `src/repl/`
- `src/shards/`

### Context composition improvements

Implemented:

- tool observation persistence
- observation masking window
- context manifests
- stable-prefix optimization
- context feedback scoring

Relevant files:

- `src/session/tool-observation.ts`
- `src/session/context-manifest.ts`
- `src/session/manager/context-builder.ts`
- `src/context-feedback/`

### Affect, intention, and self-model

Implemented:

- continuous emotion state and classifiers
- persona adaptation
- active concerns and motivation bridge
- internal-state snapshots
- metacognitive flags in runtime metadata

Relevant files:

- `src/emotion/`
- `src/intention/`
- `src/self-model/`

### Early distributed-autonomy slices

Implemented:

- deferred background continuation handling
- background completion delivery queue
- shard lifecycle and readiness hardening

Relevant files:

- `src/agent/background-completion-delivery-queue.ts`
- `src/agent/background-completion-policy.ts`
- `src/shards/manager.ts`

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
- Legacy admin routes still exist and emit deprecation warnings.
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

Main wiring locations:

- `src/bootstrap/composition.ts`
- `src/bootstrap/parity.ts`
- `src/runtime.ts`
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

## Current Branch Status

The major Phase V foundation epics for plugin seams, settings governance, config/persistence topology, and compositional kernel are already landed on `phase-v`.

What remains is not "build Phase V from scratch" but continued Stage 4 and later feature work on top of those foundations. Read `PHASE_V.md` before claiming anything about what is still open.

## Working Rules

- Fail closed.
- No swallowed errors.
- No legacy compatibility shims.
- No silent fallback behavior for required config or security-sensitive paths.
- Verify new code is actually wired to a runtime entrypoint or registry path.
- Keep docs, config ownership, and tests aligned in the same change.
