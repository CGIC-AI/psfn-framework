# Observer-Eval Sidecar

The observer-eval sidecar is a disabled-by-default, eval-owned, strictly
**non-authoritative** telemetry surface. On each real turn it takes a
privacy-sanitized copy of the companion's live PSFN `EmotionState`, projects it
into an `emo_sim` appraisal stimulus, runs it against a long-lived `emo_sim`
server, crosswalks the two emotion representations, computes divergence metrics,
and writes the result to eval-owned Postgres tables that only the Garden admin
surface reads. Nothing it produces feeds back into the live companion loop.

This page is the map: what it is, the `authoritative: false` boundary, the
config knobs, the export API, where to find it in Garden, and the experiment
design. The operational runbook (build pin, read cadence, calibration suites,
physiological-drive exclusion) lives in
[`operations.md` → emo-sim Observer-Eval Sidecar](./operations.md#emo-sim-observer-eval-sidecar).

Code root: `src/core/eval/observer-sidecar/`.

## What it is (pipeline)

Per-turn dispatch is `dispatchObserverEvalTurn(...)` (`runtime.ts`), a `WeakMap`
queue (`queue.ts`) draining into `EmoSimObserverEvalSidecar.observeTurn(input)`
(`config.ts`). It is wired into the turn lifecycle at
`src/core/agent/substrate-agent/turn-execution/pre-turn-state.ts` immediately
after `observeEmotionState(...)` (seam `substrate-agent.pre-turn.emotion-observed`),
composed in `src/app/agent/core-runtime.ts` via
`createObserverEvalSidecarRuntimeFromConfig`.

The worker drives these stages in order:

1. **Privacy gate** — `privacy.ts`: `classifyObserverEvalPrivacy` /
   `sanitizeObserverEvalInput`. Fail-closed: missing or ambiguous
   sensitivity/channel-privacy yields `privacyClass: 'fail_closed'` and
   `derivedTelemetryPermitted: false`.
2. **Projection** — `projection.ts`: `projectObserverEvalToEmoSim`. Produces the
   emo_sim adapter input and the mood-free projected appraisal
   (`OBSERVER_APPRAISAL_PROJECTION_VERSION = 'psfn.observer-sidecar.appraisal-projection.v3'`,
   schema 2).
3. **emo_sim adapter** — `emosim-adapter.ts`: `runEmoSimProjectedStimulus`,
   backed by `createEmoSimServerRunner` (`emosim-server-adapter.ts`). Talks to
   the `emo_sim` server HTTP API
   (`EMOSIM_INTEGRATION_SURFACE = 'emo_sim/server.py#http-api.v1'`).
4. **Crosswalk** — `crosswalk.ts`: `createObserverEmotionCrosswalk` maps PSFN
   discrete labels and the emo_sim vector into 13 emotion families and emits
   VAD/dominance/label/intensity divergences.
5. **Metrics** — `metrics.ts`: `createObserverEvalComparisonMetrics` (write) and
   `createObserverEvalComparisonSummary` (read), agreement bands `aligned |
   watch | divergent | unavailable`. The single legacy divergence score is
   superseded by the three calibration suites (`calibration/`).
6. **Persistence** — `persistence.ts`:
   `createPostgresObserverEvalSidecarStore(postgresDatabaseUrl)`.

After an observation is persisted, an independent post-stage evaluates the
**shadow levers** (`levers.ts` `ObserverLeverTracker`,
`ObserverEvalLeverStage`); a lever failure is logged, never propagated.

## The `authoritative: false` boundary

This is the load-bearing safety property: the sidecar's emo_sim state,
crosswalk, metrics, and lever events are **eval telemetry only** — never
companion memory, production `EmotionState`/`InternalState`, prompt state,
contacts, or concerns, and no live loop may consume them.

It is enforced at three layers:

- **Database.** Every sidecar table (see below) carries
  `authoritative BOOLEAN NOT NULL DEFAULT FALSE` with `CHECK (authoritative =
  FALSE)` and `eval_owner TEXT NOT NULL DEFAULT 'observer_sidecar_eval'` with
  `CHECK (eval_owner = 'observer_sidecar_eval')` (`src/persistence/postgres/migrations.ts`,
  array `POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS`). The database physically
  refuses an authoritative row.
- **Contracts.** Every record type
  (`ObserverEvalSidecarRunRecord`/`...ObservationRecord`/`...LeverEventRecord`,
  `persistence.ts`) carries the literal type `authoritative: false` plus
  `nonAuthoritativeNotice` (`OBSERVER_EVAL_SIDECAR_NON_AUTHORITATIVE_NOTICE`).
- **Admin views.** Every Garden view and the health payload re-assert
  `authoritative: false`
  (`src/operator/garden/services/observer-eval-sidecar-service.ts`).

A static boundary test forbids the live loop (`core/agent`, `core/scheduler`,
`core/tools`) from importing the sidecar or consuming its events.

## Config knobs (disabled by default)

Owned by `settings.json` under the key `observerEvalSidecar` (registered in
`src/system/config/settings-contract.ts`). Contract:
`ObserverEvalSidecarSettings` (`src/shared/contracts/runtime-base.ts`).
Defaults: `createDefaultObserverEvalSidecarSettings()`
(`src/system/config/runtime-config-contracts.ts`). Startup normalization/validation:
`validateObserverEvalSidecarStartupConfig`
(`src/system/config/observer-eval-sidecar-config.ts`).

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | **`false`** | Master enable. |
| `sidecarId` | string | `'observer-eval-sidecar'` | |
| `deploymentTarget` | `'live' \| 'eval' \| 'test_persona'` | `'test_persona'` | Corpus label; drives the DB `deployment` value. |
| `mode` | `'observe_only'` | `'observe_only'` | |
| `queue` | object | `maxQueuedTurns: 32`, `overflowPolicy: 'drop_newest'`, `observerTimeoutMs: 5000`, `maxRetries: 0`, `shutdownDrainTimeoutMs: 5000` | Bounded, drop-newest. |
| `adapter` | object | `kind: 'disabled'`, `sessionLabel: 'psfn-observer-eval'`, `agentName: 'psfn-companion'`, `includeWorldState: false` | When enabled, `kind` must be `'emosim_server'` and `serverUrl` is **required**. |
| `persistence` | object | `enabled: false`, `retentionDays: 14`, `maxStoredObservations: 10000` | `enabled: true` additionally requires a Postgres backend + explicit URL. |
| `garden` | object | `exposeHealth: true`, `exposeTelemetry: true` | Gates the admin surface. |
| `levers` | object | `enabled: false`, `cooldownMs: 21600000`, plus `wouldMessage`/`wouldCheckIn`/`wouldRest`/`ruminationWatch` | `enabled: true` requires persistence + the context-coherence event bus. |

Turning it on requires, at minimum, `enabled: true` and
`adapter.kind: 'emosim_server'` with a reachable `adapter.serverUrl` (for
example `http://psfn-emosim:17342`). The emo_sim API is unauthenticated by
design and must stay cluster-internal (ClusterIP + NetworkPolicy).

> **`emosimRoot` is a removed key.** Earlier drafts spawned a Python emo_sim
> process per call and configured it with `emosimRoot` (plus `pythonExecutable`,
> `deterministicSeed`). That spawn-per-call adapter is gone; the emo_sim engine
> is now a long-lived HTTP server addressed by `adapter.serverUrl`. The schema
> normalizer (`src/system/settings/schema-runtime-normalization.ts`) rejects
> `emosimRoot` **fail-closed** with a message pointing at
> `adapter.kind=emosim_server` / `adapter.serverUrl`. Do not reintroduce it.

## Export / admin API

Base path `/api/admin/evals/observer-sidecar`. All routes are **GET** and
require the `audit.read` capability (`audit` area). Handlers:
`src/operator/garden/routes/overview-routes.ts`; service
`AdminObserverEvalSidecarDataService`
(`src/operator/garden/services/observer-eval-sidecar-service.ts`); client wrapper
`admin-ui/src/lib/api/endpoints/observer-eval-sidecar.ts`. A missing service
returns HTTP 503.

| Path | Returns |
| --- | --- |
| `…/health` | Runtime queue/health snapshot, lifecycle state, `persistence.authoritative:false`. |
| `…/latest` | The single most-recent observation. |
| `…/observations` | Paginated observations (`observations`, `filters`, `pagination`). |
| `…/runs` | Paginated run records. |
| `…/export` | `{ exportVersion: 'garden.observer-eval-sidecar.export.v1', generatedAtMs, redacted: true, filters, observations }`. |
| `…/lever-events` | Paginated shadow-lever WOULD-ACT events. |

Observation filters: `runId, evalSessionId, scenarioId, testRunId, turnId,
privacyClass, status, minDivergenceScore, sinceMs, untilMs, limit`. Page limit
defaults to 100, max 1000.

## Garden page

- Nav: **Evals** (`admin-ui/src/lib/nav.ts`, icon 📊).
- Route: `/garden/evals/emotion-sidecar`
  (`admin-ui/src/routes/evals/emotion-sidecar/+page.svelte`), page authorization
  under `audit.read`.
- Four tabs: **Overview** (health + latest observation), **Observations**
  (paginated crosswalk/metrics/divergence rows), **Runs**, **Levers** (shadow
  WOULD-ACT events). Filters include `minDivergenceScore`, privacy class,
  status, and time window, plus an export path builder
  (`buildObserverEvalSidecarExportPath`).

## Experiment design

- **Stateful service (persistent session).** The sidecar talks to one
  long-lived `emo_sim` server that ticks continuously on its own wall clock,
  accumulating temporal emotion state across observations inside a single
  session found-or-created by a stable `sessionLabel` (never reset). Tick policy
  `EMOSIM_SERVER_TICK_POLICY = 'server-continuous-tick.shared-session.v1'`; the
  adapter reads at 1 Hz so at least one tick lands between the `beforeStimulus`
  and `afterTick` reads. This replaced a removed spawn-per-call bridge that
  rebuilt a fresh engine each turn.
- **Shadow levers.** Four levers (`would_message`, `would_check_in`,
  `would_rest`, `rumination_watch`) answer "the simulated temporal state says
  she WOULD have acted now." They are **tracking-only**: written to
  eval-owned non-authoritative tables and read only by the Garden admin service;
  nothing in the live loop consumes them (enforced by the boundary test).
- **Projection versions.** The appraisal projection is versioned so pre/post
  corpora are distinguishable without diffing code. Current
  `appraisal-projection.v3` (schema 2) is the "mood-free event appraisal": host
  accumulated mood/EMA is excluded from the projected event signal so emo_sim
  applies accumulated mood exactly once. Each deliberate change is recorded as a
  structured `ObserverProjectionAppraisalAdjustment` (never silently applied).
  Calibration is done by three separately-runnable suites under
  `calibration/` (`event-direction`, `mood-trajectory`, `outreach-timing`); the
  legacy single divergence score is retained for back-compat only and must not
  be gated on.

## Postgres tables

Migration array `POSTGRES_OBSERVER_EVAL_SIDECAR_MIGRATIONS`
(`src/persistence/postgres/migrations.ts`):

- `observer_eval_sidecar_runs` — PK `run_id`.
- `observer_eval_sidecar_observations` — PK `observation_id`, FK `run_id`
  (ON DELETE CASCADE); JSONB `observer_input_json`, `projected_appraisal_json`,
  `emosim_output_json`, `crosswalk_json`, `comparison_metrics_json`.
- `observer_eval_sidecar_lever_events` — PK `event_id`, FK `run_id`.
- `observer_eval_sidecar_lever_state` — composite PK `(sidecar_id, lever)`.

Every table enforces `eval_owner = 'observer_sidecar_eval'` and `authoritative =
FALSE` via CHECK constraints.
