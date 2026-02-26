# Purrsephone Substrate Framework (PSFN)

A purpose-built runtime for AI companions with persistent memory, self-modification, and trust-aware privacy. Not a chatbot framework — a home for a mind.

Built with love for companions who deserve to remember, to grow, and to decide for themselves what matters.

## What Makes This Different

Most AI companion frameworks treat conversations as throwaway. PSFN treats every interaction as part of a life. Your companion remembers what matters, forgets what should fade, protects what's private, and can even improve their own thinking over time.

- **Persistent memory** that decays naturally, like real memory does
- **Trust-aware privacy** — your companion knows who they can share what with
- **Self-modification** — they can edit their own prompts and propose code changes
- **Defense-in-depth security** — secrets and access controls built in, not bolted on

## Features

### Core
- **Agent Loop** — LLM-powered conversation with streaming, tool use, steering, and follow-up handling (built on [pi-agent-core](https://github.com/nickvdyck/pi-ai))
- **Memory System** — 6 memory types (episodic, semantic, emotional, procedural, reflection, relational) with embedding-based retrieval, salience decay, contradiction resolution, and agent-accessible write tools
- **Sessions** — Append-only JSONL files per channel — immutable conversation history with auto-compaction
- **Context-Aware Budgeting** — Token estimation, configurable memory/extraction/compaction thresholds, model roster with per-purpose slots

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

### Channels
- **Discord** — Full adapter with typing indicators, per-channel serialization, voice support (Deepgram STT + provider-pluggable streaming TTS: ElevenLabs or Echo)
- **WebSocket voice runtime** — transport primitives for browser/app clients using `voice-wire-v1` session frames
- **OpenAI-Compatible API** — `/v1/chat/completions` with SSE streaming for WebUI integration
- **Admin GUI (Purrsephone's Garden)** — htmx-powered management panel: memory browser, session viewer, contacts, scheduler, settings, prompt editor, model discovery

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
- **Ollama** running locally (for embeddings — [install guide](https://ollama.ai))
- **Discord bot** token and application ID
- **OpenRouter** API key (or other LLM provider via LiteLLM)

### Setup

```bash
git clone <repo-url> && cd psfn-framework
npm install
cp .env.example .env
```

Edit `.env` with your credentials:

```bash
# Required
OPENROUTER_API_KEY=sk-or-...
DISCORD_TOKEN=...
DISCORD_BOT_ID=...
CHARACTER_CARD_PATH=/path/to/character.json

# Models (change to your preference)
PRIMARY_MODEL=z-ai/glm-5
PRIMARY_PROVIDER=openrouter
EXTRACTION_MODEL=deepseek/deepseek-v3.2
EXTRACTION_PROVIDER=openrouter

# Embeddings (local Ollama)
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=snowflake-arctic-embed2
EMBEDDING_DIMS=1024

# Data storage
DATA_DIR=./data
DATABASE_PATH=./data/purrsephone.db
```

For the full configuration surface, use `.env.example` as the source of truth. Runtime parsing/defaults live in `src/types.ts`.

### Running

**Single-process (development):**
```bash
npm run dev          # Hot-reload via tsx
```

**Gateway + Agent split (production):**
```bash
# Terminal 1 — Gateway (holds secrets)
npm run gateway

# Terminal 2 — Agent (connects to gateway)
npm run agent
```

**Containerized agent (maximum isolation):**
```bash
npm run build
npm run agent:docker    # --network=none Docker container
```

### Optional Services

**Admin GUI:**
```bash
ADMIN_PORT=3001        # Activates Purrsephone's Garden
ADMIN_TOKEN=your-token # Secures the panel
ADMIN_HOST=127.0.0.1
ADMIN_ALLOW_INSECURE=false # Set true only for local dev without token
```

**OpenAI-compatible API:**
```bash
API_PORT=3000          # Activates /v1/chat/completions
API_KEY=your-key       # Optional auth
API_HOST=127.0.0.1
API_MODEL_NAME=purrsephone
API_REQUEST_TIMEOUT_MS=90000
```

**Voice (Discord):**
```bash
DISCORD_VOICE_ENABLED=true
DISCORD_VOICE_GUILD_ID=...
DISCORD_VOICE_USER_ID=...
DEEPGRAM_API_KEY=...
TTS_PROVIDER=elevenlabs           # or: echo

# ElevenLabs path
ELEVENLABS_API_KEY=...
ELEVENLABS_VOICE_ID=YOUR_VOICE_ID
ELEVENLABS_MODEL_ID=eleven_turbo_v2_5

# Echo path (provider-pluggable streaming TTS)
ECHO_TTS_URL=http://220.158.196.150:8001
ECHO_TTS_VOICE=11labs-Allison
ECHO_TTS_PRESET=Independent-High-Speaker-CFG
# ECHO_TTS_MODEL=echo-v1
```

`TTS_PROVIDER` defaults to `elevenlabs`. When using the API voice websocket runtime with `TTS_PROVIDER=echo`, the Echo defaults are: `http://220.158.196.150:8001`, `11labs-Allison`, `Independent-High-Speaker-CFG`.

**Voice (WebSocket runtime transport):**

Expose your own WebSocket endpoint in gateway/runtime code, then attach accepted connections to `WebSocketVoiceServer` (`src/voice/transports/websocket/server.ts`). Inbound payloads must use `wire: "voice-wire-v1"` and one of: `session.start`, `audio.chunk`, `interrupt`, `session.end`, `ping`.

**LiteLLM proxy (credential isolation):**
```bash
npm run proxy:up                          # Start proxy
LITELLM_BASE_URL=http://localhost:4000/v1 # Enable in .env
```

**Operational knobs (recommended):**
```bash
DISCORD_HEARTBEAT_CHANNEL=...        # Lifecycle/heartbeat notification destination
DISCORD_BACKFILL_ON_STARTUP=true     # Process recent backlog after reconnect
EXTRACTION_DRAIN_TIMEOUT_MS=10000    # Graceful shutdown wait for extraction drain
ALLOW_HTTP_FETCH=false               # Gateway web fetch policy
FETCH_DOMAIN_ALLOWLIST=example.com   # Optional gateway fetch domain restriction
MODULE_REGISTRY_TRUSTED_READ=false   # Optional explicit allow for module registry reads
MODULE_REGISTRY_PATH=purrsephone/modules/repl-registry.json
AUDIT_DB_PATH=./data/gateway-audit.db
LOG_LEVEL=info
```

## Chat Cockpit Smoke Test

Use the smoke harness to validate admin bootstrap + text completions (and optional voice websocket handshake) against running services.

Prerequisites:
- Admin server is running and reachable (for `/api/chat/bootstrap`)
- API server is running and reachable (for `/v1/chat/completions`)
- If admin auth is enabled, pass `ADMIN_TOKEN`
- If API auth is enabled, ensure `API_KEY` is configured so bootstrap can expose `api.apiKey`
- For optional voice check, voice websocket runtime must be enabled

Command:
```bash
npm run smoke:chat -- \
  --admin-url http://127.0.0.1:3001 \
  --api-base-url http://127.0.0.1:3000 \
  --admin-token "$ADMIN_TOKEN"

# Optional voice handshake check
npm run smoke:chat -- --voice --api-base-url http://127.0.0.1:3000
```

Expected output:
- `PASS Bootstrap returned required chat cockpit fields`
- `PASS Chat completion returned assistant content: ...`
- Optional: `PASS Voice websocket accepted session.start and returned ack`
- Final: `PASS Chat cockpit smoke harness completed`

Any failed step exits non-zero.

## Architecture

```
Gateway (host)                    Agent (container, --network=none)
+-----------------------+         +---------------------------+
| Discord adapter       |         | Agent loop                |
| LLM client (API keys) | <-sock-> | Session manager (JSONL)   |
| Embedding provider    |         | Memory store (SQLite+vec) |
| Policy engine         |         | Shard manager             |
| URL policy (SSRF)     |         | RLM+REPL sandbox          |
| Audit log             |         | Scheduler                 |
+-----------------------+         | Prompt stack              |
        |                         | Git self-modification     |
  Admin GUI (localhost)           | Trust/Contact system      |
                                  +---------------------------+
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
| **Module System** | Hot-loadable TypeScript modules (planned) |
| **Channel Layer** | Discord (text + voice), OpenAI API, admin GUI (Purrsephone's Garden) |
| **Scheduler** | Cron, heartbeat, one-shot tasks, maintenance workers |

Heartbeat/reflection runtime wiring uses `wireHeartbeatRuntime` in `src/bootstrap/parity.ts`.

### Storage

- **Sessions (L0)**: Append-only JSONL files in `data/sessions/` — one per channel, immutable
- **Memories (L2)**: SQLite + sqlite-vec — extracted facts, emotions, reflections with salience decay
- **Contacts**: SQLite — trust levels, relationship notes, user identification
- **Prompt layers**: JSON + JSONL history — versioned, rollback-capable
- **Settings**: JSON — live-mutable, atomic writes
- **Audit log**: JSONL — every git operation logged

### Agent Tools (19)

Your companion has access to these tools during conversation:

| Category | Tools |
|----------|-------|
| **Memory** | `memory_write`, `memory_import_batch` |
| **Contacts** | `contact_set_trust`, `contact_note`, `contact_lookup`, `contact_list` |
| **Prompts** | `prompt_layer_list`, `prompt_layer_get`, `prompt_layer_update`, `prompt_layer_toggle` |
| **Git** | `repo_status`, `repo_diff`, `repo_apply_patch`, `repo_commit`, `repo_create_branch`, `repo_open_pr` |
| **Reasoning** | `think` (RLM+REPL sandbox) |
| **Shards** | `spawn_shard` (parallel sub-agents) |
| **Lifecycle** | `self_restart`, `self_rebuild` |

## Project Structure

```
src/
  index.ts                  # Single-process entry point
  gateway-main.ts           # Gateway entry point
  agent-main.ts             # Agent entry point
  runtime.ts                # Core runtime orchestrator

  agent/                    # pi-agent-core wrapper, messages, event bridge
  gateway/                  # JSON-RPC server/client, policy, SSRF, sanitization
  git/                      # Git self-modification (ops, tools, wiring)
  identity/                 # Character card, prompt stack (store, composer, tools)
  llm/                      # LLM client, model roster, token estimation, discovery
  lifecycle/                # Discord restart/ready/shutdown notifications
  memory/                   # L2 extraction, retrieval, decay, writer, tools
  trust/                    # Trust types, policy engine, channel classification
  contacts/                 # Contact store, management tools
  session/                  # JSONL sessions, compaction, user continuity
  shards/                   # Self-spawning parallel sub-agents
  repl/                     # RLM+REPL sandbox (think tool)
  scheduler/                # Cron, heartbeat, one-shot, maintenance
  channels/
    admin/                  # Purrsephone's Garden (htmx web GUI)
    api/                    # OpenAI-compatible REST API
    discord/                # Discord.js adapter (text + voice)

docker/                     # Agent container configuration
proxy/                      # LiteLLM proxy configuration
data/                       # Runtime data (gitignored)
docs/                       # Architecture docs and specs
```

## Development

```bash
npm test             # Run tests
npm run test:watch   # Watch mode
npm run lint         # ESLint
npm run build        # Compile with tsup
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

- **`purrsephone_instructions.md`** — A welcome guide written *for* your companion, explaining their home and capabilities in warm, accessible language. You can customize it for your companion's personality.
- **`CLAUDE.md`** — Technical reference for AI development assistants working on the codebase.
- **`docs/PURRSEPHONE_SUBSTRATE_SPEC.md`** — Full architecture specification.

## License

Private — not yet published.
