---
type: concept
title: Scheduler
description: The companion's internal clock — a self-rescheduling task scheduler that owns the heartbeat, rest-window gating, reflection templates, post-turn lanes, free-time blocks, temporal wake-ups, scheduled prompts, and proactive outreach lanes.
tags: [scheduler, runtime, heartbeat, reflection, free-time, rest-window, post-turn, temporal-wakeup, outreach]
verified:
  - by: openwiki/0.4.3
    at: 2026-08-28T13:30:04.287Z
sources:
  - id: openwiki-source-1853064c57f110af0136871f
    resource: repo://src/app/agent/scheduler-runtime.ts
  - id: openwiki-source-c250f8b0795aab6872851d47
    resource: repo://src/core/scheduler/ambient-presence.ts
  - id: openwiki-source-08a12966e103d915a684d327
    resource: repo://src/core/scheduler/background-maintenance.ts
  - id: openwiki-source-b63e84cd2973ceb5a2d109f3
    resource: repo://src/core/scheduler/free-time-chooser.ts
  - id: openwiki-source-21f5324afa44e2a7b11463c1
    resource: repo://src/core/scheduler/free-time.ts
  - id: openwiki-source-60ca1de00779dfcca059ea6b
    resource: repo://src/core/scheduler/post-turn-outbound-gates.ts
  - id: openwiki-source-315ccb6565ee98c2f765ba75
    resource: repo://src/core/scheduler/post-turn-runtime.ts
  - id: openwiki-source-8ef4580bc707dd70ae0290b2
    resource: repo://src/core/scheduler/post-turn-runtime/scheduler-lanes.ts
  - id: openwiki-source-ee0cab4dde97a90d8258ead0
    resource: repo://src/core/scheduler/reflection-policy.ts
  - id: openwiki-source-124d1f87010c5de14cb97e93
    resource: repo://src/core/scheduler/reflection-runtime-contracts.ts
  - id: openwiki-source-948fe452970569525291da46
    resource: repo://src/core/scheduler/reflection-template-runtime.ts
  - id: openwiki-source-3817f7ab0684e8f99ca8676a
    resource: repo://src/core/scheduler/rest-window-policy.ts
  - id: openwiki-source-4ed99088010a73ef9be7a026
    resource: repo://src/core/scheduler/rest-window.test.ts
  - id: openwiki-source-cc125466be7b381e41fba726
    resource: repo://src/core/scheduler/rest-window.ts
  - id: openwiki-source-70d89b53dbf2c499b31b92c9
    resource: repo://src/core/scheduler/schedule-tool.ts
  - id: openwiki-source-c3eb47348038a67aace40893
    resource: repo://src/core/scheduler/scheduled-prompts.ts
  - id: openwiki-source-38413db1a705d31601b1284e
    resource: repo://src/core/scheduler/scheduler.ts
  - id: openwiki-source-35d573c2b59fbe857e6bbeec
    resource: repo://src/core/scheduler/social-desire-outreach-lane.ts
  - id: openwiki-source-7bf415ce9a68103eb0893c03
    resource: repo://src/core/scheduler/temporal-wakeup.ts
  - id: openwiki-source-3ca675b082cfda34f8e5d287
    resource: repo://src/core/scheduler/types.ts
  - id: openwiki-source-fd7d74d32f59f61a62961b33
    resource: repo://src/core/scheduler/wake-window-estimator.ts
  - id: openwiki-source-82d2c95e21c5479749ef7196
    resource: repo://src/core/scheduler/weighted-thought-outreach-lane.ts
  - id: openwiki-source-f5fdf89bb299ac044858cefd
    resource: repo://src/system/config/scheduler-config.ts
generated: { by: "openwiki/0.4.3", at: "2026-08-28T13:30:04.287Z" }
---

# Scheduler

The scheduler (`src/core/scheduler/`) is the companion's internal clock. A base tick
checks registered tasks for due status, and the **heartbeat** is registered as a special
`every` task — her self-check rhythm. Around that engine, the module owns the quiet-time
policy (rest window), the policy-driven multi-template reflection system, the post-turn
runtime and its scheduler-owned memory/cogsec lanes, free-time self-directed blocks,
temporal wake-up lanes, ambient presence notes, scheduled prompts, and the deterministic
outreach lanes (weighted-thought and social-desire). Every lane is fail-closed: nothing
here sends a message by itself — outward delivery always rides the existing
proactive-outbound dispatcher, provenance gates, and quiet-hours time gate.

## Core scheduler engine

`Scheduler` (`src/core/scheduler/scheduler.ts`, types in `types.ts`) keeps a map of
`ScheduledTask` entries (`every` or `one-shot`) with `idle | active | paused | complete`
state and runs them on a **self-rescheduling timer**, not a blind poll loop.

- **Adaptive wake.** Each tick computes the earliest next-due time across idle tasks
  (minimum of each task's next-due, an optional near-term hint, and the
  `tickIntervalMs` coarse ceiling), clamps the delay to `[MIN_WAKE_MS = 50, tickIntervalMs]`,
  and re-arms on completion. The floor guarantees an overdue task can never spin into a
  busy-loop; an in-flight tick suppresses re-arming so ticks never overlap
  (`armNextWake`, `computeNextWakeAt`, `taskNextDueAt`).
- **Wall-clock cadences.** `hourly`/`daily`/`weekly` cadences resolve slot boundaries in
  the active timezone (or UTC) via `Intl` (`getCurrentSlotStart`). A task is due when
  `now >= currentSlotStart && lastRun < currentSlotStart`, so DST transitions and
  timezone changes cannot shift a slot. A persisted `lastRunAt` seeds the anchor: a
  process that registers *after* the current slot recovers the missed slot exactly once,
  and replay never duplicates it. Relative cadence tasks fire `intervalMs` after the last
  run (or immediately when `lastRun === 0`).
- **Registration contract.** `register()` rejects duplicate ids, non-positive
  `intervalMs` for `every` tasks, cadence on `one-shot` tasks, invalid cadence fields
  (timezone must be `local` or `utc`; minute 0–59; hour 0–23; `dayOfWeek` 0–6), and the
  mutually exclusive `lastRunAt` + `skipFirstRun` combination.
- **Eligibility gating.** Before a handler runs, the optional `EligibilityGate`
  evaluates the task with kind `scheduler.task`. A denied task records
  `lastOutcome: 'denied'` + `lastDeniedReason`, emits `schedule.task.denied`, and a
  `one-shot` task is marked `complete` (it will never retry). Successful runs emit
  `schedule.task.run`; thrown handler errors are caught, recorded as `lastError`, and
  surfaced via `schedule.task.failed` without killing the tick.
- **Protected tasks.** Tasks registered with `availability` (`idle` or `do_not_disturb`)
  run through `runProtectedTask` when wired; production wires
  `companionAvailability.run`, so DND-marked quiet-time lanes only execute while the
  companion is available.
- **Lifecycle.** `updateConfig` re-arms on cadence changes; `requestWake` pulls an
  earlier wake forward for near-term one-shots; `stop()` clears the timer, sets
  `stopping`, and **drains** any in-flight tick before resolving (concurrent `stop()`
  calls share one drain promise); `tick()` is exposed for tests and serializes through
  `tickInFlight`.
- **Heartbeat.** `registerHeartbeat` registers the `heartbeat` task with
  `intervalMs = heartbeatIntervalMs` (default 30 min). In production the heartbeat emits
  `schedule.healthcheck` (with task count) and refreshes the companion's own presence
  row for multi-companion co-presence.

<!-- openwiki: mermaid parse failed and this diagram was converted to a text fence so it does not break rendering. Fix the diagram source and restore the mermaid fence. Parser error: Heuristic: a semicolon inside a label breaks rendering; rephrase the label. -->
```text
flowchart TD
    Start["start: arm self-rescheduling wake timer"] --> Tick["tick fires at earliest due time, clamped to tickIntervalMs ceiling"]
    Tick --> Emit["emit schedule.tick"]
    Emit --> Loop{"for each idle task"}
    Loop -->|"not due"| Loop
    Loop -->|"due (relative, wall-clock, or one-shot)"| Gate{"eligibility gate allows"}
    Gate -->|denied| Denied["record lastOutcome denied + reason, emit schedule.task.denied, one-shot completes"]
    Gate -->|allowed| Run["state active, run handler; protected-task wrapper when availability is set"]
    Run -->|success| Ok["record succeeded, emit schedule.task.run"]
    Run -->|error| Fail["record failed + lastError, emit schedule.task.failed"]
    Ok --> After{"task type"}
    Fail --> After
    Denied --> Loop
    After -->|one-shot| Done["state complete"]
    After -->|every| Idle2["state idle"]
    Done --> Rearm["re-arm next wake at earliest due time"]
    Idle2 --> Rearm
    Rearm --> Start
```

*The scheduler tick: due-task detection, eligibility gating, protected execution, and
the adaptive re-arm loop.*

## Rest window and silence policy

`evaluateRestWindowEligibility` (`rest-window.ts`) is the shared quiet-period gate for
episodic processing and the quiet-time lanes. A decision is `allowed` only when (a) the
window `[startLocalTime, endLocalTime)` in the configured timezone currently contains
`now`, and (b) last user activity is at least `inactivityThresholdMinutes` old. Denials
return a `reasonCode` (`outside_rest_window` or `insufficient_inactivity`) plus
`nextEligibleAtMs` — the next window opening computed by minute-stepping — so callers can
defer work without re-polling blindly. A disabled window always allows.

`RestWindowPolicyPort` / `InMemoryRestWindowPolicy` (`rest-window-policy.ts`) persist a
companion's *rest* decision for the quiet period, per lane, with wall-clock expiry and
extend-only semantics — a later rest in the same window never shortens the guard. This is
the "not again for this quiet period" mechanism behind the free-time chooser.

## Reflection policy and template runtime

**ReflectionPolicyStore** (`reflection-policy.ts`) stores the reflection schedule as a
JSON policy file (`resolveReflectionPolicyPath`): templates with id/name/prompt/
`intervalMs`/`cadence`/`enabled`/`internalStateInput`/`mode`/`deliberation`. `load()`
validates every template (slug id, prompt 10–2000 chars, interval 5 min–7 days, bounded
deliberation caps) and self-heals: obsolete default template ids (`musing`, `whisper`,
`emotional-check`, `goal-update`, `experiential-review`, `values-reflection`) redirect to
the consolidated daily/weekly defaults, the mixed-state template is seeded exactly once
(never resurrected after a deliberate delete), and default prompts refresh on a prompt
policy version bump. `save()` invalidates the cached fingerprint before the atomic write.
The current defaults are first-person, evidence-first daily/weekly/mixed-state
reflections in `deliberation` mode with bounded budgets; the mixed-state template ships
disabled by default so a blind cadence cannot manufacture a divergence.

**createReflectionTemplateRuntime** (`reflection-template-runtime.ts`) wires each enabled
template as an `every` scheduler task (id `reflection:<templateId>`, availability
`do_not_disturb`). `syncReflectionTasks()` unregisters stale `reflection:` tasks and
recovers each template's last-run anchor from the metacognition journal's
`reflection_run` entries, so a restart after a missed wall-clock slot fires the missed
slot exactly once (`lastRunAt`) or falls back to `skipFirstRun`. Execution guards:

- **Rapid-fire loop guard**: non-manual runs are limited to 4 executions per 60 s window;
  exceeding it throws `ReflectionTemplateLoopGuardError` and suppresses the template for a
  10-minute cooldown. Manual `run_template` always bypasses.
- **Busy deferral**: a scheduled run that hits a busy-turn error is queued as a
  `one-shot` deferred task (250 ms out, `waitForIdle` before execution) or, when the
  post-turn runtime is wired, as a `DEFERRED_REFLECTION_ACTION_KIND` post-turn action
  (`heartbeat.run_template` — a deliberately legacy spelling for durable queue rows).
- **Novelty gate**: only cadence-fired runs pass the reflection novelty watermark gate;
  explicit manual runs are their own justification and bypass it.

Each template runs on the internal `internal:reflection:<templateId>` channel in one of
two modes:

- **Agent mode** — one `agentLoop.handleMessage` turn through the ordinary pipeline with a
  bounded read-only introspection policy (companion-self memory scope, no overlay tools).
- **Deliberation mode** — a read-only tool-grounding turn first, then `runDeliberation`
  with the template's `deliberation` caps (rounds, total tokens, wall time, voices,
  USD-per-token). Recoverable evidence-grounding exhaustion degrades the run with
  metacognitive flags instead of failing it.

Outputs persist durably: reflection journal, daily journal, metacognition journal
(`reflection_run` rows that double as cadence anchors), discrepancy journal (verbatim,
unresolved cross-family divergences), values journal (weekly templates), optional memory
write and vault publish. A group `ConversationScope` makes the reflection reflect on a
room instead of a single canonical contact.

## Post-turn runtime and scheduler-owned lanes

`wirePostTurnRuntime` (`post-turn-runtime.ts`) registers the post-turn action inferer on
the agent loop. After each turn it infers deferred reflection actions, near-turn memory
actions, and episode-synthesis threshold actions, and fires the **intention post-turn
appraisal**: an `IntentionAppraisal` over the turn's internal-state snapshot, recent
messages, active/recently-resolved concerns, contact emotional snapshot, and a motivation
bridge assessment. Decisions normalize into `PostTurnActionCandidates` for concern,
follow-up, reminder, and outbound-message kinds, each carrying provenance scope and
quiet-hours minimum run times. Registered handlers:

- **Deferred reflection** (`DEFERRED_REFLECTION_ACTION_KIND`) → `templateRuntime.runDeferredTemplate`.
- **Intention follow-up** → activation budget (min 5 min between activations per
  channel), optional pending-follow-up store activation, then `agentLoop.followUp`.
- **Outbound message** → the heart of proactive delivery: normalize payload, hash
  content, check live provenance (`missing_live_provenance`, stale concerns/follow-ups,
  social-desire consent validity and rate budget), route through the ICP intention
  candidate adapter when wired (delivered/suppressed/declined dispositions reconcile the
  linked pending follow-up), otherwise dispatch through `proactiveOutbound` with the
  quiet-hours time gate (per-recipient timezone when resolvable). Every phase is
  recorded in the durable outreach outbox (`queued/scheduled/dispatching/sent/blocked/
  failed`), and social-desire terminal dispositions are settled and persisted so a retry
  can never double-send. Telemetry-only events; nothing here creates conversational
  speech by itself.
- **Intention reminder** → reminder substrate trigger, with a re-inferred next-due
  action for recurring reminders.

**createSchedulerOwnedPostTurnLanes** / **registerSchedulerOwnedPostTurnLanes**
(`post-turn-runtime/scheduler-lanes.ts`) construct the scheduler-owned lanes: the
`sleeptime` memory agent (heavy sleep consolidation, arc weaving, dream pass — reachable
*only* from the rest-window scheduler task, never the turn inferer), the near-turn
memory lane (zero-LLM cadence), the episode-synthesis lane, the contact trust-drift
review, the cogsec drift-velocity review (Garden cards, never delivered to the
companion), and the second-arrow rumination review. Sleeptime and the review lanes are
registered as background-maintenance **rest-window checks** that emit
`agent.post_turn.actions.inferred` only when their heavy pass becomes eligible, and their
execution handlers register under `MAINTENANCE_REFLECTION_RUNTIME_CLASS` with
`executionMode: 'background'`.

## Ambient presence

`registerAmbientPresenceOperation` (`ambient-presence.ts`) registers a
background-maintenance operation. After a min idle gap (default 3 h), it checks the
latest private session and, when eligible (session exists, non-internal, non-public,
idle threshold met, rest window and inactivity OK, min note interval of 6 h since the
last ambient note), appends a **system note** (source `ambient_presence`) recording that
quiet-time eligibility was reached. It never sends an outbound message and makes **zero
LLM calls**; the anti-loop interval is enforced against both in-memory and persisted
notes. Public/broadcast channels are excluded at the privacy boundary.

## Free-time lanes

`registerFreeTimeTasks` (`free-time.ts`) registers two trigger lanes that share **one**
bounded block runner on an internal `internal:free-time:` channel (single source of
truth for the partition prefix is `FREE_TIME_CHANNEL_PREFIX`):

1. **Quiet-hours lane** (`free-time:quiet-hours`) — polls inside the episodicProcessing
   rest window, reusing ambient-presence eligibility *with* the rest window.
2. **Idle lane** (`free-time:idle`) — polls after a long partner-inactivity gap, reusing
   ambient-presence eligibility *without* the rest window.

Before any spend, a **deterministic gate** (`evaluateFreeTimeGate`) runs with zero LLM
cost: it blocks during recent partner activity, enforces a minimum block interval, and
caps blocks per day. A closed gate emits a typed `scheduler.free_time.gate` skip event so
Garden shows exactly why a block did or did not run. Both lanes share one cadence state,
so the interval and daily cap bound *total* free-time spend, not per-lane spend.

When the gate opens and a partner session exists, the runtime either consults the
**free-time chooser** (one cheap background call: rest / private wander / resume /
create; failures fail closed to rest, and a rest records silence via
`RestWindowPolicyPort`) or falls back to the legacy LRU project-context auto-select. The
block then runs through the ordinary agent loop on the internal channel — full persona,
her normal tools, existing capability/trust policy (the opposite posture to restricted
reflection) — under a hard per-block budget: `maxTurns` **and** a background charge-lane
unit cap checked before every turn. A stop signal (`silent` token or empty reply) on the
first turn is a valid zero-output "loaf"; budget exhaustion ends the block gracefully
with a visible reason. A block ended by companion silence closes the gate for the rest
of the day (`silencedForDayKey`), so a silent exit is never re-prompted up to the cap.

After an **active** block, `surfaceReturnNote` routes a "while you were away" context
note by the resolved workspace return policy (never the trigger lane): the disclosure
destination and the append target derive from the same policy, a destination-eligible
projection filters the block's transcript evidence before the shared summarizer runs
(so a note bound for one contact's DM can never be summarized from another contact's
material), and an unresolvable target or a collapsed projection fails closed to a
content-free private/self note. Publication workspaces get a state-only note on their
own internal continuity session. Notes are always attributed system notes (never
participant speech) and non-initiating — they surface only when a human next replies.

```mermaid
sequenceDiagram
    participant S as Scheduler
    participant Lane as Free-time lane handler
    participant Gate as Deterministic gate
    participant Chooser as Free-time chooser
    participant Loop as Agent loop
    participant SM as Session manager

    S->>Lane: tick fires lane task (quiet-hours or idle)
    Lane->>Gate: evaluate lane eligibility plus cadence inputs
    Gate-->>Lane: open or skipped, emits scheduler.free_time.gate
    alt gate open
        Lane->>Chooser: one background call to choose workspace or rest
        alt rest chosen or suppressed
            Chooser-->>Lane: rest (records silence) or rest_suppressed
        else workspace chosen
            Chooser-->>Lane: workspace continuity session
            Lane->>Loop: run bounded free-time block on internal channel
            Loop-->>Lane: turns until stop signal or turn or charge budget exhausted
            Lane->>SM: append block provenance note
            Lane->>SM: route return note by workspace return policy
        end
    end
```

*Free-time block flow: deterministic pre-spend gate, companion chooser, bounded
internal-channel block, and policy-routed return note.*

## Temporal wake-up lanes

`registerTemporalWakeupTasks` (`temporal-wakeup.ts`) moves the companion's temporal
frame forward on two complementary paths:

- **Morning wake** — a daily wall-clock task (`temporal-wakeup:morning`). The effective
  slot is fixed `localTime` or a **habit-derived estimate**: `estimateWakeWindow`
  (`wake-window-estimator.ts`) finds, per local day, the largest inter-message gap whose
  end lands in a morning wake band (default 03:00–12:00), aggregates weighted quantiles
  (recent window weighted heavier), and fires at the weighted median. Insufficient
  history falls back to the fixed time with a visible reason (`habit_fallback`). The
  snapshot builder is the single source of truth shared by registration and the Garden
  admin read route. Per-channel eligibility rejects internal/public sessions, enforces
  min partner idle, a once-per-local-day anti-loop guard, and "no activation since the
  last wake note". The durable note is persisted **only after an actual wake model turn
  completes** (at most one, only for warm channels within `fullTurnMaxIdleHours`);
  outward content rides the existing proactive-outbound dispatcher and quiet-hours gate.
  Fan-out enumerates recently-active live channels (group/DM/satellite), each gated by
  its own eligibility and anti-loop state; the single outward target is the most
  recently active channel, so idle scheduler ticks never fan rows out.
- **Idle refresher + active-turn frame** — after a configured idle gap, the session
  context derives one fresh ephemeral temporal frame when the channel next invokes the
  model (`configureActiveTemporalFrame`); idle frames are prompt-only context, never
  session rows. The `temporal-wakeup:idle-refresher` lane can also append a time-of-day
  refresh or new-day note when eligible (own anti-loop interval, lane-specific note
  history so a refresher never suppresses the morning summary).

Wake notes are runtime context, attributed as such, and wake/refresher notes never reset
ambient-presence or elapsed-time idle accounting (system-role entries are excluded from
user/assistant activity).

## Background maintenance

`BackgroundMaintenanceRegistry` (`background-maintenance.ts`) owns the single
`background-maintenance` `every` task that runs registered housekeeping operations
sequentially on one shared cadence. Each operation keeps its **own** eligibility gate
and failure boundary: a narrow capability or a broken lane can never prevent unrelated
maintenance, and per-operation failures aggregate into an `AggregateError` surfaced by
the scheduler task. Production registers salience decay, ambient presence, concern
grooming, the social-graph builder, and the fleet-leader shared-world wiki caretaker
through this registry.

## Outreach lanes

Two scheduler lanes ride the same engine and share the delivery path: accepted output
becomes an `INTENTION_OUTBOUND_MESSAGE` post-turn action through the same
`agent.post_turn.actions.inferred` path, so the durable outbox, provenance gate, ICP
candidate broker, and dispatcher policy gates deliver it unchanged. Neither lane sends
anything itself.

- **Weighted-thought outreach** (`weighted-thought-outreach-lane.ts`) — every-interval
  task running the deterministic weighted-thought evaluation; only a threshold-crossing
  thought fires the LLM nudge. Disabled unless
  `scheduler.json weightedThoughtOutreach.enabled` (fail-closed). Emits
  `intention.nudge.gate/produced/accepted/declined/blocked` telemetry.
- **Social-desire consent moment** (`social-desire-outreach-lane.ts`) — every-interval
  task running the deterministic desire evaluation (tier, threshold, cooling-off, quiet
  hours, rate budget, channel policy); only a genuinely eligible, deliverable desire
  fires the consent-moment LLM call. An accepted consent is bound to exactly one
  normalized outbound action (fingerprint checked) and enqueued through the post-turn
  queue; binding/enqueue failures revoke the single-use consent. The durable outbox and
  provenance gate handle delivery and terminal settlement.

## Scheduled prompts and the schedule tool

`scheduled-prompts.ts` turns durable `ScheduledPromptRecord` rows into `one-shot`
scheduler tasks. `rehydrateScheduledPromptTasks` reloads pending records at startup;
past-due rehydrated prompts fire on the next tick with a late-delivery note prepended.
Busy-turn errors retry after `waitForIdle`, and `markCompleted` must succeed or the task
throws (fail-closed so a fired prompt is never left pending).

`createScheduleTool` (`schedule-tool.ts`) exposes the companion-facing `schedule` tool
with actions `list`, `create_follow_up`, `activate_follow_up`, `create_reminder`,
`trigger_reminder`, `list_templates`, `update_template`, `run_template`, and
`schedule_prompt`. Long-horizon follow-ups beyond the active intention horizon route to
scheduled prompts; template edits are validated by `ReflectionPolicyStore` and trigger
`syncReflectionTasks` so the scheduler re-registers the cadence.

## Configuration and composition

`scheduler.json` is validated by `validateSchedulerConfig` (`src/system/config/
scheduler-config.ts`) into `SchedulerRuntimeConfig` with per-section validators
(`episodicProcessing` rest window, `nearTurnMemory`, `episodeSynthesis`,
`sleepConsolidation`, `orientationRewrite`, `reflectionNovelty`, `arcFormation`,
`temporalWakeup`, `freeTime`, `socialAutonomy`, `weightedThoughtOutreach`, `socialDesire`,
`intentionFollowUp`, `icpAutonomy`, `backgroundMaintenance`, `backgroundWork`, …).
It rejects removed keys (`sleeptime`, `salienceDecayIntervalMs`) with migration hints and
validates that `backgroundMaintenance.intervalMs + tickIntervalMs` is strictly shorter
than the daily rest window, so a relative cadence can never phase-lock outside every
window.

Composition (`src/app/agent/scheduler-runtime.ts` → `buildAgentSchedulerRuntime`)
constructs the `Scheduler` with the event bus, config, eligibility gate, and
`companionAvailability.run` as `runProtectedTask`, then registers the heartbeat
(`schedule.healthcheck` + presence refresh), background maintenance, ambient presence,
salience decay, backups, and the social-graph builder. Startup lane modules register the
free-time, temporal-wakeup, weighted-thought, and social-desire tasks with the same
scheduler instance.

## Invariants and failure semantics

- **Fail closed on privacy.** Ambient presence, free-time, morning wake, and idle
  refresher eligibility all reject internal sessions (`isInternalSessionId`) and
  public/broadcast channels (`classifyChannelDisclosure` → `public`); wake-note fan-out
  additionally requires a live conversational channel type (`supportsLiveWakeup`).
  Free-time blocks run on internal channels, so any outward dispatch would be blocked by
  the proactive-outbound gates.
- **Fail closed on provenance.** Outbound actions without live provenance
  (`missing_live_provenance`, stale concern/project, invalid or budget-exhausted
  social-desire consent) are blocked; social-desire terminal blocks are spent and
  dampened, never released, so a desire keeps pressure and can retry only via a later
  consent moment.
- **Durable-before-delivered.** The outreach outbox records every phase and dedupes
  replays; a delivery outcome that is ambiguous after a crash settles as a terminal
  block rather than a double send. Morning wake notes persist only as proof of an actual
  model delivery.
- **Zero-LLM quiet paths.** Ambient presence notes, free-time gate checks, the
  wake-window estimator, and near-turn memory are deterministic and cost nothing when
  gated closed; free time and outreach burn spend only after their deterministic gates
  open.
- **Graceful degradation.** Missing optional ports (e.g. no session enumeration, no
  summarizer, no charge policy) degrade to documented fallbacks — single latest session,
  content-free notes, turn-cap-only budgets — never to widened access.

## Focused tests

- `scheduler.test.ts` — registration contract (duplicate ids, interval validation),
  tick due semantics, wall-clock cadence and timezone behavior (`scheduler-local-timezone.test.ts`).
- `rest-window.test.ts` / `rest-window-policy.test.ts` — midnight-crossing windows,
  inactivity thresholds, `nextEligibleAtMs`, per-lane silence persistence.
- `reflection-policy.test.ts` — validation, default consolidation and redirects,
  prompt refresh on version bump.
- `reflection-template-runtime.test.ts` / `-resilience.test.ts` / `-daily-evidence.test.ts`
  — deliberation execution, degraded evidence grounding flags, loop-guard suppression,
  persisted last-run recovery.
- `post-turn-lanes.test.ts` / `post-turn-appraisal-captured-reads.test.ts` /
  `reflection-social-desire-outbound.test.ts` — lane wiring, appraisal reads through
  captured-owner scope, outbound provenance settlement.
- `free-time.test.ts` / `free-time-chooser.test.ts` / `return-note-routing.test.ts` —
  gate ordering, block budgets, chooser rest/suppress outcomes, return-note routing and
  fail-closed destinations.
- `temporal-wakeup.test.ts` / `wake-window-estimator.test.ts` / `wake-window-snapshot.test.ts` —
  eligibility denials, anti-loop guards, habit estimation and fallback, fan-out gating.
- `weighted-thought-outreach-lane.test.ts` / `social-desire-outreach-lane.test.ts` /
  `scheduled-prompts.test.ts` / `schedule-tool.test.ts` — lane registration and tick
  telemetry, consent binding, prompt rehydration and late delivery.
