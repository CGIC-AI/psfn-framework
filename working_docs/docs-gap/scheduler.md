# Scheduler — Companion Internal Clock

> **Working draft** in `working_docs/docs-gap/scheduler.md` — promote to `docs/scheduler.md` after review.
> **System:** `scheduler` (`system:scheduler`) · **Code:** `src/core/scheduler/` (25.6k loc) + `src/system/config/scheduler-config.ts` + `src/app/startup/composition/`
> **Review checklist:** `working_docs/docs-gap/TRACKER.md` #1 · **Status:** draft from code @ 2026-08-06

## Orientation

The scheduler is the companion's internal clock. It lives in the **agent process** (`src/app/agent/main.ts`) and owns every timer that is not a direct model call: heartbeat, ambient presence, free-time blocks, post-turn reflection/appraisal lanes, rest-window silence, and background maintenance. The gateway owns wall-clock secrets and provider network; the scheduler never touches them — it only emits `EventBus` events and enqueues work through the agent loop under the same capability/trust gates that govern chat.

**Who is this for:** contributors wiring a new autonomous lane, operators tuning quiet hours, and reviewers auditing fail-closed autonomy.

**Where it fits:** `architecture.md` (Agent Responsibilities) → `chat-turn-lifecycle.md` (post-turn) → here (timers) → `src/core/icp/` (what reflection decides) + `src/core/emotion/` (what appraisal decides).

```
Gateway (secrets, network) ──► Agent ──► Scheduler (tick)
                                       ├─▶ Heartbeat (every)
                                       ├─▶ Ambient presence (idle + rest window)
                                       ├─▶ Free-time blocks (quiet-hours / idle lanes)
                                       ├─▶ Post-turn runtime (reflection + appraisal lanes)
                                       ├─▶ Scheduled prompts (postgres durable)
                                       └─▶ Background maintenance (nightly drift/episode)
```

## Mental model

```
Scheduler.tick() ─┬─ due tasks? ─► EligibilityGate ─► task handler
                  │
                  ├─ DeterministicGate (zero LLM) ─► skip event on fail
                  │
                  └─ Charge lane guard ─► budget cap, graceful end
```

Two primitives repeat everywhere:

* **DeterministicGate** (`src/shared/gating/deterministic-gate.ts`) — pure, zero-token pre-check: minimum interval between blocks, cooldown since last partner activity, blocks-per-day cap. On `false` it emits a typed skip event (`scheduler.free_time.gate`) that Garden's subsystem-health view renders, so a skipped block burns **no tokens**.
* **EligibilityGate** (`src/system/capabilities/eligibility.ts`) — policy check (capability, trust tier, settings) before any spend.

If either gate closes, nothing runs and nothing is billed — this satisfies Charter 8.8 (rest) and 8.9 (charge stewardship).

## Entry points

| Entry | Location | Purpose |
|-------|----------|---------|
| `Scheduler` | `src/core/scheduler/scheduler.ts:235` | Base tick, task registry, cadence validation, adaptive `nextWakeMs` (min 50ms anti-spin, :71) |
| `wirePostTurnRuntime()` | `src/core/scheduler/post-turn-runtime.ts:69` | Wires reflection + appraisal lanes into the scheduler as scheduler-owned lanes (`post-turn-runtime/scheduler-lanes.ts`) |
| `evaluateAmbientPresenceEligibility()` | `src/core/scheduler/ambient-presence.ts:18` | Decides if an ambient note may fire (idle threshold, rest window, privacy boundary, anti-loop) |
| `freeTimeWorkspaceChannelId()` | `src/core/scheduler/free-time.ts:116` | Maps a free-time block to `internal:free-time:<segment>` — converges both lanes onto one continuity transcript when workspace unresolvable |
| `evaluateDeterministicGate()` | `src/shared/gating/deterministic-gate.ts` (used by `free-time.ts:47`) | Pure pre-spend gate |
| `ReflectionTemplateRuntime.runDeferredTemplate()` | `src/core/scheduler/reflection-template-runtime.ts:1461` | Executes a deferred reflection template as a normal agent-loop turn |
| `InMemoryRestWindowPolicy` | `src/core/scheduler/rest-window-policy.ts:41` | Per-lane silence persistence ("not again for this quiet period") |
| `BackgroundMaintenanceRegistry` | `src/core/scheduler/background-maintenance.ts` | Single shared-cadence task running registered housekeeping ops sequentially; per-op eligibility + failure boundary; cadence from `scheduler.json > backgroundMaintenance.intervalMs` |

## Key types

| Type | Location | Purpose |
|------|----------|---------|
| `SchedulerConfig` / `ScheduledTask` / `RecurringCadence` | `src/core/scheduler/types.ts` | Task shape: `hourly/daily/weekly/relative` cadence, timezone `local|utc`, DST-aware via `Intl` (`scheduler.ts:94`) |
| `FreeTimeConfig` + `EpisodicProcessingRestWindowConfig` | `src/system/config/scheduler-config.ts` | Quiet-hours window, idle thresholds, per-block budget (`maxTurns` + charge-lane cap) — all JSON-owned |
| `SocialAutonomyConfig` | `src/system/config/scheduler-config.ts:50` | Participation tunables (passive-name, appraiser, reservation/egress-lease, free-time chooser) — Garden-editable |
| `IcpAutonomySchedulerConfig` | `src/system/config/icp-autonomy-scheduler-config.ts` | ICP autonomy cadence, enabled flag (code-pinned OFF until `qgqw.3`) |
| `FreeTimeLane = 'quiet-hours' | 'idle'` | `src/core/scheduler/free-time-lane.ts` | Lane identity; silence is scoped per lane (`rest-window-policy.ts:41`) |
| `AmbientPresenceDecision` | `src/core/scheduler/ambient-presence.ts:22` | `{allowed, reason, idleGapMs, timeTexture, nextEligibleAtMs?}` — `eligible | below_idle_threshold | outside_rest_window | privacy_boundary | internal_session | anti_loop_recent_note` |
| `RestWindowPolicyPort` | `src/core/scheduler/rest-window-policy.ts:26` | `isSilenced()` / `recordSilence()` — in-memory default, injectable for durable adapter |
| `ReflectionRuntimeOptions` | `src/core/scheduler/reflection-runtime-contracts.ts` | Owning class for reflection vs maintenance lanes (`MAINTENANCE_REFLECTION_RUNTIME_CLASS`, `POST_TURN_APPRAISAL_RUNTIME_CLASS`) |

## Data flow

### 1. Tick → due check → gate → handler

1. `Scheduler` computes next wake from wall-clock cadences (hour/day/week are DST-aware via `zoneWallClockParts()`, `scheduler.ts:94`).
2. For each due task, run `EligibilityGate` then `DeterministicGate`. On skip, emit `scheduler.<lane>.gate` with `{reason, inputs}` for observability.
3. On pass, invoke the lane handler **as an ordinary agent-loop turn** under existing tool/capability policy (no new privilege — Law 14/15, `free-time.ts:14`).

### 2. Ambient presence

```
latest session (reuse_latest_session) ─► recentEntries ─► evaluateAmbientPresenceEligibility()
   ├─ isInternalSessionId? → no_conversational_activity
   ├─ classifyChannelDisclosure privacy_boundary? → privacy_boundary
   ├─ idleGapMs < minIdleMs (default 3h, ambient-presence.ts:19) → below_idle_threshold
   ├─ outside EpisodicProcessingRestWindow? → outside_rest_window
   ├─ anti-loop: last ambient note too recent (default 6h) → anti_loop_recent_note
   └─ else → eligible → backgroundMaintenanceRegistrar enqueues AmbientPresence note
```

Detected **without duplication** by both free-time lanes — both call the same `evaluateAmbientPresenceEligibility()` (`free-time.ts:11`).

### 3. Free-time blocks (E8.1)

Two lanes share **one block runner** (`free-time.ts:5`):

* **Quiet-hours lane** (`free-time:quiet-hours`) — polls *inside* the episodic rest window (bible §10.4).
* **Idle lane** (`free-time:idle`) — polls after long partner inactivity *without* the rest window.

Flow: `deterministic gate → ambient eligibility → FreeTimeChooser (LLM? no, chooser is local) → workspace resolver → block runner (multi-turn agent loop, budget-capped) → transcript in `internal:free-time:<segment>` (never dispatches outward, `free-time.ts:33`) → if activity, `appendContextSystemNote` plants "while you were away" on partner session; empty block is valid ("loafed").

Charge: per-block `maxTurns` + background charge-lane unit cap ends the block gracefully with `reason` (`free-time.ts:24`).

### 4. Post-turn lanes

`wirePostTurnRuntime()` registers scheduler-owned lanes that fire **after each turn** without blocking the reply (`post-turn-runtime.ts:58`):

* Reflection lanes: `reflection-policy.ts` / `reflection-template-runtime.ts` produce deferred `DEFERRED_REFLECTION_ACTION_KIND` work, gated by `reflection-introspection-policy.ts` and `post-turn-outbound-gates.ts`.
* Appraisal lanes: `IntentionAppraisal` → `MotivationBridge` → `decisionsToPostTurnActionCandidates()` → `proactive-time-gate` → `outreach-outbox` (all fail-closed on internal channels).

Operation IDs (`post-turn-runtime.ts:53`): `contact-trust-drift-review`, `drift-velocity-review`, `sleeptime-rest-window`.

### 5. Scheduled prompts (durable)

`ScheduledPromptStore` (`src/core/scheduler/scheduled-prompt-store-port.ts` + `src/persistence/postgres/scheduled-prompt-store.ts`) persists prompts in `scheduler_scheduled_prompts` with CHECK-constrained cadence; rehydrated at startup so agent restarts never lose a prompt. Completion recorded only after successful delivery (cf. `development-status.md`).

### 6. Background maintenance

`BackgroundMaintenanceRegistry` owns **one** scheduler task (`background-maintenance`) that runs registered housekeeping operations **sequentially on a shared cadence** (`scheduler.json > backgroundMaintenance.intervalMs`). Each operation carries its own `EligibilityRequirements` and failure boundary, so one narrow capability or a broken lane cannot block unrelated maintenance.

* Registration: `BackgroundMaintenanceRegistrar.registerOperation({ id, name, description, eligibility, handler })`.
* Ambient presence enqueues its notes through this registrar — never a bespoke timer — so the tick, charge/eligibility gates, and telemetry apply uniformly.
* Cadence is JSON-owned (`backgroundMaintenance.intervalMs`), not env. Don't register ad-hoc `setTimeout` housekeeping; route it through the registrar or it bypasses charge accounting.

## External dependencies

| Dependency | Purpose | Critical |
|------------|---------|----------|
| PostgreSQL + `pgvector` | `scheduler_scheduled_prompts`, episode/arc tables (via `EpistemicStore`) | Yes — runtime fails closed without `POSTGRES_DATABASE_URL` |
| `EventBus` | Skip/block telemetry (`scheduler.free_time.gate/block`) to Garden subsystem-health | Yes |
| `SessionManager` | `resolveStartupSessionMetadata`, `getRecentMessages`, `appendSystemNote` | Yes |
| `GatewayClient` (agent-side) | LLM/embedding for reflection templates (no secrets in agent) | For reflection lanes only |
| `Intl.DateTimeFormat` | DST-aware wall-clock cadence | Yes (no external TZ lib) |

## Configuration (owner-file authority)

| Source | Priority | Example |
|--------|----------|---------|
| `scheduler.json` (companion `WORKSPACE_PATH` neighbor) | Canonical | `FreeTimeConfig.minIntervalMs`, `FreeTimeConfig.maxBlocksPerDay`, `EpisodicProcessingRestWindowConfig.start/end` — see `src/system/config/scheduler-config.ts:170+` |
| `social-autonomy` block inside `scheduler.json` | — | `participation-config.ts` tunables; `egressLease.enabled` is code-pinned OFF until `qgqw.3` (intentional) |
| `SYSTEM_DATA_DIR` / `COMPANION_DATA_DIR` split roots | Wiring only | Not settings — see `src/system/config/startup-owner-files.ts` |
| Env (`POSTGRES_DATABASE_URL`, `WORKSPACE_PATH`) | Bootstrap only | `.env` never holds scheduler thresholds |

Validate with `npm run verify:settings-contract`.

## Test infrastructure

| Type | Location | Coverage |
|------|----------|----------|
| Unit (gate/elapse/chooser) | `free-time.test.ts`, `free-time-chooser.test.ts`, `reflection-policy.test.ts`, `rest-window-policy.test.ts` | Deterministic gates, chooser failures closed to rest, silence extends-not-shortens |
| Lane wiring | `post-turn-lanes.test.ts`, `scheduler.test.ts`, `temporal-wakeup.test.ts` | Lanes rehydrate, adaptive wake ≥50ms, wall-clock cadence across DST |
| Integration | `e2e/` + `shakedown.md` | Human-visible free-time note appears only after activity; empty block surfaces nothing |

## Pitfalls & gotchas

* **Don't add a new timer outside the Scheduler.** Use `BackgroundMaintenanceRegistrar` or a new `ScheduledTask` — ad-hoc `setTimeout` bypasses charge/eligibility gates and charge accounting.
* **Never dispatch outward from `internal:free-time:*`.** Outbound is	fail-closed on internal channels; any partner-visible message must ride the existing `post-turn-outbound-gates` and `proactive-time-gate`.
* **Silence is per-lane.** A quiet-hours silence does not suppress an idle block and vice versa (`InMemoryRestWindowPolicy`, `:41`). Recording only extends silence — a second rest in the same window never shortens it.
* **Egress lease is OFF.** `SocialAutonomyConfig.egressLease.enabled` is not exposed; only tunables are. Don't wire autonomous sending until `qgqw.3` lands.
* **Deterministic gate is pure.** Adding LLM or I/O inside it would bill tokens on every poll — keep it zero-cost.

## Cross-links

* `docs/architecture.md#Agent-Responsibilities` (agent owns scheduler)
* `docs/chat-turn-lifecycle.md` (post-turn lanes in turn anatomy)
* `docs/memory.md` (episodic rest window + sleeptime consolidation)
* `docs/garden-control-plane.md` (Garden health view of `scheduler.*.gate` events)
* `src/core/icp/` (what reflection hands off) · `src/core/emotion/` (what appraisal decides)

## Promotion notes

Create `docs/scheduler.md` from this file after code-owner review (no file exists there today — this is a new doc, not a replacement); add `_meta` sidebar entry and link from `architecture.md` composition section. Run `npm run verify:settings-contract` after any threshold rename.
