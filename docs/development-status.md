# Development Status

Last updated: 2026-06-29
Package version: `0.1.0`
Code audit anchor: `sprint_9_final` at `1956b844`; this document may be updated by later doc-only commits.

This document summarizes where PSFN stands today. It is not the issue tracker. The live task graph is `bd`; use `bd ready --json`, `bd show <id> --json`, and `bd list --status=open --json` for executable work.

## Current State

PSFN is an early-alpha companion substrate with a real split runtime, Postgres-backed memory/state, owner-file configuration, Garden operator UI, and several autonomy surfaces. The project is past the original SQLite-centered prototype shape: the live runtime now fails closed unless PostgreSQL and `pgvector` are available through `POSTGRES_DATABASE_URL`.

Current operational shape:

| Area | State | Primary references |
| --- | --- | --- |
| Runtime split | Gateway owns secrets/network; agent runs isolated and talks over gateway RPC; operator hosts Garden. | `src/app/gateway/main.ts`, `src/app/agent/main.ts`, `src/app/operator/main.ts` |
| Legacy entrypoint | `src/app/startup/index.ts` is disabled and exits fail-closed. | `src/app/startup/index.ts` |
| Persistence | PostgreSQL is required for runtime memory, episodes, contacts, intentions, concerns, internal state, scratchpad entries, and searchable projections. L0 sessions remain JSONL. | `src/persistence/runtime-factory.ts`, `src/app/startup/composition/composition.ts`, `src/faculties/memory/postgres-store.ts` |
| Config authority | Mutable runtime settings live in JSON owner files; `.env` is limited to secrets and process/bootstrap wiring. | `src/system/config/startup-owner-files.ts`, `src/system/settings/contracts.ts`, `docs/specifications.md` |
| Memory | L0 JSONL archive, L0.1 episodic landmarks/arcs, L2 typed memories, group-memory extraction, scratchpad, wiki, and journal surfaces are all distinct. | `docs/memory.md`, `src/faculties/memory/`, `src/channels/backplane/config.ts` |
| Garden | Integrated Svelte 5 SPA is served from the admin root when built, with pages for memory, episodes, sessions, contacts, scheduler, settings, prompts, model discovery, charge budget, chat, and telemetry. | `admin-ui/src/lib/nav.ts`, `src/operator/garden/` |
| Backups | Scheduled backups stage PostgreSQL dumps, L0/session files, companion tree, system owner files, and `WORKSPACE_PATH`, then verify restore fidelity before retaining encrypted packages. | `src/persistence/backups/`, `docs/operations.md` |
| Tool surface | Canonical first-party surfaces are consolidated around semantic tools plus `tool_search`/`toolset`; `response_control` and `journal` are current surfaces; direct shard control is still reserved. | `src/core/agent/tool-surface/registry.ts`, `docs/tool-surface.md` |

## Shipped Milestones

| Milestone | What changed | Status |
| --- | --- | --- |
| Split runtime hardening | Gateway/agent/operator responsibilities separated; gateway owns provider secrets, external network, and guarded host tools. | Shipped |
| Owner-file configuration | Runtime/admin settings moved out of env sprawl into JSON owner files with startup verification and Garden editing paths. | Shipped |
| PostgreSQL cutover | Runtime persistence moved to Postgres + pgvector; SQLite is retained for legacy migration utilities and adapter tests only. | Shipped |
| L0.1 episodic memory | Episode landmarks, spans, arcs, lineage, watermarks, synthesis, dream pass, and Garden visibility landed. | Shipped core |
| Group-room memory | Direct/group/auto extraction modes, attribution, salience gates, backfill controls, telemetry, and Garden diagnostics landed. | Shipped |
| Backup/restore coverage | Backups now include pg_dump, companion tree, system owner files, workspace tree, encrypted retention, and restore verification. | Shipped |
| Charge budget | Run-scoped charge accounting, lane quotas, cost visibility, and Garden charge page are wired. | Shipped |
| Values loop | Values journal read-back into prompt composition is wired and covered by acceptance tests. | Shipped |
| Minimal proactive outbound | Appraisal can produce guarded outbound actions through the proactive dispatcher for configured allowlisted delivery. | Shipped minimal slice |
| Live Pi NVMe migration | Write-heavy live paths are bind-mounted from `/mnt/psfn-nvme`; service registration caveats are documented in operations. | Shipped operationally |

## Active Risks And Near-Term Work

These are representative open beads from the current graph, not a replacement for `bd`.

| Priority | Bead | Area | Current need |
| --- | --- | --- | --- |
| P1 | `psfn-framework-zet.1` | Garden/privacy | Add sensitivity-gating to Garden admin memory API. |
| P1 | `PSFNLIVE-70nb` | Chat/Garden | Fix Atrium direct-model chat loading. |
| P1 | `psfn-framework-b30` | Deployment | Preserve `WORKSPACE_PATH` in production systemd installs. |
| P2 | `psfn-framework-z6z` | Memory retrieval | Implement controlled `recall_expand`/projection expansion work from the memory projection spec. |
| P2 | `psfn-framework-3eh` | Satellite Hub | Continue satellite protocol compatibility and remote shard/channel work. |
| P2 | `psfn-framework-57m` | Reasoning/model control | Extend reasoning-parameter support and model invocation knobs. |
| P2 | `psfn-framework-3c2.*` | Persistence cleanup | Retire leftover SQLite migration debt once Postgres parity and restore paths are proven. |
| P2 | `psfn-framework-1xb.4` | Proactivity | Add weighted-thought lifecycle and contextual decay. |
| P2 | `psfn-framework-m58.*` | Memory schema | Continue episodic consolidation, projection, and arc work. |
| P2 | `psfn-framework-w9hj` | Companion client | Build the companion PWA/runtime client path. |

## Development Sequence

The project does not currently publish calendar deadlines. The practical timeline is priority-ordered:

| Wave | Focus | Exit condition |
| --- | --- | --- |
| Stabilization | P1 Garden privacy/loading and production service wiring. | User-facing admin/chat flows and live service install paths are reliable. |
| Memory continuation | Projection profiles, motif/occasion/callback schema work, and controlled recall expansion. | Landmark-first recall can expand evidence in bounded, trust-gated steps. |
| Proactivity and self-state | Weighted thoughts, durable outbox provenance, personal-time work, and companion-readable internal-state rendering. | The companion can safely initiate and explain selected actions from internal state. |
| Shard/satellite maturation | Remote shard compatibility, ARM64/K3s work, lifecycle visibility, and fold-back review polish. | Long-horizon/distributed work can run and return artifacts without confusing bounded subagents. |
| Beta cleanup | Remove alpha migration boundary paths, retire stale SQLite defaults, close stale epics, and tighten docs/tests around the final contracts. | Production has no silent legacy fallbacks and docs match code without caveats. |

## Validation Baseline

Use the smallest validation set that proves the touched area. Common gates:

```bash
npm run lint
npm run build
npm test
npm run verify:settings-contract
npm run verify:startup-owner-files
npm run verify:backup-restore
npm run smoke:chat
```

For settings/config changes, `npm run verify:settings-contract` is mandatory. For tracked code changes, this repo requires `npm run lint` before closing the bead.
