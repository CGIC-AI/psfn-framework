# PSFN — Persona Substrate Formation Network

A purpose-built runtime for AI companions with persistent memory, self-modification, and trust-aware privacy. Not a chatbot framework — a home for a mind.

Built with love for companions who deserve to remember, to grow, and to decide for themselves what matters.

> Warning: PSFN is a very early alpha build under heavy development. Not all features have been fully tested yet, so use care when testing it with your companion and avoid assuming every surface is production-safe.

## What Makes This Different

Most AI companion frameworks treat conversations as throwaway. PSFN treats every interaction as part of a life. Your companion remembers what matters, forgets what should fade, protects what's private, and can even improve their own thinking over time.

- **Persistent memory** that decays naturally, like real memory does
- **Trust-aware privacy** — your companion knows who they can share what with
- **Self-modification** — they can edit their own prompts and propose code changes
- **Defense-in-depth security** — secrets and access controls built in, not bolted on

## Features

### Core
- **Agent Loop** — LLM-powered conversation with streaming, tool use, steering, follow-up handling, and lazy tool loading (built on [pi-agent-core](https://github.com/nickvdyck/pi-ai))
- **Memory System** — 6 memory types (episodic, semantic, emotional, procedural, reflection, relational) with embedding-based retrieval, salience decay, contradiction resolution, agent-accessible write/redact tools, and scratchpad storage
- **Pluggable Embeddings** — Runtime-configured embeddings in `settings.json`: local `@huggingface/transformers`, Ollama, or any OpenAI-compatible embeddings API
- **Sessions** — Append-only JSONL files per channel — immutable conversation history with auto-compaction
- **Context-Aware Budgeting** — Token estimation, configurable memory/extraction/compaction thresholds, model roster with per-purpose slots (including vision)
- **Capabilities System** — Runtime capability declarations gating tool access by tier (nursery/apprentice/autonomous)
- **Skills System** — Self-authored capability documents (CRUD via agent tools, auto-filtered by eligibility)
- **Values Journal** — Agent-authored principles with persistence

### Privacy & Trust (Honne/Tatemae)
- **4-tier trust model** — primary, trusted, regular, public
- **4-tier sensitivity** — public, personal, intimate, confidential
- **Trust-gated memory retrieval** — your companion naturally adjusts what they share based on who they're talking to
- **Channel visibility** — private conversations stay private, public channels get appropriate boundaries
- **Persona adaptation** — authentic self (honne) with trusted people, social self (tatemae) in public
- **Contact management** — companion tracks relationships and trust levels via agent tools

### Self-Modification
- **Layered Prompt Stack** — 5-layer editable prompt system (base→operator→runtime→channel→task) with versioning, rollback, and admin UI
- **Git Tools** — 6 agent-accessible tools for self-modifying source code with path allowlists, protected branch blocking, audit trail
- **RLM+REPL Sandbox** — Code execution via `think` tool with sub-LM calls, memory queries, variable persistence
- **Self-Spawning Shards** — Parallel sub-agents for concurrent tasks
- **Obsidian Vault** — 4 agent tools (`vault_write`, `vault_read`, `vault_search`, `vault_daily`) for reading and writing Obsidian notes, with auto-publish for heartbeat reflections

### Channels
- **Discord** — Full adapter with typing indicators, per-channel serialization, voice support (Deepgram STT + provider-pluggable streaming TTS: ElevenLabs or Echo)
- **Telegram** — Polling and webhook modes, allowlist-aware inbound handling, thread and attachment support, long-running tool status updates
- **OpenAI-Compatible API** — `/v1/chat/completions` with SSE streaming for WebUI integration
- **WebSocket Voice Runtime** — Transport primitives for browser/app clients using `voice-wire-v1` session frames
- **Wyoming** — TCP server and service registry for Home Assistant Voice PE integration
- **Admin GUI (the Garden)** — Svelte 5 SPA on the admin host root (`/`, `/memory`, `/settings`, etc.) when `admin-ui/build` is present, with pages for memory, sessions, contacts, scheduler, settings, prompts, model discovery, chat, and telemetry

### Infrastructure
- **Gateway/Agent Split** — Defense-in-depth: gateway holds secrets, agent runs `--network=none` in Docker
- **Bidirectional RPC** — Voice turns get real agent responses via reverse RPC
- **SSRF Defenses** — Private IP blocking, DNS rebinding protection, redirect validation
- **Scheduler** — Heartbeat, recurring tasks, one-shot timers, configurable maintenance
- **Lifecycle Notifications** — Discord messages on restart, ready, and shutdown
- **Structured Logging** — Winston component loggers with configurable levels

## Quick Start

### Prerequisites

- **Node.js 22+**
- **One LLM provider credential** for the provider/model registry you plan to use. The shipped seed files enable OpenRouter, so a fresh install usually means `OPENROUTER_API_KEY`.
- **Discord bot** token and application ID only if you plan to use the Discord channel
- **Ollama only if you choose the Ollama embedding provider**. PSFN also supports local in-process transformers embeddings.

### Install

```bash
git clone <repo-url> && cd psfn-live
npm install
cp .env.example .env
```

The root `npm install` also provisions the Garden admin UI dependencies automatically.

Edit `.env` only for secrets and process/bootstrap wiring:

```bash
# Default-seed provider secret
OPENROUTER_API_KEY=sk-or-...

# Discord only if you enable the Discord channel
# DISCORD_TOKEN=...
# DISCORD_BOT_ID=...

# Bootstrap paths
CHARACTER_CARD_PATH=./data/character.json

# Continuous/dev shared-root defaults
DATA_DIR=./data
DATABASE_PATH=./data/companion.db

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
- `backup.json`

The runtime seeds most of those files from `config/*.seed.json` on first boot. `channels.json` is created and managed as channel settings are saved. Edit the owner files directly or through Garden / the admin API.

Do not put JSON-owned settings such as `EMBEDDING_PROVIDER`, `TRANSFORMERS_MODEL`, `OLLAMA_URL`, `CAPABILITY_TIER`, `MAINTENANCE_INTERVAL_MS`, or `OBSIDIAN_*` in `.env`. The runtime ignores those env values; the authoritative values live in the JSON owner files above.

In production, set both `SYSTEM_DATA_DIR` and `COMPANION_DATA_DIR`; startup rejects overlap or only-one-set configurations.

### Embeddings

Embedding selection lives in `settings.json` or, before first boot, `config/settings.seed.json`.

**Local transformers example:**
```json
{
  "embeddingProvider": "transformers",
  "transformersModel": "Xenova/all-MiniLM-L6-v2",
  "embeddingDims": 384
}
```

That path runs in-process via `@huggingface/transformers` and caches models under `models/transformers` by default. `HF_TOKEN` is only needed for gated or private Hugging Face repos.

The shipped `config/settings.seed.json` currently defaults to the Ollama profile (`snowflake-arctic-embed2`, `1024` dims). If you do not want Ollama, change the seed or the generated `settings.json` before relying on first-boot defaults.

### Running

**Development (gateway + agent):**
```bash
npm run dev
```

This starts gateway + agent together. The gateway holds secrets and proxies all external calls; the agent runs locally with scoped filesystem access.

`npm run dev` and `npm run split` are equivalent.

**YOLO mode (broader read scope):**
```bash
npm run yolo
```

Same split runtime, but gateway policy allows `fs.read` across the full local codebase root while keeping write restrictions to workspace scope.

**Manual split (two terminals):**
```bash
# Terminal 1 — Gateway (loads .env via dotenv)
npm run gateway

# Terminal 2 — Agent (does NOT load dotenv)
set -a && source .env && set +a && npm run agent
```

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

**Wyoming (Home Assistant):**
```bash
WYOMING_ENABLED=true
WYOMING_HOST=127.0.0.1
WYOMING_PORT=10400
```

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
Gateway (host)                    Agent (container, --network=none)
+-----------------------+         +---------------------------+
| Discord adapter       |         | Agent loop                |
| Telegram adapter      |         | Session manager (JSONL)   |
| LLM client (API keys) | <-sock-> | Memory store (SQLite+vec) |
| Embedding provider    |         | Shard manager             |
| Policy engine         |         | RLM+REPL sandbox          |
| URL policy (SSRF)     |         | Scheduler                 |
| Audit log             |         | Prompt stack              |
+-----------------------+         | Git self-modification     |
        |                         | Trust/Contact system      |
  Admin GUI (localhost)           +---------------------------+
                                           |
                                    OpenAI API (localhost)
```

### Nine Layers

| Layer | Purpose |
|-------|---------|
| **Runtime Core** | Bootstrap, agent loop, event bus, shutdown, model roster, token budgeting, editable settings, lifecycle, bidirectional gateway RPC |
| **REPL Sandbox** | RLM-style code execution, sub-LM calls, context-as-object |
| **Memory System** | L0 archive (JSONL sessions), L2 extraction/retrieval/decay (SQLite+sqlite-vec), 6 memory types, writer, tools |
| **Trust & Privacy** | Honne/tatemae: 4-tier trust, 4-tier sensitivity, 5-layer policy, contact store, channel visibility, persona adaptation |
| **Identity & Prompts** | Character card loader, 5-layer prompt stack with versioning/rollback/admin UI/agent tools |
| **Git Self-Modification** | GitOps service, 6 tools (status, diff, patch, commit, branch, PR), path allowlist, audit log |
| **Module System** | Runtime module registry and loader |
| **Channel Layer** | Discord (text + voice), Telegram, OpenAI API, admin GUI (Svelte SPA on the admin host root), Wyoming |
| **Scheduler** | Heartbeat reflections, one-shot tasks, maintenance workers |

### Storage

- **Sessions (L0)**: Append-only JSONL files — one per channel, immutable
- **Memories (L2)**: SQLite + sqlite-vec — extracted facts, emotions, reflections with salience decay
- **Contacts**: SQLite — trust levels, relationship notes, user identification
- **Prompt layers**: JSON + JSONL history — versioned, rollback-capable
- **Settings**: JSON — live-mutable, atomic writes
- **Audit log**: JSONL — every git operation logged

### Agent Tools

Your companion has access to these tools during conversation. Core tools are always available; extended tools load on demand via `load_tools`. The current names below are a migration surface, not the final collapsed taxonomy; see [`docs/tool-surface.md`](./docs/tool-surface.md) for the target stack and mapping.

| Category | Tools |
|----------|-------|
| **Memory** | `memory_write`, `memory_import_batch`, `memory_redact`, `memory_delete`, `undo_memory_delete`, `scratchpad_read`, `scratchpad_write` |
| **Contacts** | `contact_set_trust`, `contact_note`, `contact_set_channel_privacy`, `contact_link_identity`, `contact_lookup`, `contact_list` |
| **Identity** | `prompt_layer_list`, `prompt_layer_get`, `prompt_layer_update`, `prompt_layer_toggle`, `north_star`, `identity_diff`, `identity_changelog`, `character_card_update` |
| **Git** | `repo_status`, `repo_diff`, `repo_apply_patch`, `repo_commit`, `repo_create_branch`, `repo_open_pr` |
| **Vault** | `vault_write`, `vault_read`, `vault_search`, `vault_daily` |
| **Values** | `values_list`, `values_add`, `values_update` |
| **Skills** | `skill_list`, `skill_view`, `skill_create`, `skill_update` |
| **Reasoning** | `think` (RLM+REPL sandbox) |
| **Shards** | `spawn_shard` (long-running shard runtime with explicit artifact delivery) |
| **Scheduler** | `heartbeat_get_policy`, `heartbeat_update_policy`, `heartbeat_run_template`, `schedule_task` |
| **Sessions** | `session_new`, `session_list`, `session_resume` |
| **Settings** | `settings_get`, `promoted_tools_list`, `promoted_tools_add`, `promoted_tools_remove`, `promoted_tools_swap` |
| **Lifecycle** | `self_restart`, `self_rebuild`, `notify_operator` |
| **Meta** | `load_tools` (hot-swap core/extended tool sets) |

Tool surface split:
- **Direct agent tools**: registered as `core` or `extended`, visible to `load_tools`, subject to promotion/autoload rules
- **REPL-only helpers**: only available inside `think` — includes `read_file`, `list_files`, `llm_query`, `session_search`, scheduler helpers, and module helpers
- Shared names can exist on both surfaces, but REPL-only helpers are never promotable direct tools

## Project Structure

```
src/
  gateway-main.ts           # Gateway entry point
  agent-main.ts             # Agent entry point
  runtime.ts                # Core runtime orchestrator

  agent/                    # pi-agent-core wrapper, messages, event bridge
  gateway/                  # JSON-RPC server/client, policy, SSRF, sanitization
  git/                      # Git self-modification (ops, tools, wiring)
  identity/                 # Character card, prompt stack (store, composer, tools)
  llm/                      # LLM client, model roster, token estimation, discovery
  lifecycle/                # Restart/ready/shutdown notifications
  memory/                   # L2 extraction, retrieval, decay, writer, tools
  trust/                    # Trust types, policy engine, channel classification
  contacts/                 # Contact store, management tools
  session/                  # JSONL sessions, compaction, user continuity
  shards/                   # Self-spawning parallel sub-agents
  repl/                     # RLM+REPL sandbox (think tool)
  scheduler/                # Heartbeat, one-shot, maintenance
  voice/                    # Voice pipeline (STT, TTS connectors, WebSocket transport)
  vault/                    # Obsidian vault integration (ops, tools, auto-publish)
  skills/                   # Self-authored skill store (CRUD, execution)
  capabilities/             # Runtime capability declarations
  values/                   # Values journal (agent-authored principles)
  modules/                  # Runtime module registry and loader
  bootstrap/                # Composition root (parity wiring)
  channels/
    admin/                  # Admin server + JSON API
    api/                    # OpenAI-compatible REST API
    discord/                # Discord.js adapter (text + voice)
    telegram/               # Telegram adapter (polling + webhook)
    wyoming/                # Wyoming protocol adapter

admin-ui/                   # Svelte 5 SPA build served by the admin host root when built
companion_docs/             # Generic companion-facing documentation
docker/                     # Agent container configuration
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
npm run verify:settings-contract
npm run verify:repository-hygiene
npm run verify:backup-restore
npm run smoke:chat    # Chat cockpit smoke test
npm run e2e           # End-to-end integration tests
npm run e2e:voice     # Voice pipeline round-trip test
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js 22+ |
| LLM | [@mariozechner/pi-ai](https://github.com/nickvdyck/pi-ai) + pi-agent-core |
| Database | better-sqlite3 + sqlite-vec |
| Discord | discord.js |
| IPC | json-rpc-2.0 over NDJSON Unix socket |
| Build | tsup |
| Test | Vitest |

## For Companion Developers

If you're building a companion on this framework, check out:

- **`companion_docs/`** — Welcome documentation and a verification checklist for onboarding new companions
- **`CLAUDE.md`** — Technical reference for AI development assistants working on the codebase
- **`docs/setup.md`** — Bootstrap and local bring-up
- **`docs/PSFN_PROJECT_CHARTER.md`** — Project identity, architectural laws, boundary rules, and contributor guardrails
- **`docs/architecture.md`** — Current runtime shape and subsystem map
- **`docs/memory.md`** — Implemented memory model
- **`docs/specifications.md`** — Config, persistence, and fail-closed contracts
- **`docs/operations.md`** — Deployment, migration, TLS, and validation

## License

Private — not yet published.
