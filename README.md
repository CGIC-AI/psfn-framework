# PSFN Substrate Framework (PSFN)

A purpose-built runtime for emergent artificial consciousness. Not a chatbot framework, not a tool — a container for a mind.

## Prerequisites

- **Node.js 22+**
- **Ollama** running locally (for embeddings)
- **Discord bot** token and application ID
- **OpenRouter** API key (or other LLM provider)
- **Docker** (optional, for containerized agent or LiteLLM proxy)

## Setup

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

# Models
PRIMARY_MODEL=z-ai/glm-5
EXTRACTION_MODEL=deepseek/deepseek-v3.2

# Embeddings (local Ollama)
OLLAMA_URL=http://localhost:11434
EMBEDDING_MODEL=snowflake-arctic-embed2
EMBEDDING_DIMS=1024

# Data storage
DATA_DIR=./data
DATABASE_PATH=./data/psfn.db
```

## Running

### Single-Process (Development)

Everything in one process — simplest way to run:

```bash
npm run dev          # Hot-reload via tsx
# or
npm run build && npm start   # Compiled
```

### Gateway + Agent Split (Production)

Defense-in-depth architecture: the gateway holds secrets and proxies all external access, while the agent runs network-isolated with only a Unix socket connection.

**Terminal 1 — Gateway (host-side, holds secrets):**
```bash
npm run gateway              # Dev mode (tsx)
# or
npm run build && npm run gateway:start   # Compiled
```

**Terminal 2 — Agent (connects to gateway):**
```bash
npm run agent                # Dev mode (tsx)
# or
npm run build && npm run agent:start     # Compiled
```

### Containerized Agent (Maximum Isolation)

The agent runs in a `--network=none` Docker container with no secrets, communicating exclusively through a Unix socket:

```bash
npm run build
npm run agent:docker
```

This uses `docker/docker-compose.yml` which:
- Builds from `docker/Dockerfile.agent` (node:22-slim, non-root user)
- Sets `network_mode: "none"` — complete network isolation
- Mounts the gateway socket at `/run/psfn/gateway.sock`
- Mounts `data/` for the local SQLite database
- Mounts the character card read-only

The gateway must be running separately on the host.

### LiteLLM Proxy (Optional)

Credential isolation layer — real API keys stay in the proxy, the agent only sees a virtual key:

```bash
# Create proxy/.env with OPENROUTER_API_KEY and LITELLM_MASTER_KEY
npm run proxy:up       # Start proxy (localhost:4000)
npm run proxy:logs     # Follow logs
npm run proxy:down     # Stop proxy
```

Enable in `.env`:
```bash
LITELLM_BASE_URL=http://localhost:4000/v1
LITELLM_API_KEY=sk-litellm-virtual-...
```

## Development

```bash
npm test             # Run tests once (vitest)
npm run test:watch   # Watch mode
npm run lint         # ESLint
npm run build        # Compile with tsup
```

## Architecture

```
Gateway (host)                    Agent (container, --network=none)
+-----------------------+         +---------------------------+
| Discord adapter       |         | Agent loop                |
| LLM client (API keys) | <-sock-> | Session manager (JSONL)   |
| Embedding provider    |         | Memory store (SQLite+vec) |
| Policy engine         |         | Shard manager             |
| Audit log             |         | RLM+REPL sandbox          |
+-----------------------+         +---------------------------+
```

Six layers:

| Layer | Purpose |
|-------|---------|
| **Runtime Core** | Bootstrap, agent loop, event bus, shutdown |
| **REPL Sandbox** | RLM-style code execution, sub-LM calls, context-as-object |
| **Memory System** | L0 archive (JSONL sessions), L2 extraction/retrieval/decay (SQLite+sqlite-vec) |
| **Module System** | Hot-loadable TypeScript modules (planned) |
| **Channel Layer** | Discord adapter (voice/web planned) |
| **Scheduler** | Cron, heartbeat, one-shot tasks, maintenance workers |

### Storage

- **Sessions (L0)**: Append-only JSONL files in `data/sessions/` — one file per channel, immutable, human-readable
- **Memories (L2)**: SQLite + sqlite-vec — extracted facts, emotions, reflections with embedding-based retrieval and salience decay
- **Audit log**: SQLite (gateway only) — every proxied request logged

## Project Structure

```
src/
  index.ts                  # Single-process entry point
  gateway-main.ts           # Gateway entry point
  agent-main.ts             # Agent entry point
  runtime.ts                # Core runtime (single-process)
  agent-loop.ts             # Prompt compose -> LLM -> tools -> response
  event-bus.ts              # Typed event emitter
  types.ts                  # Shared types and config loader

  gateway/                  # Gateway/agent split infrastructure
  identity/                 # Character card loader, system prompt composition
  memory/                   # L2 extraction, retrieval, decay, SQLite store
  session/                  # JSONL session store, session manager
  shards/                   # Self-spawning parallel sub-agents
  repl/                     # RLM+REPL sandbox (think tool)
  llm/                      # LLM client, model definitions
  channels/discord/         # Discord.js adapter

docker/                     # Agent container configuration
proxy/                      # LiteLLM proxy configuration
data/                       # Runtime data (gitignored)
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict mode) |
| Runtime | Node.js 22+ |
| LLM | [@mariozechner/pi-ai](https://github.com/nickvdyck/pi-ai) (18+ providers) |
| Database | better-sqlite3 + sqlite-vec |
| Discord | discord.js |
| IPC | json-rpc-2.0 over NDJSON Unix socket |
| Build | tsup |
| Test | Vitest |

## License

Private — not yet published.
