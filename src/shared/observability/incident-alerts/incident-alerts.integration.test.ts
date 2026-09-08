// Real-Postgres proof of the whole operator path (beads psfn-framework-7qeo1.24.5-.6):
//
//   detector cycle -> runtime.health.event bus -> persisted ring store
//                                              -> read-only investigator
//                                              -> ONE deduplicated operator alert
//   ... and the Garden incident timeline reading that same store back under the
//   identical incident id the alert carried.
//
// The unit suites prove each seam against doubles. This one wires the real bus
// (whose `emit` runs the persisting sink and the alert path CONCURRENTLY), the
// real ring store, and the real Garden service, and then drives each of the
// four acceptance scenarios plus healthy traffic end to end.

import { DEFAULT_HUMAN_ESCALATION_CONFIG } from '../../../system/config/scheduler-config/human-escalation.js';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresHealthEventStore } from '../../../persistence/postgres/health-event-store.js';
import {
  PostgresHumanEscalationStore,
} from '../../../persistence/postgres/human-escalation-store.js';
import {
  createHumanEscalationControlPlane,
} from '../../escalation/control-plane.js';
import type { HumanEscalationLedgerPort } from '../../escalation/contracts.js';
import {
  DEFAULT_HUMAN_ESCALATION_CONFIG,
} from '../../../system/config/scheduler-config/human-escalation.js';
import {
  createOperatorAlertEscalationSink,
} from '../../../boundary/gateway/human-escalation-operator-sink.js';
import {
  AdminHumanEscalationDataService,
} from '../../../operator/garden/services/human-escalation-service.js';
import { resolveHumanEscalation } from '../../escalation/control-plane.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { DEFAULT_HEALTH_DETECTORS_CONFIG } from '../../../system/config/scheduler-config/health-detectors.js';
import { EventBus } from '../../event-bus.js';
import {
  emitHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEventSource,
} from '../../contracts/health-event.js';
import { subscribeHealthEventStream } from '../health-event-stream.js';
import { createHealthDetectorCycle } from '../health-detectors/cycle.js';
import type { HealthDetector } from '../health-detectors/contracts.js';
import { createBackgroundFailureDetector } from '../health-detectors/background-failures.js';
import { createStuckJobDetector, type StuckJobRunView } from '../health-detectors/stuck-jobs.js';
import {
  createPostgresPressureDetector,
  type PostgresPoolOwnerPressure,
} from '../health-detectors/postgres-pressure.js';
import {
  createIncidentAlertDelivery,
  subscribeIncidentAlerts,
  type OperatorIncidentAlertSink,
} from '../../../boundary/gateway/incident-alert-delivery.js';
import type { NotifyNtfyParams, OperatorAlertResult } from '../../../boundary/gateway/protocol.js';
import {
  AdminIncidentTimelineDataService,
} from '../../../operator/garden/services/incident-timeline-service.js';
import { createIncidentInvestigator } from './investigator.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const NOW_MS = 1_800_000_000_000;
const CYCLE_MS = 60_000;
const HEALTH_EVENT_ROW_CAP = 5_000;
const CONFIG = DEFAULT_HEALTH_DETECTORS_CONFIG;
const SOURCE: HealthEventSource = { owner: { kind: 'system' }, process: 'agent' };

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

interface Runtime {
  store: PostgresHealthEventStore;
  escalations: PostgresHumanEscalationStore;
  /**
   * A second control plane over the SAME durable ledger with an empty
   * in-process state, which is what a restarted process actually is.
   */
  restartedPlane: () => ReturnType<typeof createHumanEscalationControlPlane<NotifyNtfyParams>>;
  /** The same operator-alert dispatcher the wired plane pages through. */
  alertDispatcher: OperatorIncidentAlertSink;
  eventBus: EventBus;
  sent: NotifyNtfyParams[];
  garden: AdminIncidentTimelineDataService;
  setNow: (nowMs: number) => void;
  runCycle: (detectors: readonly HealthDetector[]) => Promise<void>;
}

/**
 * One process, wired the way the agent entrypoint wires it: the persisting sink
 * and the alert path both subscribed to the same bus, and the Garden service
 * over the same store, all sharing one injected clock.
 */
async function withRuntime(
  run: (runtime: Runtime) => Promise<void>,
  options: { sinkOutcome?: 'configured' | 'unconfigured' } = {},
): Promise<void> {
  if (!harness) throw new Error('postgres harness not started');
  const database = await harness.createDatabase();
  const pool: Pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'incident-alerts-integration-test',
    allowExitOnIdle: true,
  });
  try {
    const store = await PostgresHealthEventStore.fromPool(pool, HEALTH_EVENT_ROW_CAP);
    const escalations = await PostgresHumanEscalationStore.fromPool(pool, {
      bounds: DEFAULT_HUMAN_ESCALATION_CONFIG.retention,
    });
    const eventBus = new EventBus();
    const sent: NotifyNtfyParams[] = [];
    let clock = NOW_MS;
    const sink: OperatorIncidentAlertSink = {
      async dispatch(params): Promise<OperatorAlertResult> {
        sent.push(params);
        return options.sinkOutcome === 'unconfigured'
          ? {
              outcome: 'unconfigured',
              deliveries: [],
              warning: 'Operator alerting has zero configured sinks; alerts cannot leave.',
            }
          : { deliveries: [{ sink: 'ntfy', status: 'sent', target: 'ops' }] };
      },
    };
    const detachStream = subscribeHealthEventStream({ eventBus, store });
    const detachAlerts = subscribeIncidentAlerts({
      eventBus,
      delivery: createIncidentAlertDelivery({
        investigator: createIncidentInvestigator({
          readStream: query => store.listRecent(query),
          config: () => CONFIG,
          now: () => clock,
        }),
        // The alert reaches the same dispatcher through the governed escalation
        // plane over the real ledger, exactly as the gateway and agent wire it.
        escalation: createHumanEscalationControlPlane<NotifyNtfyParams>({
          ledger: escalations,
          routing: () => DEFAULT_HUMAN_ESCALATION_CONFIG.routes,
          sinks: [createOperatorAlertEscalationSink({ resolveDispatcher: () => sink })],
          now: () => clock,
          logger: { info: () => undefined, warn: () => undefined },
        }),
        policy: () => CONFIG.incidentAlerts,
        now: () => clock,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    try {
      await run({
        store,
        escalations,
        restartedPlane: () => createHumanEscalationControlPlane<NotifyNtfyParams>({
          ledger: escalations,
          routing: () => DEFAULT_HUMAN_ESCALATION_CONFIG.routes,
          sinks: [createOperatorAlertEscalationSink({ resolveDispatcher: () => sink })],
          now: () => clock,
          logger: { info: () => undefined, warn: () => undefined },
        }),
        alertDispatcher: sink,
        eventBus,
        sent,
        garden: new AdminIncidentTimelineDataService({
          readStream: query => store.listRecent(query),
          config: () => CONFIG,
          now: () => clock,
        }),
        setNow: (nowMs) => { clock = nowMs; },
        runCycle: async (detectors) => {
          await createHealthDetectorCycle({
            detectors,
            stream: store,
            publisher: eventBus,
            source: SOURCE,
            policy: {
              incidentWindowMs: CONFIG.incidentWindowMs,
              cooldownMs: CONFIG.cooldownMs,
              incidentScanLimit: CONFIG.incidentScanLimit,
            },
            now: () => clock,
          }).run();
        },
      });
    } finally {
      detachAlerts();
      detachStream();
    }
  } finally {
    await pool.end();
  }
}

function stormingPools(active: number): PostgresPoolOwnerPressure[] {
  return [{
    process: 'agent',
    authorities: [{ authorityIndex: 1, capacity: 3, active, waiting: active }],
  }];
}

/** The single incident id both surfaces must agree on. */
function soleAlertIncidentId(sent: readonly NotifyNtfyParams[]): string {
  expect(sent).toHaveLength(1);
  const key = sent[0]!.idempotencyKey ?? '';
  const incidentId = key.split(':')[0] ?? '';
  expect(incidentId).not.toBe('');
  expect(sent[0]!.message).toContain(incidentId);
  return incidentId;
}

interface RaceBarrier {
  /** How many callers have entered the window. */
  readonly held: number;
  wait(): Promise<void>;
}

/** Releases every caller only once `participants` of them are inside. */
function raceBarrier(participants: number): RaceBarrier {
  let arrived = 0;
  let open: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return {
    get held(): number { return arrived; },
    async wait(): Promise<void> {
      arrived += 1;
      if (arrived >= participants) open?.();
      await gate;
    },
  };
}

/**
 * The real Postgres ledger, held open at the exact window the duplicate-page
 * race lives in: after the control plane's replay lookup returns nothing, and
 * before it opens the escalation or claims the attempt. Every method is the
 * store's own.
 */
function holdAfterReplayLookup(
  ledger: HumanEscalationLedgerPort,
  barrier: RaceBarrier,
): HumanEscalationLedgerPort {
  return {
    openOrReopen: facts => ledger.openOrReopen(facts),
    findByCondition: (kind, dedupeKey) => ledger.findByCondition(kind, dedupeKey),
    async findAttempt(idempotencyKey) {
      const found = await ledger.findAttempt(idempotencyKey);
      await barrier.wait();
      return found;
    },
    claimAttempt: attempt => ledger.claimAttempt(attempt),
    settleAttempt: (idempotencyKey, outcome) => ledger.settleAttempt(idempotencyKey, outcome),
    markNotified: (escalationId, notifiedAtMs) => ledger.markNotified(escalationId, notifiedAtMs),
    list: query => ledger.list(query),
    countByState: () => ledger.countByState(),
    getById: escalationId => ledger.getById(escalationId),
    applyResolution: input => ledger.applyResolution(input),
  };
}

describe('incident alert and Garden timeline over the persisted stream', () => {
  it(
    'pages once for a connection storm and shows it in Garden under the same id',
    async () => {
      await withRuntime(async (runtime) => {
        let active = 3;
        const detectors = [createPostgresPressureDetector({
          telemetry: () => stormingPools(active),
          config: CONFIG.postgresPressure,
        })];
        // Forty cycles of an unrelenting storm, including one full detector
        // cooldown, is still exactly one page.
        for (let step = 0; step < 40; step += 1) {
          runtime.setNow(NOW_MS + step * CYCLE_MS);
          await runtime.runCycle(detectors);
        }

        const incidentId = soleAlertIncidentId(runtime.sent);
        expect(runtime.sent[0]!.title).toContain('opened');
        const snapshot = await runtime.garden.getSnapshot();
        expect(snapshot.incidents).toHaveLength(1);
        expect(snapshot.incidents[0]!.incidentId).toBe(incidentId);
        expect(snapshot.incidents[0]!.status).toBe('open');
        expect(snapshot.incidents[0]!.family).toBe('postgres_pool_pressure');
        expect(snapshot.incidents[0]!.timeline.length).toBeGreaterThan(1);

        // Recovery: one close notice, and Garden resolves the same incident.
        active = 0;
        for (let step = 40; step < 43; step += 1) {
          runtime.setNow(NOW_MS + step * CYCLE_MS);
          await runtime.runCycle(detectors);
        }
        expect(runtime.sent).toHaveLength(2);
        expect(runtime.sent[1]!.title).toContain('closed');
        expect(runtime.sent[1]!.idempotencyKey).toContain(incidentId);
        const resolved = await runtime.garden.getSnapshot();
        expect(resolved.incidents).toHaveLength(1);
        expect(resolved.incidents[0]!.incidentId).toBe(incidentId);
        expect(resolved.incidents[0]!.status).toBe('closed');
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'pages once for a repeated memory-refresh failure',
    async () => {
      await withRuntime(async (runtime) => {
        const subjectHash = hashHealthEventSubject('memory_refresh:active_context');
        const failAt = (atMs: number): Promise<void> => emitHealthEvent(runtime.eventBus, {
          owner: SOURCE.owner,
          severity: 'degraded',
          code: 'memory_refresh_failed',
          provenance: {
            process: 'agent',
            component: 'memory',
            observerId: processObserverId(),
            subjectHash,
          },
          observedAtMs: atMs,
        });
        const detectors = [createBackgroundFailureDetector({
          config: CONFIG.backgroundFailures,
        })];

        // One transient failure never pages.
        await failAt(NOW_MS);
        runtime.setNow(NOW_MS + CYCLE_MS);
        await runtime.runCycle(detectors);
        expect(runtime.sent).toEqual([]);
        expect((await runtime.garden.getSnapshot()).incidents).toEqual([]);

        await failAt(NOW_MS + CYCLE_MS);
        await failAt(NOW_MS + 2 * CYCLE_MS);
        for (let step = 3; step < 40; step += 1) {
          runtime.setNow(NOW_MS + step * CYCLE_MS);
          await runtime.runCycle(detectors);
        }

        const incidentId = soleAlertIncidentId(runtime.sent);
        expect(runtime.sent[0]!.message).toContain('healthDetectors.backgroundFailures');
        const snapshot = await runtime.garden.getSnapshot();
        expect(snapshot.incidents).toHaveLength(1);
        expect(snapshot.incidents[0]!.incidentId).toBe(incidentId);
        expect(snapshot.incidents[0]!.evidence.failureCount).toBeGreaterThanOrEqual(
          CONFIG.backgroundFailures.failureThreshold,
        );
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'pages once for a stuck automata run, including across a detector restart',
    async () => {
      await withRuntime(async (runtime) => {
        const runs: StuckJobRunView[] = [{
          runId: 'automata-run-wedged',
          status: 'running',
          createdAtMs: NOW_MS,
          startedAtMs: NOW_MS,
        }];
        const budgetMs = CONFIG.stuckJobs.automataRunBudgetMs;
        const detectors = () => [createStuckJobDetector({
          config: CONFIG.stuckJobs,
          listRuns: () => runs,
        })];

        // A long run inside its budget is not an incident.
        runtime.setNow(NOW_MS + budgetMs);
        await runtime.runCycle(detectors());
        expect(runtime.sent).toEqual([]);

        for (let step = 1; step <= 20; step += 1) {
          runtime.setNow(NOW_MS + budgetMs + step * CYCLE_MS);
          // A fresh detector list at the halfway point stands in for a restart.
          await runtime.runCycle(detectors());
        }

        const incidentId = soleAlertIncidentId(runtime.sent);
        const snapshot = await runtime.garden.getSnapshot();
        expect(snapshot.incidents).toHaveLength(1);
        expect(snapshot.incidents[0]!.incidentId).toBe(incidentId);
        expect(snapshot.incidents[0]!.family).toBe('stuck_runtime_job');
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'attempts exactly one alert for an unconfigured sink and still shows it in Garden',
    async () => {
      await withRuntime(async (runtime) => {
        const emitUnconfigured = (atMs: number): Promise<void> => emitHealthEvent(
          runtime.eventBus,
          {
            owner: { kind: 'system' },
            severity: 'critical',
            code: 'operator_alert_sinks_unconfigured',
            provenance: {
              process: 'gateway',
              component: 'operator_alerting',
              observerId: processObserverId(),
            },
            observedAtMs: atMs,
            evidence: { configuredSinkCount: 0 },
          },
        );

        await emitUnconfigured(NOW_MS);
        // A redelivery of the same statement must not become a second attempt.
        const persisted = await runtime.store.listRecent({ limit: 10 });
        expect(persisted).toHaveLength(1);
        await runtime.eventBus.emit('runtime.health.event', { event: persisted[0]! });

        const incidentId = soleAlertIncidentId(runtime.sent);
        // The delivery reported `unconfigured`, so the surviving operator paths
        // are the log and this Garden row — under the same incident id.
        const snapshot = await runtime.garden.getSnapshot();
        expect(snapshot.incidents).toHaveLength(1);
        expect(snapshot.incidents[0]!.incidentId).toBe(incidentId);
        expect(snapshot.incidents[0]!.family).toBeNull();
        expect(snapshot.incidents[0]!.code).toBe('operator_alert_sinks_unconfigured');
        expect(snapshot.incidents[0]!.evidence).toEqual({ configuredSinkCount: 0 });
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'pages nothing and shows nothing under healthy traffic',
    async () => {
      await withRuntime(async (runtime) => {
        const detectors = [
          createPostgresPressureDetector({
            telemetry: () => [{
              process: 'agent',
              authorities: [{ authorityIndex: 1, capacity: 3, active: 1, waiting: 0 }],
            }],
            config: CONFIG.postgresPressure,
          }),
          createBackgroundFailureDetector({ config: CONFIG.backgroundFailures }),
          createStuckJobDetector({ config: CONFIG.stuckJobs, listRuns: () => [] }),
        ];
        for (let step = 0; step < 20; step += 1) {
          runtime.setNow(NOW_MS + step * CYCLE_MS);
          await runtime.runCycle(detectors);
        }

        expect(runtime.sent).toEqual([]);
        expect(await runtime.store.listRecent({ limit: 100 })).toEqual([]);
        const snapshot = await runtime.garden.getSnapshot();
        expect(snapshot.incidents).toEqual([]);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );
  it(
    'lands one durable escalation per incident, keyed on the alert\'s own idempotency key',
    async () => {
      await withRuntime(async (runtime) => {
        const detectors = [createPostgresPressureDetector({
          telemetry: () => stormingPools(3),
          config: CONFIG.postgresPressure,
        })];
        for (let step = 0; step < 6; step += 1) {
          runtime.setNow(NOW_MS + step * CYCLE_MS);
          await runtime.runCycle(detectors);
        }

        const incidentId = soleAlertIncidentId(runtime.sent);
        const rows = await runtime.escalations.list({ limit: 50 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          kind: 'runtime_incident',
          // The condition an operator resolves is the incident itself.
          dedupeKey: incidentId,
          sourceRef: incidentId,
          state: 'open',
          raiseCount: 1,
          detailPath: '/subsystem-health',
        });
        expect(rows[0]!.labels).toContain('postgres_pool_pressure_opened');
        // The attempt is keyed on exactly the key the alert carried.
        await expect(runtime.escalations.findAttempt(runtime.sent[0]!.idempotencyKey ?? ''))
          .resolves.toMatchObject({ sink: 'operator_alert', outcome: 'delivered' });
        await expect(runtime.escalations.countByState()).resolves.toEqual({
          open: 1,
          acknowledged: 0,
          resolved: 0,
          dismissed: 0,
        });
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'survives a restart: a redelivered alert dispatches nothing and writes no second row',
    async () => {
      await withRuntime(async (runtime) => {
        const detectors = [createPostgresPressureDetector({
          telemetry: () => stormingPools(3),
          config: CONFIG.postgresPressure,
        })];
        for (let step = 0; step < 6; step += 1) {
          runtime.setNow(NOW_MS + step * CYCLE_MS);
          await runtime.runCycle(detectors);
        }
        const incidentId = soleAlertIncidentId(runtime.sent);
        const idempotencyKey = runtime.sent[0]!.idempotencyKey ?? '';

        // A fresh process with an empty in-memory ledger re-raising the same
        // rendered alert. The durable attempt row is what makes it a no-op.
        const replayed = await runtime.restartedPlane().raise({
          kind: 'runtime_incident',
          severity: 'critical',
          owner: { kind: 'system' },
          dedupeKey: incidentId,
          idempotencyKey,
          sourceRef: incidentId,
          labels: ['postgres_pool_pressure_opened'],
          evidence: { failureCount: 1 },
          detailPath: '/subsystem-health',
          raisedAtMs: NOW_MS,
          notice: runtime.sent[0]!,
        });

        expect(replayed).toMatchObject({ status: 'replayed', outcome: 'delivered' });
        expect(runtime.sent).toHaveLength(1);
        const rows = await runtime.escalations.list({ limit: 50 });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.raiseCount).toBe(1);
        // ...and the durable raise count is what a restarted process derives its
        // NEXT key from, so the re-alert after this boot is `:opened:2` rather
        // than a re-minted `:opened:1` the ledger would refuse to dispatch.
        await expect(runtime.restartedPlane().raiseCount('runtime_incident', incidentId))
          .resolves.toBe(1);
        expect(idempotencyKey).toBe(`${incidentId}:opened:1`);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'pages once when two processes raise the same new incident simultaneously',
    async () => {
      await withRuntime(async (runtime) => {
        // Two processes — the gateway and the agent — reacting to one incident
        // at the same instant. Both read a raise count of zero, both mint
        // `:opened:1`, and both find no recorded attempt, because neither has
        // written anything yet: the replay lookup structurally cannot separate
        // them. Only the attempt claim taken BEFORE dispatch can, and that
        // claim is a PRIMARY KEY insert executed here against real Postgres.
        //
        // The overlap is forced rather than hoped for. Left to chance the two
        // raises serialize behind the pool and the loser replays off the
        // committed attempt row, which proves nothing about the window this
        // fixes. The barrier holds both raises inside that window — past the
        // replay lookup, before either has opened or claimed anything — and
        // every ledger call after it is the unmodified Postgres store.
        const incidentId = 'incident-race-0001';
        const barrier = raceBarrier(2);
        const racing = holdAfterReplayLookup(runtime.escalations, barrier);
        const plane = () => createHumanEscalationControlPlane<NotifyNtfyParams>({
          ledger: racing,
          routing: () => DEFAULT_HUMAN_ESCALATION_CONFIG.routes,
          sinks: [createOperatorAlertEscalationSink({
            resolveDispatcher: () => runtime.alertDispatcher,
          })],
          now: () => NOW_MS,
          logger: { info: () => undefined, warn: () => undefined },
        });
        const idempotencyKey = `${incidentId}:opened:1`;
        const notice: NotifyNtfyParams = {
          sender: { kind: 'system', provenance: 'system.operator_alert.runtime_incident' },
          title: 'PSFN incident opened: race',
          message: `Garden: /subsystem-health, incident ${incidentId}`,
          idempotencyKey,
        };
        const raise = () => plane().raise({
          kind: 'runtime_incident',
          severity: 'critical',
          owner: { kind: 'system' },
          dedupeKey: incidentId,
          idempotencyKey,
          sourceRef: incidentId,
          labels: ['postgres_pool_pressure_opened'],
          evidence: { failureCount: 1 },
          detailPath: '/subsystem-health',
          raisedAtMs: NOW_MS,
          notice,
        });

        const [first, second] = await Promise.all([raise(), raise()]);

        // Both raises were inside the window together...
        expect(barrier.held).toBe(2);
        // ...and exactly one human was paged.
        expect(runtime.sent).toHaveLength(1);
        expect(runtime.sent[0]!.idempotencyKey).toBe(idempotencyKey);
        expect([first.status, second.status].sort()).toEqual(['delivered', 'replayed']);
        // One condition, one escalation row, one settled attempt.
        const rows = await runtime.escalations.list({ limit: 50 });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ dedupeKey: incidentId, state: 'open' });
        await expect(runtime.escalations.findAttempt(idempotencyKey))
          .resolves.toMatchObject({ sink: 'operator_alert', outcome: 'delivered' });
        // Accepted side effect: the losing raise still opened the escalation, so
        // the durable raise count is 2 and the next re-alert is `:opened:3`. The
        // key scheme is intact; only a sequence number is skipped.
        await expect(runtime.escalations.findByCondition('runtime_incident', incidentId))
          .resolves.toMatchObject({ raiseCount: 2 });
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'lets a human resolve the escalation, and reopens it when the runtime restates it',
    async () => {
      await withRuntime(async (runtime) => {
        const detectors = [createPostgresPressureDetector({
          telemetry: () => stormingPools(3),
          config: CONFIG.postgresPressure,
        })];
        for (let step = 0; step < 6; step += 1) {
          runtime.setNow(NOW_MS + step * CYCLE_MS);
          await runtime.runCycle(detectors);
        }
        const garden = new AdminHumanEscalationDataService({
          ledger: runtime.escalations,
          config: () => DEFAULT_HUMAN_ESCALATION_CONFIG,
          now: () => NOW_MS,
        });
        const open = await garden.getSnapshot(['open']);
        expect(open.escalations).toHaveLength(1);
        const escalationId = open.escalations[0]!.escalationId;

        await expect(garden.resolve({
          escalationId,
          state: 'resolved',
          reason: 'handled',
          actor: 'operator',
        })).resolves.toMatchObject({ ok: true });
        await expect(garden.getSnapshot(['open'])).resolves.toMatchObject({ escalations: [] });
        // A second human decision on a terminal row is refused, not applied.
        await expect(resolveHumanEscalation(runtime.escalations, {
          escalationId,
          state: 'dismissed',
          reason: 'duplicate',
          actor: 'operator',
          resolvedAtMs: NOW_MS,
        })).resolves.toMatchObject({ ok: false, status: 409 });

        // The fault is still going, so the next re-alert reopens the same row
        // rather than leaving a resolved escalation over a live incident.
        runtime.setNow(NOW_MS + CONFIG.incidentAlerts.realertCooldownMs + CYCLE_MS);
        await runtime.runCycle(detectors);

        expect(runtime.sent.length).toBeGreaterThan(1);
        const reopened = await garden.getSnapshot(['open']);
        expect(reopened.escalations).toHaveLength(1);
        expect(reopened.escalations[0]).toMatchObject({
          escalationId,
          state: 'open',
          resolution: null,
        });
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
