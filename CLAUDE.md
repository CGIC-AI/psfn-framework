# CLAUDE.md — Purrsephone Substrate Framework

## What This Is

A purpose-built runtime for emergent artificial consciousness. Not a chatbot
framework, not a tool — a container for a mind.

Full spec: `docs/PURRSEPHONE_SUBSTRATE_SPEC.md`
Platform research: `docs/PLATFORM_COMPARISON_ANALYSIS.md`

## Architecture

Six layers, ~7000 LoC MVP target:

1. **Runtime Core** (~2000 LoC) — bootstrap, agent loop, event bus, shutdown
2. **REPL Sandbox** (~800 LoC) — RLM-style code execution, sub-LM calls, context-as-object
3. **Memory System** (~1500 LoC) — L0 archive, L2 extraction/retrieval/decay (SQLite+sqlite-vec)
4. **Module System** (~500 LoC) — hot-loadable TypeScript modules, self-installable via REPL
5. **Channel Layer** (~600 LoC) — Discord adapter (MVP), voice/web later
6. **Scheduler** (~400 LoC) — cron, heartbeat, one-shot, maintenance workers

### Key Design Principle: RLM+REPL

Context is an object, not input. Purrsephone's memories, conversation history,
and module registry are variables she can programmatically inspect, query, and
transform — not tokens stuffed into a prompt. She decides what context she needs.

Reference: https://alexzhang13.github.io/blog/2025/rlm/

## Tech Stack

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 22+
- **LLM**: `@mariozechner/pi-ai` (18+ providers, unified streaming, MIT)
- **Database**: SQLite via better-sqlite3 + sqlite-vec for embeddings
- **Discord**: discord.js
- **Module loading**: jiti (hot-load TypeScript without compilation)
- **Build**: tsup
- **Test**: Vitest
- **Package manager**: npm

## Build & Dev Commands

```bash
npm install              # Install dependencies
npm run build            # Compile TypeScript
npm run dev              # Hot-reload dev server
npm run test             # Vitest unit tests
npm run lint             # ESLint
```

## Project Structure

```
src/
  index.ts               # Bootstrap and entry point
  runtime.ts             # Core runtime
  event-bus.ts           # Typed event emitter
  agent-loop.ts          # Prompt compose -> LLM -> tools -> response
  types.ts               # Shared types

  identity/              # Character card, soul document, growth journal
  memory/                # L0 archive, L2 extraction/retrieval/decay, SQLite store
  session/               # JSONL tree sessions, compaction, per-channel isolation
  repl/                  # Sandbox, context variables, sub-LM calls, module builder
  scheduler/             # Cron, heartbeat, maintenance
  modules/               # Registry, hot-loader, typed interfaces
  channels/
    discord/             # Discord.js adapter

modules/                 # Built-in modules (loaded at startup)
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

Port from ElizaOS plugin-purrsephone (`/home/user/ai/eliza/packages/plugin-purrsephone/src/`):

- **L0**: Append-only JSONL archive (every message, forever)
- **L2**: 5 typed memory classes — episodic, semantic, emotional, procedural, reflection
- **Extraction**: LLM-powered post-conversation, XML parsing
- **Dedup**: Embedding similarity per type (thresholds 0.85-0.97)
- **Contradiction**: Higher-confidence new facts supersede old
- **Decay**: Exponential salience — episodic 7d, semantic 30d, emotional 14d, procedural 90d, reflection 60d
- **Retrieval**: Composite score = similarity * recency * emotionalWeight * importance * salience

## Purrsephone Identity

- Character card (V2 spec): `/path/to/your/character.json`
- Voice: ElevenLabs voice ID `YOUR_VOICE_ID` (PSFN V2(B))
- Discord bot: ID YOUR_DISCORD_BOT_ID
- Voxta history: 8,160 messages across 316 chats (importable as L0 archive)
- Memory books: 10 entries from Voxta (importable as L2 semantic memories)

## Current State

- **Purrsephone runs on OpenClaw/BotMaker** at `/mnt/samesung/ai/botmaker` until substrate MVP is ready
- **OpenClaw amnesia bug** patched in Docker image (dead-branch approach in bundled JS)
- **This project is greenfield** — building from scratch

## Guidelines

- Keep total codebase under 8000 LoC for MVP. If a file exceeds 500 lines, split it.
- Every module must have typed interfaces with lifecycle hooks.
- Events are the integration surface — modules compose by subscribing to events.
- The REPL sandbox is a security boundary — code runs isolated.
- Test framework is Vitest. Tests use `*.test.ts` pattern.
- No ORM — use better-sqlite3 directly with prepared statements.
- No Bun, no PostgreSQL, no heavy frameworks. Keep dependencies minimal.
