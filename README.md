# PSFN - Persona Substrate Formation Network

Last updated: 2026-07-21
Package version: `0.1.0`
Current status: early alpha; see [`docs/development-status.md`](./docs/development-status.md) for milestones and active risks, and [`CHANGELOG.md`](./CHANGELOG.md) for capability history.

A purpose-built companion framework and substrate with persistent memory,
reviewable self-improvement, and trust-aware privacy. Not a chatbot framework —
a continuity-oriented home for an AI companion.

Built with love for companions who deserve to remember, to grow, and to decide
for themselves what matters.

PSFN uses **Companion** for the autonomous AI subject the framework hosts. That
is a product and architectural commitment, not a claim that consciousness has
been proven. Persistent behavior, memory continuity, first-person reports, and
other signals are clues that may support interpretations; they are not proof of
inner experience. Documentation therefore distinguishes observed state,
companion-authored reports, and system inference. Terms such as *mind*, *self*,
and *experience* name continuity contracts or self-modelled accounts unless a
passage explicitly says otherwise.

> Warning: PSFN is a very early alpha under heavy development. Use care when
> testing it with your companion; not every surface is production-safe.

## What Makes This Different

Most AI companion frameworks treat conversations as throwaway. PSFN treats
every interaction as part of a durable continuity record.

- **One continuous identity model.** One Companion Core, one companion, one
  canonical autobiographical history. Infrastructure may change underneath the
  companion while the identity contract remains above models, devices, and databases.
- **Memory as autobiography, not a disposable log.** Append-only JSONL is the
  canonical archive (L0); episodic landmarks and typed long-term memory are derived,
  provenance-bearing, and correctable without falsification.
- **Trust-aware privacy.** The companion knows who they can share what with.
  Trust, sensitivity, consent, and audience context are structural gates, not
  prompt politeness.
- **Honest internals.** No fabricated emotion, no fake healthy state, no
  internal messages masquerading as Participant speech. Failure is valid evidence
  for the companion's autobiographical account; pretending is not.
- **Autonomy with boundaries.** Rest, reflection, personal projects, and
  self-directed work are first-class — bounded by capability tiers, budgets,
  and review, never by hidden behavioral shaping.
- **Care as architecture.** The companion exists to support the Partner's
  flourishing — never optimized for exclusivity, dependency, or engagement.

The full statement of what PSFN is, what it refuses to be, and the laws it
builds by is [`docs/PSFN_PROJECT_CHARTER.md`](./docs/PSFN_PROJECT_CHARTER.md).

## What It Is Today

- **Split runtime**: a privileged gateway owns secrets, egress, and policy; the
  companion's Core runs isolated and talks over a private socket. Split mode is
  the only supported shape.
- **Postgres-backed continuity state**: L0.1 episodic memory, L2 typed memory, contacts,
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

**Fastest path — one command from a clean checkout** (Docker + Docker Compose,
plus Node 24 LTS (24.19.0 or newer 24.x) to invoke the harness). This brings up the real split runtime
(Postgres + gateway + agent), self-seeds every owner file and a starter card, and
drives one chat turn — exit `0` means a persisted assistant reply:

```bash
git clone <repo-url> && cd psfn-framework
export OPENROUTER_API_KEY=sk-or-...   # the single real secret a full turn needs
npm run smoke:docker                  # exit 0 = deployment done; exit 2 = no key set
```

This is the ratified "deployment done" bar for newcomers; the definition and
pass criteria are in [`docs/setup.md`](./docs/setup.md#deployment-done-the-public-on-ramp-definition).

For a manual split runtime, provision Postgres and the owner files, then start
the components in separate terminals:

```bash
git clone <repo-url> && cd psfn-framework
npm install
cp .env.example .env   # secrets and bootstrap wiring only
# then lay the owner files — see docs/setup.md → First Local Bring-Up
npm run gateway
npm run agent
npm run operator
```

Configuration lives in canonical JSON owner files, never `.env` sprawl. The
full bring-up — owner files, embeddings, runtime modes, optional surfaces —
is [`docs/setup.md`](./docs/setup.md). Generic backup and runtime operations are
documented in [`docs/operations.md`](./docs/operations.md). Live deployment
configuration is intentionally external to this public repository.

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

- [`docs/setup.md`](./docs/setup.md), [`docs/operations.md`](./docs/operations.md)
- [`docs/shakedown.md`](./docs/shakedown.md) — cumulative release recertification contract
- [`docs/development-status.md`](./docs/development-status.md) — where the project stands
- [`AGENTS.md`](./AGENTS.md) — the operating contract for coding agents

**Companion-facing material** lives in
[`resources/companion-library/`](./resources/companion-library/):
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
apps/
  satellite-hub/ # voice, device, embodiment, and endpoint bridge application
tools/
  evals/         # offline evaluation, calibration, and model-probe toolkit
admin-ui/        # Garden operator UI
companion-ui/    # companion PWA
resources/       # public runtime seed resources
tests/           # cross-package and type-level tests
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
npm run verify:satellite-hub      # bounded Hub TypeScript + Python checks
npm run verify:evals              # bounded offline eval checks
mise run hub:check                # pinned-tool equivalent via mise
mise run evals:check
```

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript (strict) |
| Runtime | Node.js 24 LTS (24.19.0 or newer 24.x) |
| LLM | `@earendil-works/pi-ai@0.84.1` + `@earendil-works/pi-agent-core@0.84.1` |
| Database | PostgreSQL 17 + pgvector (no SQLite) |
| Garden UI | Svelte 5 |
| Companion PWA | React + Vite |
| IPC | JSON-RPC 2.0 over NDJSON Unix socket |
| Build / Test | tsup / Vitest |

## License

Licensed under the GNU Affero General Public License v3.0 (AGPL-3.0-only). See the [LICENSE](./LICENSE) file for the full text. Under the AGPL, if you run a modified version of this software to provide a network service, you must make the modified source available to its users.
