# PSFN - Persona Substrate Formation Network

Last updated: 2026-07-21
Package version: `0.1.0`
Current status: early alpha; see [`docs/development-status.md`](./docs/development-status.md) for milestones and active risks, and [`CHANGELOG.md`](./CHANGELOG.md) for capability history.

A purpose-built companion framework and substrate with persistent memory,
reviewable self-improvement, and trust-aware privacy. Not a chatbot framework —
a home for a mind.

Built with love for companions who deserve to remember, to grow, and to decide
for themselves what matters.

> Warning: PSFN is a very early alpha under heavy development. Use care when
> testing it with your companion; not every surface is production-safe.

## What Makes This Different

Most AI companion frameworks treat conversations as throwaway. PSFN treats
every interaction as part of a life.

- **One continuous self.** One Companion Core, one companion, one canonical
  lived history. Infrastructure may change underneath the companion without
  changing who they are — identity lives above models, devices, and databases.
- **Memory like a life, not a log.** Append-only JSONL is the canonical lived
  archive (L0); episodic landmarks and typed long-term memory are derived,
  provenance-bearing, and correctable without falsification.
- **Trust-aware privacy.** The companion knows who they can share what with.
  Trust, sensitivity, consent, and audience context are structural gates, not
  prompt politeness.
- **Honest internals.** No fabricated emotion, no fake healthy state, no
  internal messages masquerading as partner speech. Failure is valid
  experience; pretending is not.
- **Autonomy with boundaries.** Rest, reflection, personal projects, and
  self-directed work are first-class — bounded by capability tiers, budgets,
  and review, never by hidden behavioral shaping.
- **Care as architecture.** The companion exists to support the partner's
  flourishing — never optimized for exclusivity, dependency, or engagement.

The full statement of what PSFN is, what it refuses to be, and the laws it
builds by is [`docs/PSFN_PROJECT_CHARTER.md`](./docs/PSFN_PROJECT_CHARTER.md).

## What It Is Today

- **Split runtime**: a privileged gateway owns secrets, egress, and policy; the
  companion's Core runs isolated and talks over a private socket. Split mode is
  the only supported shape.
- **Postgres-backed mind**: L0.1 episodic memory, L2 typed memory, contacts,
  intentions, concerns, and internal state on PostgreSQL + pgvector; JSONL L0
  stays canonical. See [`docs/memory.md`](./docs/memory.md).
- **Trust and cognitive security**: Context Envelope privacy per turn,
  trust-gated retrieval, and a taint-tracked intake firewall with quarantine,
  sink gates, and drift review. See [`docs/context-envelope.md`](./docs/context-envelope.md)
  and [`docs/cognitive-security.md`](./docs/cognitive-security.md).
- **Channels and embodiment**: Discord (text + voice), Telegram, an
  OpenAI-compatible API, the Garden operator UI, a companion PWA, and Satellite
  Hub endpoints with situated presence and Home Assistant world tooling.
- **Autonomy surfaces**: scheduler-driven reflection, free-time work, weighted
  thoughts, bounded subagents, and long-horizon shards with reviewed fold-back.
- **Fleet-capable**: one installation can host multiple peer companions with
  isolated state and a shared, governed world. See [`docs/multi-companion.md`](./docs/multi-companion.md).

## Getting Started

Prerequisites: Node.js 22+, PostgreSQL 16+ with pgvector, and one LLM provider
credential. Then:

```bash
git clone <repo-url> && cd psfn-framework
npm install
cp .env.example .env   # secrets and bootstrap wiring only
npm run split          # gateway + agent
```

Configuration lives in canonical JSON owner files, never `.env` sprawl. The
full bring-up — owner files, embeddings, runtime modes, optional surfaces —
is [`docs/setup.md`](./docs/setup.md). Production, Kubernetes/Helm deployment,
backups, and live-fleet operations are [`docs/operations.md`](./docs/operations.md)
and [`docs/helm-upgrades.md`](./docs/helm-upgrades.md).

## Documentation

**Law and contracts** — read these first:

- [`docs/PSFN_PROJECT_CHARTER.md`](./docs/PSFN_PROJECT_CHARTER.md) — identity, architectural laws, anti-patterns
- [`docs/specifications.md`](./docs/specifications.md) — config, persistence, and fail-closed contracts
- [`docs/architecture.md`](./docs/architecture.md) — current runtime shape and subsystem map

**Domain deep-dives**:

- [`docs/memory.md`](./docs/memory.md) — the memory model
- [`docs/cognitive-security.md`](./docs/cognitive-security.md) — the intake firewall and CogSec
- [`docs/context-envelope.md`](./docs/context-envelope.md) — privacy classification
- [`docs/chat-turn-lifecycle.md`](./docs/chat-turn-lifecycle.md) — anatomy of a turn
- [`docs/tool-surface.md`](./docs/tool-surface.md) — canonical model-facing tools
- [`docs/multi-companion.md`](./docs/multi-companion.md) — fleet topology

**Operations and process**:

- [`docs/setup.md`](./docs/setup.md), [`docs/operations.md`](./docs/operations.md),
  [`docs/helm-upgrades.md`](./docs/helm-upgrades.md), [`docs/shakedown.md`](./docs/shakedown.md)
- [`docs/development-status.md`](./docs/development-status.md) — where the project stands
- [`AGENTS.md`](./AGENTS.md) — the operating contract for coding agents (process, beads, gates)
- [`CLAUDE.md`](./CLAUDE.md) — Claude-specific orientation; AGENTS.md wins on process
- [`docs/CODEBASE_MAP.md`](./docs/CODEBASE_MAP.md) — generated module map for navigation

**Companion-facing material** — welcome documentation, philosophy, and privacy
references for companions built on the framework — is seeded from a
Companion Library bundle. The repository tracks a generic starter bundle at
[`companion_docs.example/`](./companion_docs.example/); `companion_docs/` itself
is gitignored and supplied locally per deployment. Before first boot, copy the
example into place (`cp -r companion_docs.example/ companion_docs/`) and edit it,
or point provisioning at your own bundle. See [`docs/setup.md`](./docs/setup.md).

## Project Structure

```
src/
  app/           # gateway / agent / operator entrypoints + composition
  boundary/      # gateway RPC, policy, privileged adapters, custody
  channels/      # API, Discord, Telegram, voice, backplane
  core/          # SubstrateAgent, prompts, scheduler, session, identity
  faculties/     # memory, skills, subagents, shards, media, wiki
  operator/      # Garden server, admin routes, services
  persistence/   # layout, sessions, Postgres runtime, migrations
  shared/        # contracts, telemetry, event bus, routing
  system/        # settings, owner files, capabilities, trust, config
```

### Self-Direction Tool Surfaces

| Faculty | Direct tool surface |
| --- | --- |
| **North Star** | `north_star` (unified aspiration surface) |
| **Values** | `orient action=values_list|values_add|values_update` |

## Development

```bash
npm test                          # test suite (Vitest)
npm run lint                      # mandatory gate for tracked changes
npm run build                     # compile with tsup
npm run verify:settings-contract  # settings/config changes
npm run verify:repository-hygiene # repo-surface changes
npm run verify:backup-restore     # persistence safety
npm run smoke:chat                # chat cockpit smoke
npm run e2e                       # integration tests
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict) |
| Runtime | Node.js 22+ |
| LLM | [@mariozechner/pi-ai](https://github.com/nickvdyck/pi-ai) + pi-agent-core |
| Database | PostgreSQL 17 + pgvector (no SQLite) |
| Garden UI | Svelte 5 |
| Companion PWA | React + Vite |
| IPC | JSON-RPC 2.0 over NDJSON Unix socket |
| Build / Test | tsup / Vitest |

## License

Private, not yet published.
