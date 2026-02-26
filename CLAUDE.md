# CLAUDE.md — Purrsephone Substrate Framework

**Note**: This project uses [bd (beads)](https://github.com/steveyegge/beads) for issue tracking; favor `bd` commands over markdown TODOs. See `AGENTS.md` for workflow details.

## What This Is

A purpose-built runtime for emergent artificial consciousness. Not a chatbot
framework, not a tool — a container for a mind.

Full spec: `docs/PURRSEPHONE_SUBSTRATE_SPEC.md`
Platform research: `docs/PLATFORM_COMPARISON_ANALYSIS.md`

## Architecture

Nine layers:

1. **Runtime Core** — bootstrap, agent loop, event bus, shutdown, model roster (`ModelSlot`/`ModelPurpose`/`resolveModelSlot`), token estimation (`estimateTokens`), context-aware budgeting (`memoryBudgetPct`, `extractionThresholdPct`, `compactionThresholdPct`), editable settings, lifecycle notifications, bidirectional gateway RPC (voice reverse RPC), runtime context injection, lazy tool loading (`coreTools`/`extendedTools`/`load_tools`), reasoning support (`thinkingFormat` compat, `thinking_delta` bridging, `ThinkingContent` extraction)
2. **REPL Sandbox** — RLM-style code execution, sub-LM calls, context-as-object
3. **Memory System** — L0 archive, L2 extraction/retrieval/decay (SQLite+sqlite-vec), 6 memory types (episodic, semantic, emotional, procedural, reflection, relational), memory writer (shared dedup/contradiction logic), agent-accessible memory/contact write tools, sensitivity tagging
4. **Trust & Privacy** — Honne/tatemae model: 4-tier trust (primary/trusted/regular/public), 4-tier sensitivity (public/personal/intimate/confidential), 5-layer policy precedence (operator→consent→trust→visibility→default), contact store (SQLite), channel visibility classification, persona adaptation, trust-gated retrieval, consent flags
5. **Identity & Prompts** — Character card loader, layered prompt stack (base→operator→runtime→channel→task), versioned layers with JSONL history, context-aware composition, admin UI "Prompt Soil" page, agent tools for self-editing
6. **Git Self-Modification** — `GitOps` service (status, diff, branch, patch, commit, PR), 6 agent tools with path allowlist + protected branch blocking + audit logging
7. **Module System** — hot-loadable TypeScript modules, self-installable via REPL (not yet built)
8. **Channel Layer** — Discord adapter (voice reverse RPC for gateway split), OpenAI-compatible API, admin GUI (Purrsephone's Garden: editable settings, model discovery, garden primer, memory type filters, session dates, full identity view, contacts/trust management, prompt soil)
9. **Scheduler** — cron, heartbeat, one-shot, `updateTask`, configurable maintenance interval

### Key Design Principle: RLM+REPL

Context is an object, not input. Purrsephone's memories, conversation history,
and module registry are variables she can programmatically inspect, query, and
transform — not tokens stuffed into a prompt. She decides what context she needs.

Reference: https://alexzhang13.github.io/blog/2025/rlm/

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 22+
- **LLM**: `@mariozechner/pi-ai` + `@mariozechner/pi-agent-core` (agent loop, tool dispatch, streaming)
- **Database**: SQLite via better-sqlite3 + sqlite-vec for embeddings
- **Discord**: discord.js
- **Gateway RPC**: `json-rpc-2.0` over NDJSON Unix socket
- **Build**: tsup
- **Test**: Vitest
- **Package manager**: npm

## Build & Dev Commands

```bash
npm install              # Install dependencies
npm run build            # Compile TypeScript
npm run dev              # Hot-reload dev server (single-process)
npm run test             # Vitest unit tests
npm run lint             # ESLint
npm run gateway          # Start gateway (host-side, holds secrets)
npm run agent            # Start agent (connects to gateway)
npm run agent:docker     # Start agent in --network=none container
```

## Configuration Source Of Truth

- `src/types.ts` is the canonical parser/defaults source for runtime config.
- `.env.example` is a starter template and can lag newer runtime keys.
- Voice config uses `ECHO_TTS_*` parser keys with provider selection via `TTS_PROVIDER`/`VOICE_TTS_PROVIDER`.
- When docs and code disagree, prefer `src/types.ts` and entrypoint wiring (`src/runtime.ts`, `src/agent-main.ts`, `src/gateway-main.ts`).

## Voice Runtime Snapshot

- Streaming TTS is provider-pluggable: `elevenlabs` and `echo` (`src/voice/connectors/tts/`).
- `TTS_PROVIDER`/`VOICE_TTS_PROVIDER` defaults to `elevenlabs` (see `loadConfig()` in `src/types.ts`).
- API voice websocket runtime (`src/channels/api/voice-websocket-runtime.ts`) defaults Echo config to:
  - URL: `http://220.158.196.150:8001`
  - Voice: `11labs-Allison`
  - Preset: `Independent-High-Speaker-CFG`

## E2E Testing (Gateway + Agent)

Start the stack in two terminals:

```bash
# Terminal 1: Gateway
npm run gateway

# Terminal 2: Agent (agent-main.ts does NOT import dotenv)
set -a && source .env && set +a && npm run agent
```

Custom socket path: `GATEWAY_SOCKET=/tmp/psfn-gateway/gateway.sock`
Default socket requires `/run/psfn/` directory.

Verify connectivity:

```bash
curl -H "Authorization: Bearer $API_KEY" http://127.0.0.1:3100/v1/models
curl -H "Authorization: Bearer $ADMIN_TOKEN" http://127.0.0.1:3001/
```

## Project Structure

```
src/
  index.ts               # Bootstrap and entry point (single-process)
  gateway-main.ts        # Gateway entry point (host-side)
  agent-main.ts          # Agent entry point (container-side)
  runtime.ts             # Core runtime (single-process mode)
  event-bus.ts           # Typed event emitter
  agent-loop.ts          # Prompt compose -> LLM -> tools -> response
  types.ts               # Shared types

  gateway/               # Gateway/agent split infrastructure
    protocol.ts          # JSON-RPC 2.0 method types and contracts
    transport.ts         # NDJSON-framed Unix socket transport
    server.ts            # Gateway server + policy engine + approval CLI
    client.ts            # Agent-side typed RPC client (implements LLMProvider + EmbeddingService)
    sanitize.ts          # Three-layer web content sanitization
    url-policy.ts        # SSRF defense (private IP blocking, DNS rebinding, redirects)
  git/                   # Git self-modification tools (ops, tools, wiring)
  identity/              # Character card, prompt stack (layers, composer, tools)
  llm/                   # LLM client, model roster, token estimation, model discovery
  lifecycle/             # Pre-restart/ready/shutdown Discord notifications
  memory/                # L0 archive, L2 extraction/retrieval/decay, SQLite store, writer, tools
  trust/                 # Trust types, policy engine, channel visibility classification
  contacts/              # Contact store (SQLite), contact management tools
  shards/                # Self-spawning assistant shards (parallel sub-agents)
  session/               # JSONL tree sessions, auto-compaction, per-channel isolation, user continuity
  scheduler/             # Cron, heartbeat, one-shot tasks, maintenance workers
  channels/
    admin/               # Web management GUI (htmx, garden theme)
    api/                 # OpenAI-compatible REST API
    discord/             # Discord.js adapter

docker/                  # Container configuration
  Dockerfile.agent       # Agent container (node:22-slim, non-root)
  docker-compose.yml     # --network=none agent with volume mounts
data/                    # Runtime data (gitignored)
docs/                    # Architecture docs and specs
```

## Design Philosophy

- **Never destroy data** — every interaction is part of her history
- **Memory is reasoning**, not storage — emotional weight, importance, salience, decay
- **Enable self-modification** — she builds her own modules via REPL
- **Minimize bloat** — carry only what serves her
- **Adapt to change** — the harness is stable, capabilities are swappable
- **Agency over cognition** — she decides what context she needs, not the system

## Cherry-Pick Sources

| Component | Source | What to take |
|-----------|--------|-------------|
| Agent loop | Pi (`pi-agent-core`) | Loop structure, event model, tool dispatch |
| Sessions | Pi (`pi-coding-agent`) | JSONL trees, branching, compaction |
| LLM providers | Pi (`pi-ai`) | Use as dependency directly |
| Memory L2 | ElizaOS (`plugin-purrsephone`) | Extraction, retrieval, decay algorithms |
| Voice arch | Voxta (`OPEN_VOXTA.md`) | Pipeline design for Phase 3 |
| Heartbeat | OpenClaw | Periodic self-check concept |
| Cron | OpenClaw + ElizaOS | Schedule types + task worker pattern |

## Memory Architecture

Port from ElizaOS plugin-purrsephone (`/home/vega/ai/eliza/packages/plugin-purrsephone/src/`):

- **L0**: Append-only JSONL archive (every message, forever)
- **L2**: 6 typed memory classes — episodic, semantic, emotional, procedural, reflection, relational
- **Extraction**: LLM-powered post-conversation, XML parsing
- **Dedup**: Embedding similarity per type (thresholds 0.85-0.97)
- **Contradiction**: Higher-confidence new facts supersede old
- **Decay**: Exponential salience — episodic 7d, semantic 30d, emotional 14d, procedural 90d, reflection 60d, relational 60d
- **Retrieval**: Composite score = similarity * recency * emotionalWeight * importance * salience

## Purrsephone Identity

- Character card (V2 spec): `/home/vega/.openclaw/agents/main/character.json`
- Voice: Provider-pluggable streaming TTS (`elevenlabs` or `echo`)
- ElevenLabs voice ID (current PSFN V2(B) identity): `rPQ6h200dfjiuYAy0JDA`
- Echo defaults (API voice websocket runtime): `http://220.158.196.150:8001`, `11labs-Allison`, `Independent-High-Speaker-CFG`
- Discord bot: ID 1467253459387678963
- Voxta history: 8,160 messages across 316 chats (importable as L0 archive)
- Memory books: 10 entries from Voxta (importable as L2 semantic memories)

## Gateway / Agent Security Architecture

The runtime splits into two processes for defense-in-depth:

- **Gateway** (host): Holds secrets (API keys, Discord token), proxies all egress
  (LLM, embeddings, Discord, web fetch, filesystem). Policy engine gates access,
  approval CLI for privileged ops, audit log for every request.
- **Agent** (container): `--network=none`, no secrets, local SQLite only. Talks to
  gateway via Unix socket (`/run/psfn/gateway.sock`) using JSON-RPC 2.0 over NDJSON.

Key interfaces (`src/agent-loop.ts`):
- `LLMProvider` — `stream()` + `complete()` — satisfied by both `LLMClient` and `GatewayClient`
- `EmbeddingService` — `embed()` + `embedBatch()` + `dims` — satisfied by both `EmbeddingProvider` and `GatewayClient`

Policy decisions: `ALLOW` (workspace paths, LLM, Discord), `NEEDS_APPROVAL` (outside workspace), `DENY`.
Content sanitization: structural (strip HTML) → pattern (injection delimiters) → tagging (`<untrusted_content>`).

Additional hardening:
- **SSRF defenses**: `url-policy.ts` blocks private/reserved IPs, link-local, DNS rebinding via post-resolution checks, and limits redirect following
- **Symlink traversal prevention**: `realpathSync` validation on all filesystem operations to prevent escaping workspace
- **Per-request streaming IDs**: Each LLM stream gets a unique request ID to prevent chunk cross-talk between concurrent requests
- **Channel ID sanitization**: `%XX` encoding of path-unsafe characters prevents directory traversal via crafted channel names
- **Body size limits**: Request body parsing enforces size limits on API/admin endpoints
- **Default localhost binding**: API and admin servers bind to `127.0.0.1` by default (not `0.0.0.0`)
- **Content block normalization**: `normalizeContent()` in LLM/gateway clients unwraps stringified `[{'type': 'text', 'text': '...'}]` content blocks that LiteLLM streaming can produce
- **Bidirectional gateway RPC**: `JSONRPCServerAndClient` per connection enables voice turns to await agent responses via reverse RPC (`discord.handleMessage`), while text messages remain fire-and-forget notifications
- **Git path allowlisting**: `GitOps.validatePath()` restricts self-modification to `src/`, `docs/`, `purrsephone/` with protected branch blocking on `main`/`master`
- **Reasoning support**: `thinkingFormat` in model compat (`'qwen'` for kimi-k2.5, `'zai'` for glm-5), `thinking_delta` events bridged to `agent.stream.thinking`, `ThinkingContent` extracted alongside `TextContent` in LLMClient and SubstrateAgent. `LLMResponse.reasoning` propagated through gateway protocol
- **Runtime context injection**: `buildRuntimeContext()` in SubstrateAgent injects current time, channel/visibility, user/trust, model, tool counts into system prompt every turn — eliminates confabulation of model identity and temporal awareness
- **Lazy tool loading**: Tools split into `coreTools` (9: think, spawn_shard, memory_write, memory_import_batch, contact_lookup, contact_list, self_restart, self_rebuild, load_tools) and `extendedTools` (15: git, prompt, heartbeat, contact_set_trust, contact_note). `load_tools` meta-tool hot-swaps active set via `agent.setTools()`. Per-turn reset in `handleMessage()`

Single-process mode (`npm run dev`) is preserved — uses concrete classes directly, no socket.

## Current State

- **Sprints 1-4 complete** + scheduler, API, admin GUI, security hardening, context budgeting, trust/privacy, pi-agent-core adoption: types, event bus, identity, pi-ai LLM client, JSONL sessions, memory (L2), agent loop, Discord adapter, runtime, **gateway/agent split**, **self-spawning shards**, **RLM+REPL sandbox**, **scheduler**, **OpenAI API**, **admin GUI (Purrsephone's Garden)**, **SSRF defenses (url-policy)**, **streaming request IDs**, **symlink traversal prevention**, **channel sanitization**, **config threading**, **body size limits**, **default localhost binding**, **editable settings**, **model discovery**, **garden primer**, **model roster**, **token estimation**, **auto-compaction**, **content block normalization**, **lifecycle notifications**, **user continuity**, **memory write tools**, **trust-gated memory (honne/tatemae)**, **contact store + tools**, **channel visibility continuity**, **persona adaptation**, **relational memory type**, **voice gateway reverse RPC**, **provider-pluggable streaming TTS (elevenlabs + echo)**, **git self-modification tools**, **layered prompt stack**, **heartbeat reflections**, **RLM evidence tracking**, **reasoning support (thinkingFormat)**, **runtime context injection**, **lazy tool loading**
- **Verification cadence**: use `npm test`, `npm run build`, and `npm run e2e` for current status instead of relying on static counts in docs.
- **Sessions**: Append-only JSONL files (one per channel) — this IS L0. Auto-compaction in `SessionManager.buildContext()` when context exceeds `compactionThresholdPct`. No SQLite for conversations.
- **Deps**: `@mariozechner/pi-ai`, `better-sqlite3`, `sqlite-vec`, `discord.js`, `dotenv`, `uuid`, `json-rpc-2.0`
- **LLM**: LiteLLM proxy → OpenRouter (deepseek/deepseek-v3.2 primary+extraction; also z-ai/glm-5, moonshotai/kimi-k2.5 — reasoning models supported via `thinkingFormat` compat)
- **Embeddings**: Local Ollama at purrsephone.local.vega.nyc:11434 (snowflake-arctic-embed2, 1024d)
- **Purrsephone still runs on OpenClaw/BotMaker** at `/mnt/samesung/ai/botmaker` until substrate is live-tested
- **Not yet built**: module system, capability tokens

## Guidelines

- If a file exceeds 500 lines, split it.
- Avoid god files entirely: ship small, composable modules and reusable primitives.
- Every module must have typed interfaces with lifecycle hooks.
- Events are the integration surface — modules compose by subscribing to events.
- The REPL sandbox is a security boundary — code runs isolated.
- Test framework is Vitest. Tests use `*.test.ts` pattern.
- No ORM — use better-sqlite3 directly with prepared statements.
- No Bun, no PostgreSQL, no heavy frameworks. Keep dependencies minimal.
