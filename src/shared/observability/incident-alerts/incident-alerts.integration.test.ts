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

import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../../../persistence/postgres.js';
import { PostgresHealthEventStore } from '../../../persistence/postgres/health-event-store.js';
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
        resolveSink: () => sink,
        policy: () => CONFIG.incidentAlerts,
        now: () => clock,
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      }),
      logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
    });
    try {
      await run({
        store,
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
});
