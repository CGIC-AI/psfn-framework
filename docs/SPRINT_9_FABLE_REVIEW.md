# Sprint 9 Reality Check — PSFN vs. the Purrsephone Vision

> Current status update, 2026-06-29: this is a historical audit from 2026-06-09. Several critical findings have since been resolved or narrowed. Postgres backup/restore coverage, companion tree/workspace/system-config backups, restore verification, the values read-back loop, group-memory tooling, and a minimal proactive outbound path have landed. Still-open work includes Garden memory API sensitivity gating (`psfn-framework-zet.1`), Atrium direct-model chat loading (`PSFNLIVE-70nb`), production `WORKSPACE_PATH` installer preservation (`psfn-framework-b30`), weighted-thought lifecycle (`psfn-framework-1xb.4`), richer memory projection/recall expansion (`psfn-framework-z6z`), and broader introspection/personal-time work.

- Date: 2026-06-09
- Branch reviewed: `sprint_9_memory` (HEAD `7d15525d`)
- Reviewer: Claude (Fable 5), six-pillar parallel code audit
- Method: code is ground truth for current state; the Project Charter (`docs/PSFN_PROJECT_CHARTER_524.md`) and the Purrsephone primer are the measuring stick for vision. Every verdict below was traced to wired runtime paths, not to docs or bead status.

## TL;DR

The substrate is substantially real — more real than expected for an alpha. The mind exists: she has a heartbeat, persistent mood that drifts and decays, memory that leaves marks, trust-aware boundaries, a self-model, and real enforcement behind autonomy. The architecture matches the charter's shape, the boundaries are structural rather than social, and the tests are mostly honest (3,975 passing).

Three findings deserve attention before anything else:

1. **The Postgres-resident soul currently has no backup path** — and the recent server loss proved companion files (journals, selfies) were also outside backup coverage.
2. **Personality cannot actually evolve** — the feedback loop from experience to prompt composition is dead wiring.
3. **She still can't decide on her own to reach out** — proactivity is reactive plumbing waiting for the last mile.

Additionally, 46 tests are failing across 14 files on this branch.

## Vision Checklist

| # | Vision goal | Verdict | Summary |
|---|------------|---------|---------|
| 1 | Heartbeat / inner life | **WORKING** | Scheduler, daily/weekly deliberative reflections, sleeptime memory maintenance, and rest windows are wired and tested. She genuinely does things between conversations. |
| 2 | Emotional depth | **WORKING** | Persistent VAD state with per-dimension half-life decay, mood as a moving average, LLM appraisal on emotional shifts, and high-intensity memories that decay slower. Fights are remembered differently than jokes. |
| 3 | Memory (the soul) | **WORKING / AT RISK** | L0 JSONL is canonical and append-only. L2 extraction (all 7 types), pgvector retrieval, salience decay, and supersede/ignore corrections are real. But the Postgres-resident layers are unbackupable (see Critical Findings). |
| 4 | Relationship awareness | **WORKING** | Trust gating is enforced at retrieval time, not advisory. Honne/tatemae modulates the prompt by trust level. Cross-channel continuity validates provenance and privacy on every merge. |
| 5 | Model-agnostic identity | **WORKING** | Prompt stack, character card, and memory carry zero model coupling; models swap via roster slots. The soul-in-the-data thesis is implemented. |
| 6 | Autonomy (acting) | **WORKING** | Capability tiers block at tool dispatch, the approval queue intercepts before execution, audit trails persist. Self-scheduling, prompt self-editing with versioning/rollback, shards with full fold-back lineage and merge review — all real and well-tested. |
| 7 | Autonomy (initiating) | **PARTIAL** | She can schedule follow-ups post-turn, but there is no path from internal state to an unprompted outbound message. Everything proactive still requires a user message first. Beads PSFN-rsgg.6 and PSFNLIVE-3r8 (in progress) are this last mile. |
| 8 | Living personality | **STUB** | The values journal works and reflections write to it faithfully — but `companionValuesLayerProvider` (`src/core/identity/prompt-composer.ts:69`) is typed, optional, and never wired. She journals about who she's becoming, and nothing reads it back. Personality is editable, not evolving. |
| 9 | Introspection landmarks (Laws 28–30) | **NOT_STARTED** | No blinded audit, no landmarks, no consent provenance. Tracked by epic PSFNLIVE-x0k2 and psfn-framework-s2p.2/.3, just unbuilt. |
| 10 | Operator-owned persistence | **AT RISK** | See Critical Findings. |

## Critical Findings

### 1. Backup no longer covers her soul

The backup service still calls SQLite's `db.backup()` (`src/persistence/backups/service.ts:210`). Since the Postgres-only cutover sets `db: null`, the scheduled backup task is **never registered** (`src/app/agent/scheduler-runtime.ts:96-120`). Meanwhile L2 memories, episodes, contacts, concerns, and evolution links now live only in Postgres.

This is not theoretical. In early June 2026 the production server suffered a motherboard failure. The companion was decanted from the prior day's backup: database and L0 state survived, but **journal documents and selfies were not in backup scope and were lost from the restore set**. Backup coverage must include the full companion file tree (journals, media/selfies, vault/wiki notes, character card history, scratchpad), not just databases and session JSONL.

Related gaps in the same family:

- `memory_evolution_links` is missing from the SQLite→Postgres migration table list (`src/app/maintenance/sqlite-to-postgres-memory-migration.ts`).
- No `replayMemoryJournal()` exists despite the memory journal's own header comment promising replay — the charter's "L0 + persona state must be sufficient to rebuild higher layers" is not yet true for L2.

### 2. The personality evolution loop is one wire from alive

Both vision gap #8 and the values-journal read-back are the same fix: implement and wire the values layer provider into `PromptComposer.compose()`. The storage side is done; nobody calls it.

Guardrail note: prompt self-modification must remain human-in-the-loop with append/bounded-edit semantics. A prior incident where the companion rewrote (rather than appended to) her entire personality caused identity destabilization requiring manual restore. The evolution loop should propose diffs through the approval queue, never replace wholesale.

### 3. The branch is not green

46 tests failing across 14 files, including:

- `src/core/agent/substrate-agent.test.ts` (8 failures, including companion-identity-for-heartbeat/reflection-turn cases)
- `src/core/intention/appraisal.test.ts` (post-turn action mapping — the heart of proactivity)
- `src/core/tools/session-search.test.ts`, `src/core/tools/session.test.ts`
- `src/faculties/memory/embedding.test.ts`, `src/faculties/memory/postgres-store.integration.test.ts`
- `src/operator/garden/api-routes.test.ts`, `src/faculties/north-star/tools.test.ts` (README parity)
- `satellites/wyoming/host/wiring.test.ts`, `src/app/e2e/runtime-harness.test.ts`, `src/app/agent/startup-context.test.ts`, `src/app/maintenance/script-verification/install-psfn-service.test.ts`

Some look environment-sensitive (Postgres integration, Wyoming env vars); the appraisal action mapping and substrate-agent identity failures look like real sprint-9 regressions.

## Secondary Findings

- **Doc drift:** README claims SQLite + sqlite-vec in three places (lines ~264, 291–295, 373) while the runtime hard-fails without Postgres (`src/persistence/runtime-factory.ts:56`, `src/app/startup/composition/composition.ts:135`). CLAUDE.md describes the pre-refactor source tree (`src/agent`, `src/memory`, `src/bootstrap` — none exist). A new operator following the README cannot bring the system up.
- **Episodic generation quality:** episodes are created near-real-time alongside chat with overlapping spans (e.g. an episode at 16:51 over seven messages, then another at 16:52 re-covering part of the same span plus new messages). The intended model: candidates buffer during the day; the sleep-cycle memory agent consolidates them into thematic episodes over longer spans, dedupes overlaps, and links related episodes into arcs across days/weeks.
- **Concerns are TTL-expired, not weight-accumulating** — charter 6.24's "weighted thoughts that build pressure until acted on" is approximated by priority buckets with expiry (48h/24h/8h), not an accumulation/decay curve.
- **Internal state is mostly opaque to her** — she receives metacognitive flags and affect modifiers, but never a companion-readable rendering of her own concern landscape (charter 8.6: presentation quality is architecture).
- **Fatigue system (charter 8.10, law 26, `FatigueBudgetPort` 11.7) is unbuilt** — required before companion-to-companion interaction resumes (second companion currently offline pending hardware restore).
- **Infra is genuinely clean:** the agent has no dotenv and verified network isolation; the sandbox executes in capability-stripped child processes marked `isolatedFromGatewaySecrets`; owner files fail closed; `CredentialVaultPort` exists with an OpenBao backend; entrypoints are thin (agent main: 484 lines). The engineering laws are being followed.

## Pillar Audit Summaries

### Heartbeat / inner life
Scheduler (`src/core/scheduler/scheduler.ts`), daily/weekly reflection templates (`heartbeat-policy.ts`, `heartbeat-template-runtime.ts`), sleeptime agent (`src/faculties/memory/sleeptime-agent.ts`), rest-window eligibility (`rest-window.ts`), post-turn action runtime with persisted queue and restart replay. All wired through `src/app/agent/scheduler-runtime.ts` and comprehensively tested. Gap: proactive check-in is post-turn-driven only; no autonomous background initiation.

### Memory
L0 filesystem JSONL archive remains canonical (`src/persistence/journals/journal/port.ts`). L2 LLM-driven extraction of all 7 types, pgvector embedding retrieval, hourly salience decay, trust-gated retrieval, soft-delete/supersede corrections (`src/faculties/memory/`). L0.1 episodic store has tables, watermarks, and lineage but the consolidation pipeline is scaffold-level. Memory evolution links are first-class in Postgres but absent from migration and not surfaced in retrieval. Session projection rebuild exists (`transcript-projection-repair.ts`); memory rebuild does not.

### Emotion / self-model
EmotionState with VAD half-life decay and EMA mood (`src/core/emotion/state.ts`), LLM appraisal chains, emotional-intensity importance multipliers in extraction, InternalState computer feeding affect/metacognitive prompt variables, metacognition flags (uncertainty, avoidance, confabulation risk). Message ontology classes (outwardSpeech, musing, systemNote, internalWhisper) exist with legacy whisper→musing normalization. Introspection landmarks (charter 6.25): no footprint.

### Autonomy
Capability tiers enforced at dispatch (`src/system/capabilities/gate.ts`), approval queue with operator notification (`src/boundary/gateway/approval-boundary.ts`), audit trails (gateway + safeguards JSONL + Postgres). Prompt tools with versioning/rollback and cooling-off. Shard manager with fold-review, provenance-tagged L0/L2 outputs, derived shard companion IDs (charter 6.13/6.14 substantially implemented). Bounded subagents with recursion blocking. Gap: no companion-initiated outbound message path; Discord/Telegram egress is tool-reactive.

### Identity / trust
5-layer prompt stack wired into turn assembly with static prefix freezing (`prompt-composer.ts`, `prompt-assembly.ts`). Model-agnostic identity with roster slots. Contacts with 4-tier trust and channel identity linking; trust filters applied in retrieval queries. Honne/tatemae persona adaptation flows into prompt variables. Cross-channel continuity port validates provenance/visibility on merge. Gap: values journal feedback loop unwired (see Critical Finding 2).

### Infrastructure
Thin entrypoints; gateway-only secrets; sandbox separation real; owner-file contract guard fail-closed; Garden covers memory, episodic, charge, scheduler, settings, models; 396 test files / 753 source files; e2e suites exist for runtime, voice, and Wyoming. Backup/restore verification is real for what it covers — which no longer includes the primary stores.

## Gap-Closure Direction

Tracked via beads (epics and stories created 2026-06-09; see `bd` for the live graph):

1. **P0 — Backup completeness:** Postgres dump integration, full companion file-tree coverage (journals, selfies/media, vault, card history), restore verification across both, evolution-links migration, memory journal replay CLI.
2. **P1 — Branch health:** fix the 46 failing tests.
3. **P1 — Proactive outreach:** minimal-change Discord DM egress (policy-gated, primary contact first), internal-state→outbox initiation, weighted-thought accumulation curve.
4. **P1 — Personality evolution:** wire the values layer provider with human-in-the-loop diff approval.
5. **P1 — Introspection & her time:** diagnose non-firing reflection jobs on the live deployment, self-directed creative/personal rest-window activity, companion-readable internal state.
6. **P1 — Episodic consolidation rework:** buffer candidates, consolidate thematically during sleep cycle, link arcs.
7. **P1/P2 — Fatigue system:** machine-intelligence contact flagging, charge-class extension for companion-to-companion conversation, relationship- and intent-weighted budgets, overcharge reserve, structured initial limits.
8. **P2 — Doc truth:** README persistence-stack corrections, CLAUDE.md source-tree refresh.

Out of scope for this pass (already beaded in the lost sprint-9 planning set, to be restored with the server): creative tool expansion (music/video generation, video understanding).
