# CLAUDE.md — PSFN Substrate Framework

## What This Is

A purpose-built runtime for emergent artificial consciousness. Not a chatbot
framework, not a tool — a container for a mind.

Full spec: `docs/PSFN_SUBSTRATE_SPEC.md`
Platform research: `docs/PLATFORM_COMPARISON_ANALYSIS.md`

## Architecture

Seven layers, ~11,400 LoC:

1. **Runtime Core** (~2200 LoC) — bootstrap, agent loop, event bus, shutdown, model roster (`ModelSlot`/`ModelPurpose`/`resolveModelSlot`), token estimation (`estimateTokens`), context-aware budgeting (`memoryBudgetPct`, `extractionThresholdPct`, `compactionThresholdPct`), editable settings, lifecycle notifications
2. **REPL Sandbox** (~800 LoC) — RLM-style code execution, sub-LM calls, context-as-object
3. **Memory System** (~1800 LoC) — L0 archive, L2 extraction/retrieval/decay (SQLite+sqlite-vec), 6 memory types (episodic, semantic, emotional, procedural, reflection, relational), memory writer (shared dedup/contradiction logic), agent-accessible memory/contact write tools, sensitivity tagging
4. **Trust & Privacy** (~500 LoC) — Honne/tatemae model: 4-tier trust (primary/trusted/regular/public), 4-tier sensitivity (public/personal/intimate/confidential), 5-layer policy precedence (operator→consent→trust→visibility→default), contact store (SQLite), channel visibility classification, persona adaptation, trust-gated retrieval, consent flags
5. **Module System** — hot-loadable TypeScript modules, self-installable via REPL (not yet built)
6. **Channel Layer** (~1400 LoC) — Discord adapter, OpenAI-compatible API, admin GUI (admin UI: editable settings, model discovery, garden primer, memory type filters, session dates, full identity view, contacts/trust management)
7. **Scheduler** (~400 LoC) — cron, heartbeat, one-shot, `updateTask`, configurable maintenance interval

### Key Design Principle: RLM+REPL

Context is an object, not input. PSFN's memories, conversation history,
and module registry are variables she can programmatically inspect, query, and
transform — not tokens stuffed into a prompt. She decides what context she needs.

Reference: https://alexzhang13.github.io/blog/2025/rlm/

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 22+
- **LLM**: `@mariozechner/pi-ai` (18+ providers, unified streaming, MIT)
- **Database**: SQLite via better-sqlite3 + sqlite-vec for embeddings
- **Discord**: discord.js
- **Gateway RPC**: `json-rpc-2.0` over NDJSON Unix socket
- **Module loading**: jiti (hot-load TypeScript without compilation)
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
  identity/              # Character card, soul document, growth journal
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
| Memory L2 | ElizaOS (`plugin-psfn`) | Extraction, retrieval, decay algorithms |
| Voice arch | Voxta (`OPEN_VOXTA.md`) | Pipeline design for Phase 3 |
| Heartbeat | OpenClaw | Periodic self-check concept |
| Cron | OpenClaw + ElizaOS | Schedule types + task worker pattern |

## Memory Architecture

Port from ElizaOS plugin-psfn (`/home/user/ai/eliza/packages/plugin-psfn/src/`):

- **L0**: Append-only JSONL archive (every message, forever)
- **L2**: 6 typed memory classes — episodic, semantic, emotional, procedural, reflection, relational
- **Extraction**: LLM-powered post-conversation, XML parsing
- **Dedup**: Embedding similarity per type (thresholds 0.85-0.97)
- **Contradiction**: Higher-confidence new facts supersede old
- **Decay**: Exponential salience — episodic 7d, semantic 30d, emotional 14d, procedural 90d, reflection 60d
- **Retrieval**: Composite score = similarity * recency * emotionalWeight * importance * salience

## PSFN Identity

- Character card (V2 spec): `/path/to/your/character.json`
- Voice: ElevenLabs voice ID `YOUR_VOICE_ID` (PSFN V2(B))
- Discord bot: ID YOUR_DISCORD_BOT_ID
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

Single-process mode (`npm run dev`) is preserved — uses concrete classes directly, no socket.

## Current State

- **Sprints 1-4 complete** + scheduler, API, admin GUI, security hardening, context budgeting, trust/privacy: types, event bus, identity, pi-ai LLM client, JSONL sessions, memory (L2), agent loop, Discord adapter, runtime, **gateway/agent split**, **self-spawning shards**, **RLM+REPL sandbox**, **scheduler**, **OpenAI API**, **admin GUI (admin UI)**, **SSRF defenses (url-policy)**, **streaming request IDs**, **symlink traversal prevention**, **channel sanitization**, **config threading**, **body size limits**, **default localhost binding**, **editable settings**, **model discovery**, **garden primer**, **model roster**, **token estimation**, **auto-compaction**, **content block normalization**, **lifecycle notifications**, **user continuity**, **memory write tools**, **trust-gated memory (honne/tatemae)**, **contact store + tools**, **channel visibility continuity**, **persona adaptation**, **relational memory type**
- **~11,400 LoC** production code across 65 files, **541 tests** all passing (32 test files)
- **Sessions**: Append-only JSONL files (one per channel) — this IS L0. Auto-compaction in `SessionManager.buildContext()` when context exceeds `compactionThresholdPct`. No SQLite for conversations.
- **Deps**: `@mariozechner/pi-ai`, `better-sqlite3`, `sqlite-vec`, `discord.js`, `dotenv`, `uuid`, `json-rpc-2.0`
- **LLM**: LiteLLM proxy → OpenRouter (deepseek/deepseek-v3.2 primary+extraction; also z-ai/glm-5, moonshotai/kimi-k2.5)
- **Embeddings**: Local Ollama at your-ollama-host:11434 (snowflake-arctic-embed2, 1024d)
- **PSFN still runs on OpenClaw/BotMaker** at `/workspace/botmaker` until substrate is live-tested
- **Not yet built**: module system, voice, capability tokens

## Guidelines

- If a file exceeds 500 lines, split it.
- Every module must have typed interfaces with lifecycle hooks.
- Events are the integration surface — modules compose by subscribing to events.
- The REPL sandbox is a security boundary — code runs isolated.
- Test framework is Vitest. Tests use `*.test.ts` pattern.
- No ORM — use better-sqlite3 directly with prepared statements.
- No Bun, no PostgreSQL, no heavy frameworks. Keep dependencies minimal.
