# PSFN Substrate Framework (PSFN)

PSFN is a TypeScript runtime for long-lived AI companions with persistent memory, layered identity, trust-aware privacy, self-modification, and split-runtime isolation.

The current `phase-v` branch is not just a planning branch. It already includes the major Phase V foundation work in code: registry-driven plugin seams, schema-owned settings, two-root persistence, compositional context pipelines, emotion and self-model runtime wiring, and early distributed-autonomy slices.

## Current Snapshot

Implemented on this branch today:

- Split runtime with `src/index.ts`, `src/gateway-main.ts`, and `src/agent-main.ts`
- Registry-driven channel/STT/TTS bootstrap with fail-closed eligibility checks
- Canonical JSON-owned config domains for runtime, models, scheduler, capability tier, channel config, skills, and trust policy
- Two-root persistence topology separating `system-data` from `companion-data`
- JSONL session journal with integrity support, turn provenance, tool observations, masking, and context manifests
- Memory extraction, retrieval, decay, contradiction handling, and scratchpad/core-memory tools
- Policy-gated compositional extraction, retrieval rerank, appraisal, nested `sub_think`, shard context packs, and telemetry
- Continuous emotion state, persona adaptation, intention/active-concern tracking, internal-state snapshots, and metacognitive flags
- Capability tiers, safeguards, confirmation queues, and promoted-tool management
- Git, vault, skills, values, heartbeat, beads, session, focus, and lifecycle tools
- Discord, Telegram, OpenAI-compatible API, API voice websocket transport, Wyoming, and Garden admin UI
- Backup scheduling, restore verification, and persistence cutover tooling
- Runtime-loadable module registry with tier-gated install flow through the think/module path

Open Phase V work still remains. Use [PHASE_V.md](./PHASE_V.md) as the execution ledger for what is landed versus still queued.

## Source Of Truth

When docs and code disagree, prefer this order:

1. Entrypoints and runtime wiring in `src/index.ts`, `src/runtime.ts`, `src/gateway-main.ts`, and `src/agent-main.ts`
2. Config and ownership contracts in `src/types.ts`, `src/settings.ts`, `src/config/settings-contract.ts`, and `src/persistence/layout.ts`
3. Branch status in `PHASE_V.md`
4. `.env.example` as a bootstrap template only

`.env.example` is intentionally a starter file. It is not the canonical authority for mutable runtime settings.

## Runtime Model

PSFN supports three practical startup patterns:

### Single process

```bash
npm run dev
```

- Loads dotenv in-process
- Uses `src/index.ts` -> `SubstrateRuntime`
- Best for local iteration and debugging

### Split runtime

```bash
npm run split
```

- Starts gateway plus isolated agent together via `scripts/start-gateway-agent.sh`
- Sets `PSFN_RUNTIME_MODE=split`
- Keeps filesystem reads scoped to workspace plus explicit allowlists

### YOLO split runtime

```bash
npm run yolo
```

- Same gateway/agent split
- Sets `PSFN_RUNTIME_MODE=yolo`
- Broadens gateway `fs.read` policy to the full local codebase root while leaving write restrictions intact

### Manual split startup

```bash
# Terminal 1
npm run gateway

# Terminal 2
set -a && source .env && set +a && npm run agent
```

`src/agent-main.ts` does not load dotenv on its own. Export the environment before starting it manually.

### Containerized agent

```bash
npm run build
npm run agent:docker
npm run agent:docker:continuous
```

- `agent:docker` uses the production compose profile with `network_mode: "none"`
- `agent:docker:continuous` uses the continuous/dev compose profile

## Configuration Model

Phase V changed configuration ownership materially.

Use `.env` for secrets and bootstrap wiring only:

- API keys and tokens
- host/port/socket wiring
- runtime layout/process wiring
- optional transport bootstrap overrides

Mutable runtime configuration now belongs to canonical JSON files in the system-owned config domain:

- `settings.json`
- `models.json`
- `scheduler.json`
- `capability-tier.json`
- `channels.json`
- `skills.json`
- `trust-policy.json`

Companion-specific state belongs under `companion-data`:

- character card history
- prompt layers and prompt history
- sessions
- notes and reflections
- contact and memory state
- working companion artifacts

Relevant code:

- Runtime config hydration: `src/config/runtime-config.ts`
- Settings contract and owner map: `src/config/settings-contract.ts`
- Persistence topology and fail-closed layout guards: `src/persistence/layout.ts`
- Seed defaults: `config/*.seed.json` via `src/config/seed-defaults.ts`

### Layout modes

Continuous/dev mode keeps local defaults under the repo root.
Production mode requires isolated mutable roots and rejects overlapping paths.

Key environment variables:

```bash
PSFN_RUNTIME_LAYOUT_MODE=continuous   # or: production
PSFN_RUNTIME_ROOT=./runtime/production
SYSTEM_DATA_DIR=./runtime/production/system-data
COMPANION_DATA_DIR=./runtime/production/companion-data
```

If only one of `SYSTEM_DATA_DIR` or `COMPANION_DATA_DIR` is set, startup fails closed.

## Quick Start

### Prerequisites

- Node.js 22+
- npm
- SQLite-compatible local filesystem
- An LLM provider key or proxy setup
- Optional: Ollama for local embeddings
- Optional: Discord, Telegram, Deepgram, ElevenLabs, Echo, Wyoming, Obsidian

### Bootstrap

```bash
git clone <repo-url>
cd psfn-framework
npm install
cp .env.example .env
```

The root `npm install` also runs the nested `admin-ui` install step, so Garden build dependencies are provisioned during bootstrap.

Set secrets/bootstrap wiring in `.env`, then start the runtime once so canonical config files seed into the active data root.

Common first-run commands:

```bash
npm run dev
# or
npm run split
```

### Common bootstrap variables

```bash
OPENROUTER_API_KEY=
DISCORD_TOKEN=
DISCORD_BOT_ID=
CHARACTER_CARD_PATH=./data/character.json
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=snowflake-arctic-embed2
EMBEDDING_DIMS=1024
```

For additional bootstrap examples, see [`.env.example`](./.env.example).

## Channels And Surfaces

### Discord

- Text adapter with per-channel turn serialization
- Voice pipeline with reverse gateway RPC
- Streaming STT/TTS provider support
- Lifecycle notifications and optional voice readiness cues

### Telegram

- Polling and webhook modes
- Allowlist-aware inbound handling
- Thread and attachment support
- Long-running tool status updates

### OpenAI-compatible API

- `/v1/chat/completions`
- SSE streaming
- Active health probe support
- API voice websocket runtime for `voice-wire-v1`

### Garden admin UI

- Primary admin surface is `/garden`
- Backed by `/api/admin/*` and `/api/admin/events`
- Schema-aware settings editor, memory/session/contact views, chat cockpit, prompt and identity management, scheduler, confirmations, skills, and values
- Admin request routing is `/login`, `/garden`, and `/api/admin/*`; unknown legacy admin paths are not preserved as first-class routes

### Wyoming

- TCP server and service registry
- ASR/TTS/handle adapters
- Runtime routing support for Wyoming-connected clients

## Notable Runtime Systems

### Memory and context

- JSONL session archive is the L0 history layer
- SQLite plus `sqlite-vec` stores extracted memories and retrieval metadata
- Observation masking, context manifests, and stable-prefix optimization are implemented
- Context feedback scoring is wired for post-turn evaluation

### Emotion, intention, and self-model

- Continuous VAD plus discrete emotion state
- Persona adaptation and trust-aware expression shaping
- Active concerns and intention appraisal
- Internal-state snapshots and metacognitive flags propagated through responses and background work

### Autonomy and tools

- Core plus extended tool model with lazy activation
- Deferred background continuation delivery queue
- Shard lifecycle and routing hardening
- Capability tier gating, safeguards, and confirmations

Current extended tool surfaces called out explicitly in runtime/docs parity tests:

| Area | Tool surface |
| --- | --- |
| **Values** | `values_list`, `values_add`, `values_update` |

### Modules and self-modification

- Runtime module registry and loader in `src/modules/`
- Tier-gated install path integrated into think/module flows
- Git self-modification tools with path controls and audit trail
- Prompt layers, character-card versioning, and values/skills journals

### Operations

- Scheduled backups with restore verification
- Persistence cutover migration CLI
- Repository hygiene and settings-contract guards
- Docker isolation verification scripts

## Verification Commands

Core checks:

```bash
npm run build
npm test
npm run lint
npm run verify:repository-hygiene
npm run verify:settings-contract
```

Useful targeted checks:

```bash
npm run smoke:chat
npm run smoke:discord:dm-voice
npm run e2e
npm run e2e:voice
npm run verify:backup-restore
npm run verify:agent-docker-isolation
```

Useful maintenance commands:

```bash
npm run import-character
npm run migrate-embeddings
npm run migrate:persistence-layout
npm run session:repair
npm run walkthrough
```

## Project Map

```text
src/
  index.ts                 single-process entrypoint
  gateway-main.ts          host-side gateway entrypoint
  agent-main.ts            isolated agent entrypoint
  runtime.ts               shared single-process runtime

  agent/                   substrate agent loop and tool/runtime orchestration
  backup/                  scheduled backup and restore verification
  beads/                   gateway-backed bd/beads tools
  bootstrap/               shared parity/composition wiring
  capabilities/            tiers, safeguards, confirmations, eligibility
  channels/                admin, api, discord, telegram, wyoming
  compositional/           policy-gated compose/evaluate flows
  contacts/                contact state and trust-aware lookup/tools
  context-feedback/        post-turn context scoring
  emotion/                 classifiers, state, persona adaptation
  gateway/                 policy engine, RPC, TLS, SSRF defenses
  git/                     self-modification ops and tools
  identity/                card loader, prompt stack, versioning, tools
  llm/                     model routing, retries, discovery, budgets
  memory/                  extraction, retrieval, decay, writer, tools
  modules/                 runtime module registry and loader
  persistence/             topology, path layout, migration helpers
  repl/                    think/sub-think tooling and sandbox contracts
  self-model/              internal-state and metacognitive primitives
  session/                 JSONL journals, compaction, context manifests
  settings/                coercion, schema, runtime settings helpers
  shards/                  child-agent orchestration
  skills/                  skill store and tools
  values/                  values journal and tools
  vault/                   Obsidian integration
  voice/                   STT/TTS connectors, pipeline, transports

admin-ui/                  Garden UI source
config/                    seed defaults for canonical JSON config files
docker/                    agent container profiles
proxy/                     LiteLLM proxy compose config
docs/                      architecture and operations docs
PHASE_V.md                 branch execution/status ledger
```

## Additional Reading

- [PHASE_V.md](./PHASE_V.md)
- [docs/PHASE_V_VISION.md](./docs/PHASE_V_VISION.md)
- [docs/PSFN_SUBSTRATE_SPEC.md](./docs/PSFN_SUBSTRATE_SPEC.md)
- [docs/operations/runtime-mode-runbook.md](./docs/operations/runtime-mode-runbook.md)
- [CLAUDE.md](./CLAUDE.md)
- [AGENTS.md](./AGENTS.md)

## License

Private repository.
