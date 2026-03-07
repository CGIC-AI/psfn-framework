# Purrsephone Substrate Specification

*Revision date: 2026-03-07*

A purpose-built runtime for long-lived AI companions with persistent memory, trust-aware privacy, and controlled self-modification.

## Purpose

PSFN is a runtime substrate, not a stateless chatbot wrapper. The system is designed so a companion can:

- Keep durable history (`L0` JSONL sessions)
- Form and retrieve typed long-term memories (`L2` SQLite + vectors)
- Operate with channel-aware privacy/trust policy
- Use tools (including controlled git operations) while preserving auditability

## Current Implementation Snapshot

The codebase currently ships the following architecture layers:

| Layer | Current state |
| --- | --- |
| Runtime Core | Implemented (`src/runtime.ts`, agent loop, event bus, lifecycle wiring) |
| REPL Sandbox | Implemented as `think` tool with guarded execution |
| Memory System | Implemented (`L0` sessions + `L2` typed extraction/retrieval/decay) |
| Trust & Privacy | Implemented (honne/tatemae policy, trust tiers, sensitivity tiers, channel visibility) |
| Identity & Prompts | Implemented (layered prompt stack + editable admin surfaces) |
| Git Self-Modification | Implemented (`GitOps` + path allowlist + protected branch rules + audit logging) |
| Module System | Implemented (registry + loader in single/split agent runtime, tier-gated install flow) |
| Channel Layer | Implemented (Discord, OpenAI-compatible API, admin GUI, websocket voice transport) |
| Scheduler | Implemented (heartbeat, cron, one-shot, maintenance workers) |

## Runtime Modes

### Single-process

- Entry: `src/index.ts`
- Typical command: `npm run dev`
- Useful for local development and fast iteration.

### Gateway + agent split

- Entry points: `src/gateway-main.ts` and `src/agent-main.ts`
- Gateway holds secrets and egress access.
- Agent can run in constrained mode (`--network=none`) and communicates via JSON-RPC over NDJSON Unix socket.

## Voice Substrate (Current)

### Transport surfaces

- Discord voice runtime: `src/channels/discord/voice.ts`
- API websocket voice runtime: `src/channels/api/voice-websocket-runtime.ts`
- Shared websocket transport primitives: `src/voice/transports/websocket/*`

### STT

- Streaming STT connector path is Deepgram-based in current runtime wiring.

### TTS

Streaming TTS is provider-pluggable and currently supports:

- `elevenlabs`
- `echo`

Registry and provider factories:

- `src/voice/connectors/tts/index.ts`

Echo streaming connector:

- `src/voice/connectors/tts/echo-stream.ts`
- Echo endpoint shape: `/v1/audio/speech`

### Provider selection and defaults

- Config key: `TTS_PROVIDER` (alias: `VOICE_TTS_PROVIDER`)
- Runtime default provider: `elevenlabs`
- Valid providers: `elevenlabs`, `echo`

For API websocket voice runtime (`src/channels/api/voice-websocket-runtime.ts`), Echo defaults are:

- API URL default example: `${ECHO_TTS_URL}` (configure via environment variable)
- Voice default: `11labs-Allison`
- Preset default: `Independent-High-Speaker-CFG`

Discord voice runtime supports the same providers with connector fallback ordering, but requires explicit Echo URL/voice config to instantiate the Echo connector in that path.

### Discord DM + Voice readiness contract

- Runtime readiness is validated by `scripts/discord-dm-voice-smoke.mjs`.
- Opus decoder strategy is explicit:
  - Preferred backend: `@discordjs/opus` (native, lower CPU usage).
  - Fallback backend: `opusscript` (portable JS fallback, higher CPU usage).
  - Both are declared in `package.json` as optional dependencies so deployments can install whichever backend is feasible for the host environment.
- Voice receive is guarded by runtime preflight in `src/channels/discord/voice.ts`:
  - If Opus decoding is unavailable, Discord voice receive is disabled intentionally (DM/text routing remains available).
  - Missing required voice env vars also disable voice receive rather than hard-crashing startup.
- Full prerequisites, smoke usage, and troubleshooting are documented in `docs/DISCORD_DM_VOICE_READINESS.md`.

## Persistence Model

- Sessions (`L0`): append-only JSONL per channel (`data/sessions/`)
- Memories (`L2`): SQLite (`better-sqlite3`) + sqlite-vec embeddings
- Contacts/trust metadata: SQLite-backed stores
- Prompt layers/history: JSON + JSONL history artifacts
- Gateway audit trail: persisted audit database/log surfaces

## Security Posture

Implemented defenses include:

- Gateway/agent process split for secret isolation
- URL policy SSRF protections (private/reserved ranges, rebinding checks, redirect controls)
- Filesystem boundary checks (symlink traversal prevention on guarded operations)
- Request/body limits on API/admin surfaces
- Localhost-default binding for admin/API services
- Voice reliability/security policy hooks for STT/TTS stages

## Source-of-Truth Guidance

When documentation and code differ, trust code in this order:

1. `src/types.ts` (env parsing and defaults)
2. Runtime wiring (`src/runtime.ts`, `src/agent-main.ts`, `src/gateway-main.ts`)
3. Channel/voice implementations under `src/channels/` and `src/voice/`

## Issue Tracking Workflow

Contributor and agent workflow uses **bd (beads)** for all tracked work.

- Use `bd ready --json` to find unblocked tasks.
- Claim with `bd update <id> --status in_progress --json`.
- Close with `bd close <id> --reason "Done" --json`.
- Keep `.beads/issues.jsonl` in commit scope whenever issue state changes.

## Not Yet Fully Shipped

The following are intentionally incomplete or still evolving:

- Module governance hardening (trust catalog/signing/supply-chain controls)
- Capability token layer

## Verification Commands

Use these to validate current runtime health:

```bash
npm test
npm run lint
npm run build
npm run smoke:discord:dm-voice -- --dry-run --strict
```

For deployed stacks, also validate API/admin reachability and any channel-specific smoke tests used by your environment.
