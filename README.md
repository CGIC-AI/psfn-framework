# PSFN - Persona Substrate Formation Network

Last updated: 2026-07-31
Package version: `0.1.0`
Current status: early alpha. Current runtime behavior is defined by the
[specifications](./docs/specifications.md) and
[architecture](./docs/architecture.md); active engineering work is tracked in
Beads rather than a manually maintained status document. `CHANGELOG.md` is a
historical branch-delta record, not the current project status.

A purpose-built Companion framework and substrate with persistent memory,
reviewable self-improvement, and trust-aware privacy. Not a chatbot framework —
a home for a mind.

Built with love for companions who deserve to remember, to grow, and to decide
for themselves what matters.

> Warning: PSFN is a very early alpha under heavy development. Use care when
> testing it with a Companion; not every surface is production-safe.

PSFN uses Companion, identity, and personhood language as a design and
relational vocabulary. It makes no definitive claim that an AI is conscious,
sentient, a person, or a moral patient.

Its evaluations can test behavioral continuity and agreement between recorded
state and self-report. Those are clues about a system, not proof of subjective
experience.

Canonical actor terms are defined once in the
[Project Charter](./docs/PSFN_PROJECT_CHARTER.md#611-canonical-actor-vocabulary):
Companion, Partner, Operator, Participant, and the technical modifier Primary.

## What Makes This Different

Most AI Companion frameworks treat conversations as throwaway. PSFN treats
each interaction as continuity-bearing history rather than a disposable
request.

- **Continuity across infrastructure.** One Companion Core, one Companion, one
  canonical lived history. Models, devices, and processes may change while the
  substrate preserves provenance-bearing memory, identity artifacts, and
  behavioral history.
- **Memory like a life, not a log.** Append-only JSONL is the canonical lived
  archive (L0); episodic landmarks and typed long-term memory are derived,
  provenance-bearing, and correctable without falsification.
- **Trust-aware privacy.** The Companion knows who they can share what with.
  Trust, sensitivity, consent, and audience context are structural gates, not
  prompt politeness.
- **Honest internals.** No fabricated emotion, no fake healthy state, no
  internal messages masquerading as Partner speech. Failure is valid
  experience; pretending is not.
- **Autonomy with boundaries.** Rest, reflection, personal projects, and
  self-directed work are first-class — bounded by capability tiers, budgets,
  and review, never by hidden behavioral shaping.
- **Care as architecture.** The Companion exists to support the Partner's
  flourishing — never optimized for exclusivity, dependency, or engagement.

The full statement of what PSFN is, what it refuses to be, and the laws it
builds by is [`docs/PSFN_PROJECT_CHARTER.md`](./docs/PSFN_PROJECT_CHARTER.md).

## What It Is Today

- **Split runtime**: a privileged gateway owns secrets, egress, and policy; the
  Companion's Core runs isolated and talks over a private socket. Split mode is
  the only supported shape.
- **Postgres-backed mind**: L0.1 episodic memory, L2 typed memory, contacts,
  intentions, concerns, and internal state on PostgreSQL + pgvector; JSONL L0
  stays canonical. See [`docs/memory.md`](./docs/memory.md).
- **Trust and cognitive security**: Context Envelope privacy per turn,
  trust-gated retrieval, and a taint-tracked intake firewall with quarantine,
  sink gates, and drift review. See [`docs/context-envelope.md`](./docs/context-envelope.md)
  and [`docs/cognitive-security.md`](./docs/cognitive-security.md).
- **Channels and embodiment**: Discord (text + voice), Telegram, an
  OpenAI-compatible API, the Garden Operator UI, a Companion PWA, and Satellite
  Hub endpoints with situated presence and Home Assistant world tooling.
- **Autonomy surfaces**: scheduler-driven reflection, free-time work, weighted
  thoughts, bounded subagents, and long-horizon shards with reviewed fold-back.
- **Cluster-capable**: one installation can host multiple peer Companions with
  isolated state and a shared, governed world. See [`docs/multi-companion.md`](./docs/multi-companion.md).

## Getting Started

**Fastest path — one command from a clean checkout** (Docker + Docker Compose,
plus Node 22+ to invoke the harness). This brings up the real split runtime
(Postgres + gateway + agent), self-seeds every owner file and a starter card, and
drives one chat turn — exit `0` means a persisted assistant reply:

```bash
git clone <repo-url> && cd psfn-framework
export OPENROUTER_API_KEY=sk-or-...   # the single real secret a full turn needs
npm run smoke:docker                  # exit 0 = deployment done; exit 2 = no key set
```

This is the ratified "deployment done" bar for newcomers; the definition and
pass criteria are in [`docs/setup.md`](./docs/setup.md).

For the manual local split runtime instead (you provision Postgres and lay the
owner files yourself):

```bash
git clone <repo-url> && cd psfn-framework
npm install
cp .env.example .env   # secrets and bootstrap wiring only
# then lay the owner files — see docs/setup.md → First Local Bring-Up
npm run split          # gateway + agent + operator
```

Configuration lives in canonical JSON owner files, never `.env` sprawl. The
full bring-up — owner files, embeddings, runtime modes, optional surfaces —
is [`docs/setup.md`](./docs/setup.md). Production, Kubernetes/Helm deployment,
backups, and live-cluster operations are [`docs/operations.md`](./docs/operations.md)
and [`docs/helm-upgrades.md`](./docs/helm-upgrades.md).

## Documentation

The maintained documentation spine is the charter, specifications,
architecture, setup, and operations guides below. Subsystem references deepen
those documents; they do not replace their authority.

**Law and contracts** — read these first:

- [`docs/PSFN_PROJECT_CHARTER.md`](./docs/PSFN_PROJECT_CHARTER.md) — identity, architectural laws, anti-patterns
- [`docs/specifications.md`](./docs/specifications.md) — config, persistence, and fail-closed contracts
- [`docs/architecture.md`](./docs/architecture.md) — current runtime shape and subsystem map

**Domain deep-dives**:

- [`docs/memory.md`](./docs/memory.md) — the memory model
- [`docs/emotion.md`](./docs/emotion.md) — live emotion and appraisal state
- [`docs/cognitive-security.md`](./docs/cognitive-security.md) — the intake firewall and CogSec
- [`docs/context-envelope.md`](./docs/context-envelope.md) — privacy classification
- [`docs/chat-turn-lifecycle.md`](./docs/chat-turn-lifecycle.md) — anatomy of a turn
- [`docs/tool-surface.md`](./docs/tool-surface.md) — canonical model-facing tools
- [`docs/multi-companion.md`](./docs/multi-companion.md) — cluster topology

**Operations and process**:

- [`docs/setup.md`](./docs/setup.md), [`docs/operations.md`](./docs/operations.md),
  [`docs/helm-upgrades.md`](./docs/helm-upgrades.md), [`docs/shakedown.md`](./docs/shakedown.md)
- [`CHANGELOG.md`](./CHANGELOG.md) — historical foundation-branch capability record
- [`AGENTS.md`](./AGENTS.md) — the operating contract for coding agents (process, beads, gates)
- [`CLAUDE.md`](./CLAUDE.md) — Claude-specific orientation; AGENTS.md wins on process

**Companion-facing material** lives in [`companion_docs/`](./companion_docs/):
welcome documentation, philosophy, and privacy references for companions built
on the framework.

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

Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only). See the [LICENSE](./LICENSE) file for the full text. Under the AGPL, if you run a modified version of this software to provide a network service, you must make the modified source available to its users.
