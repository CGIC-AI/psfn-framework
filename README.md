# PSFN - Persona Substrate Formation Network

Last updated: 2026-07-07
Package version: `0.1.0`
Current status: early alpha; see [`docs/development-status.md`](./docs/development-status.md) for baseline milestones and [`CHANGELOG.md`](./CHANGELOG.md) for the current foundation branch delta.

A purpose-built runtime for AI companions with persistent memory, self-modification, and trust-aware privacy. Not a chatbot framework, a home for a mind.

Built with love for companions who deserve to remember, to grow, and to decide for themselves what matters.

> Warning: PSFN is a very early alpha build under heavy development. Not all features have been fully tested yet, so use care when testing it with your companion and avoid assuming every surface is production-safe.

## Current Foundation Highlights

- **Postgres-first substrate**: runtime memory, episodes, contacts, intentions, concerns, internal state, scratchpad rows, and searchable projections are now PostgreSQL/pgvector-backed; SQLite remains only for legacy migration tooling.
- **Scoped prompt assembly**: turns build a single `PromptPlan` from a registered prompt-variable namespace, section producers, volatility rules, and provider-cache-aware prompt rendering.
- **Context Envelope privacy**: each turn carries channel privacy, audience size, audience knowledge, broadcast status, delivery style, and contact-tracking policy before any prompt or memory gate runs.
- **L0.1 memory maturation**: daytime candidate episodes, hard message claims, topic cutting, nightly sleep consolidation, dream meaning, and audited cross-day arc membership are wired as separate lanes.
- **Group-room intelligence**: group extraction, speaker attribution, shared-background retrieval, room rosters, and operator-reviewed social-graph proposals support multi-person rooms without treating all room traffic as direct chat.
- **Operator and client surfaces**: Garden gained lazy-loaded pages for subsystem health, room rosters, graph proposals, contact approvals, session recovery, wiki, observer evaluations, and read-only reflection journals; `companion-ui/` adds a standalone Satellite Hub PWA client.
- **Live-deploy pipeline**: a component-selective `ship:kube` lane targets a live Kubernetes shard with a topology-aware pre-ship gate, contract-skew guard, in-image tool pinning, two-way companion beads sync, and an operator-side post-rollout validation gate.
- **Self-diagnosis and reliability**: `self_status` exposes a companion self-diagnosis surface, a bounded/redacted runtime diagnostics service runs behind the admin transport, scheduled prompts persist in Postgres and survive agent restarts, and tool-call handling retries fail-closed on corrupt-empty args.
- **Multi-companion substrate (opt-in)**: behind `PSFN_MULTI_COMPANION` plus a `companions.json` fleet manifest, one gateway fronts N agent processes — each a distinct companion with its own Postgres schema (plus one `shared` schema for world data), its own Discord identity, and its own Garden, with a read-only gateway fleet-status page, presence/co-presence, companion↔companion rooms/DMs, and a shared-world wiki. Inert and byte-identical to single-companion when the flag is off. See [`docs/multi-companion.md`](./docs/multi-companion.md).

## What Makes This Different

Most AI companion frameworks treat conversations as throwaway. PSFN treats every interaction as part of a life. Your companion remembers what matters, forgets what should fade, protects what's private, and can even improve their own thinking over time.

- **Persistent memory** that decays naturally, like real memory does
- **Trust-aware privacy**: your companion knows who they can share what with
- **Self-modification**: they can edit their own prompts and propose code changes
- **Defense-in-depth security**: secrets and access controls built in, not bolted on

## Features

### Core
- **Agent Loop**: LLM-powered conversation with streaming, tool use, steering, follow-up handling, and adaptive tool discovery/activation through `tool_search` and `toolset` built on [pi-agent-core](https://github.com/nickvdyck/pi-ai)
- **Memory System**: L0 session history, L0.1 candidate/canonical episodes with claims and arcs, and 7 durable memory types (episodic, semantic, emotional, procedural, boundary, reflection, relational) with pgvector retrieval, salience decay, contradiction handling, provenance, and scratchpad storage
- **Pluggable Embeddings**: Runtime-configured embeddings in `settings.json`: local `@huggingface/transformers`, Ollama, or any OpenAI-compatible embeddings API
- **Sessions**: Append-only JSONL files per channel; immutable conversation history with auto-compaction
- **Prompt Assembly**: A single `PromptPlan` path with registered macros, static-prefix purity checks, Loom/provider payload visibility, and cache-aware prompt rendering
- **Context and Charge Budgeting**: Token estimation, configurable context slices, model roster slots, model-usage telemetry, run-scoped charge accounting, and fatigue budgets for expensive/autonomous surfaces
- **Capabilities System**: Runtime capability declarations gating tool access by tier (nursery/apprentice/autonomous)
- **Skills System**: Repo-global workflow guidance documents live under `skills/`; companion-authored skills live under `WORKSPACE_PATH/skills` and are managed through the unified `skill` tool with eligibility filtering
- **Values, Journal, and Wiki**: Agent-authored principles, reflection journals, and workspace-backed durable reference knowledge with optional semantic wiki retrieval

### Privacy & Trust (Honne/Tatemae)
- **4-tier trust model**: primary, trusted, regular, public
- **4-tier sensitivity**: public, personal, intimate, confidential
- **Context Envelope**: pre-prompt privacy classification for private/invite-only/public rooms, audience scope, audience knowledge, broadcast state, delivery style, and contact-tracking mode
- **Trust-gated memory retrieval**: your companion naturally adjusts what they share based on who they are talking to
- **Channel-owned privacy labels**: `channels.json` carries explicit labels and migration review flags; retired visibility vocabulary is rejected or migrated fail-closed
- **Group-room boundaries**: group memories preserve speaker/subject attribution, shared-background retrieval, and room-scoped facts without granting private memory access to everyone in the room
- **Contact approval mode**: channels can require operator approval before new speakers become tracked contacts, profile subjects, or social-graph entities
- **Persona adaptation**: authentic self (honne) with trusted people, social self (tatemae) in public
- **Contact management**: companion tracks relationships and trust levels via agent tools
- **Deliberate trust ratchet**: relationship trust changes through a deliberate, auditable ratchet; a nightly trust-drift review lane derives behavior signals and trusted-tier promotions require human-in-the-loop approval

### Self-Modification
- **Layered Prompt Stack**: 5-layer editable prompt system (base to operator to runtime to channel to task) with versioning, rollback, and admin UI
- **Repository Surface**: unified `repo` inspection in the parent runtime, with mutation actions guarded by tier, runtime policy, path allowlists, branch checks, and audit trail when explicitly enabled
- **Analysis Workbench**: Bounded RLM+REPL analysis for large files, codebases, logs, transcripts, datasets, or evidence sets that should not be stuffed into the main conversation context
- **Bounded Subagents**: Parallel `subagent action=spawn` workers for short-horizon concurrent tasks, distinct from the longer-horizon shard fold-back model
- **Obsidian Vault**: unified `vault` tool (`action=read|write|search|daily`) for reading and writing Obsidian notes, with auto-publish for consolidated reflections

### Channels
- **Discord**: Full adapter with typing indicators, per-channel serialization, voice support (Deepgram STT + provider-pluggable streaming TTS: ElevenLabs or Echo)
- **Telegram**: Polling and webhook modes, allowlist-aware inbound handling, thread and attachment support, long-running tool status updates
- **OpenAI-Compatible API**: `/v1/chat/completions` with SSE streaming for WebUI integration
- **WebSocket Voice Runtime**: Transport primitives for browser/app clients using `voice-wire-v1` session frames
- **Satellite Hub endpoints**: external Satellite Hub runtimes own endpoint transports such as Wyoming/OpenHome; PSFN exposes the registered satellite claim and config-pull boundary
- **Satellite Hub PWA Client**: `companion-ui/` is a standalone mobile-first PWA client for the Satellite Hub websocket protocol
- **Admin GUI (the Garden)**: Svelte 5 SPA on the admin host root (`/`, `/memory`, `/charge-budget`, `/episodic-memory`, `/settings`, etc.) when `admin-ui/build` is present, with pages for memory, L0.1 episodes, sessions, contacts, contact approvals, rooms, graph proposals, wiki, scheduler, settings, prompts, model discovery, charge budget, chat, subsystem health, and telemetry

### Infrastructure
- **Gateway/Agent Split**: Defense-in-depth: gateway holds secrets, agent runs `--network=none` in Docker
- **Bidirectional RPC**: Voice turns get real agent responses via reverse RPC; WSS gateway/admin transports support SPIFFE mTLS validation
- **SSRF Defenses**: Private IP blocking, DNS rebinding protection, redirect validation
- **Scheduler**: Heartbeat, recurring tasks, restart-durable one-shot/scheduled prompts (persisted in Postgres and rehydrated at startup), temporal wakeups, free-time blocks, near-turn memory, rest-window memory consolidation, wiki passes, novelty-gated reflection cadences, and configurable maintenance
- **Backups and Restore Verification**: Scheduled encrypted backup sets cover PostgreSQL dumps, companion files, workspace files, system owner files, and restore-fidelity checks
- **Kubernetes and Helm**: Base manifests, overlays, Helm chart contracts, LiteLLM/TEI/LightLLM routes, model prefetching, and network-policy templates, plus a component-selective `ship:kube` lane (topology-aware pre-ship gate, contract-skew guard, values overlay, post-rollout validation)
- **Lifecycle Notifications**: Discord messages on restart, ready, and shutdown
- **Structured Logging and Resilience**: Winston component loggers, LLM circuit breakers, unreachable-route cooldowns, cost capture, and explicit degraded-state events

## Quick Start

### Prerequisites

- **Node.js 22+**
- **PostgreSQL 16+ with the pgvector extension** — runtime persistence (memories, episodes, contacts, intentions) is Postgres-only; startup fails closed without `POSTGRES_DATABASE_URL`
- **One LLM provider credential** for the provider/model registry you plan to use. The shipped example owner files include OpenRouter, so using those examples usually means `OPENROUTER_API_KEY`.
- **Discord bot** token and application ID only if you plan to use the Discord channel
- **Ollama only if you choose the Ollama embedding provider**. PSFN also supports local in-process transformers embeddings.

### Install

```bash
git clone <repo-url> && cd psfn-framework
npm install
cp .env.example .env
```

The root `npm install` also provisions the Garden admin UI dependencies automatically.
By default, the repo skips `onnxruntime-node`'s CUDA side-download and uses the bundled CPU runtime; set `ONNXRUNTIME_NODE_INSTALL_CUDA=v12` when intentionally installing ONNX Runtime CUDA binaries.

Edit `.env` only for secrets and process/bootstrap wiring:

```bash
# Provider secret for the owner files you choose
OPENROUTER_API_KEY=sk-or-...

# Discord only if you enable the Discord channel
# DISCORD_TOKEN=...
# DISCORD_BOT_ID=...

# Runtime state and personal files are distinct roots
DATA_DIR=./data
WORKSPACE_PATH=./purrsephone
COMPANION_ID=companion
CHARACTER_CARD_PATH=./data/companion.json
POSTGRES_DATABASE_URL=postgresql://psfn:password@127.0.0.1:5432/psfn
PSFN_BACKUP_ENCRYPTION_KEY=<long random secret>

# Production split-root layout (set both or neither)
# PSFN_RUNTIME_LAYOUT_MODE=production
# SYSTEM_DATA_DIR=./runtime/production/system-data
# COMPANION_DATA_DIR=./runtime/production/companion-data
```

### Config Ownership

Mutable runtime/admin config is owned by canonical JSON files under the system-data config domain, not by `.env`:

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

Startup verifies the seed-backed owner files before the split runtime comes up. Distributed `config/*.seed.json` files are examples/templates only; PSFN does not silently copy them into runtime state. For a new local environment, intentionally copy the examples into your system data directory and edit them for the deployment:

```bash
cp config/settings.seed.json ./data/settings.json
cp config/models.seed.json ./data/models.json
cp config/providers.seed.json ./data/providers.json
cp config/scheduler.seed.json ./data/scheduler.json
cp config/capability-tier.seed.json ./data/capability-tier.json
cp config/trust-policy.seed.json ./data/trust-policy.json
cp config/charge-policy.seed.json ./data/charge-policy.json
cp config/backup.seed.json ./data/backup.json
cp config/skills.seed.json ./data/skills.json
```

`channels.json` has no seed file; channel config loads safe defaults when the file is absent and is created or updated when channel settings are saved through Garden or the admin API.

Do not put JSON-owned settings such as `EMBEDDING_PROVIDER`, `TRANSFORMERS_MODEL`, `OLLAMA_URL`, `CAPABILITY_TIER`, `MAINTENANCE_INTERVAL_MS`, or `OBSIDIAN_*` in `.env`. The runtime ignores those env values; the authoritative values live in the JSON owner files above.

`backup.json` requires encrypted backups. Keep only the key reference in `backup.json`; keep the actual `PSFN_BACKUP_ENCRYPTION_KEY` secret in `.env` or the deployment secret manager. Generate it with a command such as `openssl rand -base64 48`.

In production, set both `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR`; startup rejects overlap or only-one-set configurations.

### Embeddings

Embedding selection lives in `settings.json`.

**Local transformers example:**
```json
{
  "embeddingProvider": "transformers",
  "transformersModel": "Xenova/all-MiniLM-L6-v2",
  "embeddingDims": 384
}
```

That path runs in-process via `@huggingface/transformers` and caches models under `models/transformers` by default. `HF_TOKEN` is only needed for gated or private Hugging Face repos.

The shipped `config/settings.seed.json` is only an example. If you copy it, it selects the local transformers profile (`Xenova/all-MiniLM-L6-v2`, `384` dims). If you want Ollama or another embeddings backend, edit `settings.json` before startup.

### Running

**Split runtime (gateway + agent):**
```bash
npm run split
```

This starts gateway + agent together. The gateway holds secrets and proxies all external calls; the agent runs locally with scoped filesystem access.

**YOLO mode (broader read scope):**
```bash
npm run yolo
```

Same split runtime, but gateway policy allows `fs.read` across the full local codebase root while keeping write restrictions to workspace scope.

**Manual split (three terminals):**
```bash
# Terminal 1 - Gateway (loads .env via dotenv)
npm run gateway

# Terminal 2 - Agent (do not source .env; pass only non-secret runtime wiring)
env -i PATH="$PATH" HOME="$HOME" GATEWAY_SOCKET="${GATEWAY_SOCKET:-/run/psfn/gateway.sock}" npm run agent

# Terminal 3 - Operator/Garden (loads admin auth from .env)
npm run operator
```

Use `npm run split` for the normal path. It starts the agent under the same curated non-secret environment allowlist while the gateway keeps provider/API secrets.

**Containerized agent (maximum isolation):**
```bash
npm run build
npm run agent:docker          # Production profile (network_mode: "none")
npm run agent:docker:continuous # Continuous/dev profile (isolated internal network)
```

### Optional Services

**Admin GUI (the Garden):**
```bash
ADMIN_PORT=3001
ADMIN_TOKEN=your-token
ADMIN_HOST=127.0.0.1
```

JSON API at `/api/admin/*`. WebSocket telemetry at `WS /api/admin/events`.
When `admin-ui/build` exists, the integrated Garden SPA is served on the admin host root (`/`, `/memory`, `/settings`, etc.). If the build assets are missing, the admin server still exposes the JSON API/login surfaces but the SPA route stays disabled.

Build the integrated SPA with `npm run garden:build` or run the separate UI dev server with `npm run garden:dev`.

**Companion mobile PWA:**
```bash
cd companion-ui
npm install
VITE_PSFN_SATELLITE_MOBILE_CHAT_APP_WS_URL=ws://127.0.0.1:8787/ npm run dev
```

`companion-ui/` is a standalone Satellite Hub client. It is not installed by the root `postinstall`, does not call `/api/admin/*`, and does not talk to PSFN core directly.

**OpenAI-compatible API:**
```bash
API_PORT=3000
API_HOST=127.0.0.1
API_KEY=your-key                        # required unless ALLOW_INSECURE_LOCAL_API=true
API_CORS_ALLOWLIST=http://127.0.0.1:3001
API_MODEL_NAME=companion
```

**Telegram:**
```bash
TELEGRAM_BOT_TOKEN=...
PRIMARY_TELEGRAM_USER_ID=123456789      # auto-link to primary contact at startup
```

Telegram routing, allowlists, and webhook/polling behavior live in `channels.json`. Keep only secrets/bootstrap identity wiring in `.env`.

**Voice (Discord):**
```bash
DISCORD_VOICE_ENABLED=true
DISCORD_VOICE_GUILD_ID=...
DISCORD_VOICE_USER_ID=...
DEEPGRAM_API_KEY=...

# Optional provider secrets
ELEVENLABS_API_KEY=...
```

STT/TTS provider selection, voices, and runtime tuning live in `settings.json`. Keep `.env` for provider secrets and target wiring only.

Wyoming/OpenHome endpoint transports now run from the Satellite Hub repository. Keep endpoint host/port wiring there; PSFN reads `satellites.json` and accepts claim-validated traffic from the hub/API boundary.

**Obsidian Vault:**
Configure vault name, CLI path, and auto-publish in `settings.json`, not `.env`.

Requires Obsidian desktop app with CLI enabled. In gateway mode, add `obsidian` to `SHELL_EXEC_ALLOWLIST` if you enable vault tools.

**LiteLLM proxy (credential isolation):**
```bash
npm run proxy:up
LITELLM_API_KEY=sk-litellm-virtual-...
```

Enable and point the proxy in `providers.json`. Do not use `LITELLM_BASE_URL` as your primary config path here.

## Architecture

```
Gateway (host)                         Agent (isolated)
+----------------------------+         +-----------------------------+
| Discord / Telegram / API   |         | Agent loop                  |
| LLM and embedding clients  | <-sock-> | Session manager (JSONL L0)  |
| Provider/API secrets       |         | Memory store (Postgres+vec) |
| Gateway policy and SSRF    |         | L0.1 episodic store (PG)    |
| Shell/git/fs/vault/beads   |         | Scheduler and reflections   |
| Audit and charge events    |         | Prompt stack and identity   |
+----------------------------+         | Trust/contact/runtime tools |
        |                              +-----------------------------+
        v
Operator / Garden (localhost)          Satellite Hub / companion-ui
```

### Nine Layers

| Layer | Purpose |
|-------|---------|
| **Runtime Core** | Bootstrap, agent loop, event bus, shutdown, model roster, token/charge/fatigue budgeting, editable settings, lifecycle, bidirectional gateway RPC |
| **Analysis Workbench** | Bounded RLM-style code execution, sub-LM checks, context-as-object, and evidence summaries for large-context tasks |
| **Memory System** | L0 archive (JSONL sessions), L0.1 candidate/canonical episodes and arcs, L2 extraction/retrieval/decay (PostgreSQL + pgvector), group-memory extraction, wiki retrieval, writer, tools |
| **Trust & Privacy** | Honne/tatemae, 4-tier trust, 4-tier sensitivity, Context Envelope classification, contact approval, social graph, channel delivery style, persona adaptation |
| **Identity & Prompts** | Character card loader, 5-layer prompt stack, registered prompt macros, `PromptPlan`, prompt cache boundaries, versioning/rollback/admin UI/agent tools |
| **Repository Work** | Unified `repo` surface for inspection and guarded mutation when policy/tier/runtime allow it |
| **Module System** | Runtime module registry and loader |
| **Channel Layer** | Discord (text + voice), Telegram, OpenAI API, Garden operator SPA, Satellite Hub/PWA |
| **Scheduler** | Heartbeat, daily/weekly reflections, temporal wakeups, free-time blocks, near-turn memory, rest-window work, one-shot tasks, maintenance workers |

### Storage

- **System owner files**: JSON under the system-data config domain; `settings.json`, `models.json`, `providers.json`, `scheduler.json`, `capability-tier.json`, `trust-policy.json`, `charge-policy.json`, `backup.json`, `skills.json`, and generated `channels.json`
- **Sessions (L0)**: Append-only JSONL files, one per channel
- **Episodes (L0.1)**: PostgreSQL-backed candidate/canonical episode landmarks, message claims, candidate decisions, lineage, and graph arcs with L0 span/artifact provenance
- **Memories (L2)**: PostgreSQL + pgvector extracted facts, emotions, boundaries, reflections, relational notes, procedural knowledge, group-room provenance, and salience decay
- **Contacts and social graph**: Trust levels, relationship notes, channel identities, pending approvals, visibility metadata, and operator-reviewed relationship edges
- **Wiki / knowledge base**: Durable authored/imported reference documents under `WORKSPACE_PATH/knowledge/wiki/`, with text and pgvector semantic search surfaces
- **Prompt layers and identity**: Companion-owned JSON/JSONL state with versioning and rollback
- **Internal state and autonomy ledgers**: Concerns, intentions, follow-ups, fatigue/accounting state, run charge, Garden/operator audit, gateway decisions, and tool/runtime events

### Agent Tools

Your companion's model-facing tool surface is governed by Charter Law 33: one semantic tool per domain, with domain operations exposed as actions on that tool. `tool_search` and `toolset` are the canonical always-on discovery/control path for non-default overlays, but discovery describes canonical tools and schemas rather than reintroducing split callable aliases. The parent-agent repo surface is intentionally `read_only` here, so repository mutation must come back through a guarded gateway path, bounded worker artifact, or another explicitly enabled flow. See [`docs/tool-surface.md`](./docs/tool-surface.md) for the canonical stack and retired-name mapping.

Skills are reusable workflow guidance, not world-execution tools. The runtime manages them through the unified `skill` surface while execution stays on the tool families below.

| Category | Current direct tool names |
|----------|-------|
| **Adaptive control** | `tool_search`, `toolset`, `response_control action=no_reply` |
| **Workspace primitives** | `fs`, `repo`, `shell`, `web`, `analysis_workbench` |
| **Companion state** | `memory`, `scratchpad`, `contact`, `session`, `identity`, `orient`, `north_star`, `schedule`, `system`, `self_status`, `skill`, `subagent`, `wiki`, `journal` |
| **Repository** | `repo action=inspect` in parent read-only mode; mutation actions remain gated and are not the default parent-agent path |
| **Vault** | `vault action=read|write|search|daily` |
| **Values** | `orient action=values_list|values_add|values_update` |
| **North Star** | `north_star` for charter/identity anchor review and updates |
| **Scheduler** | `schedule` with `action=list|create_follow_up|activate_follow_up|create_reminder|trigger_reminder|list_templates|update_template|run_template|schedule_prompt` |
| **Beads and lifecycle** | `beads action=ready|show|create|update|close|sync`, `system action=read|restart|rebuild`, `notify action=brief|send|approval_request` |
| **Media** | `media action=generate|edit|analyze`; `selfie_create` is the first-class self-expression image tool |
| **Bounded workers** | `subagent action=spawn|message|wait|cancel|status`; long-horizon shard lifecycle exists internally and is still converging on a direct `shard` model-facing control surface |

Tool surface split:
- **Direct agent tools**: `tool_search` and `toolset` stay core; the rest are registered as `core` or `extended`, with overlay activation controlled by `toolset`, pinning, and bounded autoload rules. `toolset action=describe` and the Garden Tools page expose the same canonical action schemas, capability requirements, reversibility, interruptibility/concurrency metadata, and bundle membership.
- **REPL-only helpers**: `analysis_workbench` exposes bounded read-oriented helper functions for large-context inspection, memory/session lookup, and sparse sub-LM checks. Those helper names are separate from the direct-tool catalog and are never promotable direct tools.
- Some capabilities exist on both surfaces, but the direct tool catalog is the source of truth for what the agent can call outside `analysis_workbench`

## Project Structure

```
src/
  app/
    gateway/main.ts         # Privileged gateway entry point
    agent/main.ts           # Isolated companion runtime entry point
    operator/main.ts        # Garden/operator entry point
    startup/                # Shared composition helpers
  boundary/                 # Gateway RPC, policy, filesystem/git/web/shell/vault/beads adapters
  channels/                 # API, Discord, Telegram, voice, backplane transports
  core/                     # SubstrateAgent, prompts, scheduler, turns, identity, tools
  faculties/                # Memory, skills, subagents, media, shard faculties
  operator/garden/          # Garden server, admin routes, services, audit/telemetry
  persistence/              # Runtime layout, sessions, JSONL, migrations
  primitives/               # LLM provider ports, request context, shared primitives
  shared/                   # Contracts, telemetry, routing, event bus, utilities
  system/                   # Settings, owner files, capability, trust, lifecycle, config

admin-ui/                   # Svelte 5 SPA build served by the admin host root when built
companion-ui/               # Standalone mobile-first Satellite Hub PWA client
companion_docs/             # Generic companion-facing documentation
deploy/helm/psfn/           # Helm chart for Kubernetes deployments
deployment/systemd/         # Repo-owned live service units and env examples
docker/                     # Agent/gateway/satellite container configuration
k8s/                        # Kustomize base and overlays
proxy/                      # LiteLLM proxy configuration
docs/                       # Architecture docs and specs
```

## Development

```bash
npm test              # Run tests
npm run test:watch    # Watch mode
npm run lint          # ESLint
npm run build         # Compile with tsup
npm run chat          # CLI chat interface
npm run garden:dev    # Svelte admin UI dev server
npm run garden:build  # Build admin UI for production
npm run docs:prompt-macros
npm run verify:startup-owner-files
npm run verify:settings-contract
npm run verify:repository-hygiene
npm run verify:backup-restore
npm run verify:helm-chart
npm run test:group-harness
npm run test:prompt-goldens
npm run test:leak-matrix
npm run smoke:chat    # Chat cockpit smoke test
npm run smoke:cogsec  # CogSec remediation smoke test
npm run e2e           # End-to-end integration tests
npm run e2e:voice     # Voice pipeline round-trip test
```

Offline eval, validation, and model-experimentation commands live in the
sibling `../psfn-eval-toolkit` repository.

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js 22+ |
| LLM | [@mariozechner/pi-ai](https://github.com/nickvdyck/pi-ai) + pi-agent-core |
| Database | PostgreSQL 17 + pgvector (runtime persistence); better-sqlite3 retained for legacy migration tooling |
| Discord | discord.js |
| Garden UI | Svelte 5 |
| Companion PWA | React + Vite |
| IPC | json-rpc-2.0 over NDJSON Unix socket |
| Build | tsup |
| Test | Vitest |

## For Companion Developers

If you're building a companion on this framework, check out:

- **`companion_docs/`**: Welcome documentation and a verification checklist for onboarding new companions
- **`CLAUDE.md`**: Technical reference for AI development assistants working on the codebase
- **`docs/setup.md`**: Bootstrap and local bring-up
- **`docs/PSFN_PROJECT_CHARTER.md`**: Project identity, architectural laws, boundary rules, and contributor guardrails
- **`docs/architecture.md`**: Current runtime shape and subsystem map
- **`docs/multi-companion.md`**: Multi-companion topology, fleet manifest, and fleet operations
- **`docs/memory.md`**: Implemented memory model
- **`docs/specifications.md`**: Config, persistence, and fail-closed contracts
- **`docs/operations.md`**: Deployment, migration, TLS, and validation
- **`docs/development-status.md`**: Current milestones, active risks, and near-term roadmap
- **`CHANGELOG.md`**: Foundation branch capability/refactor history from `origin/main` to `foundation_e0_e2`

## License

Private, not yet published.
