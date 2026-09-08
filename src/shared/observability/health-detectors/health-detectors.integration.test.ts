// Real-Postgres proof that "one incident per episode" is a property of the
// PERSISTED stream, not of a detector's memory (beads psfn-framework-7qeo1.24.2-.4).
//
// The unit suite runs the same diff against an in-memory double. This runs it
// against the actual ring store — write path, JSONB evidence, read-back
// re-validation, and the newest-first `listRecent` seam the detectors depend
// on — and then throws away the whole detector runtime mid-storm to prove a
// restart continues the incident instead of starting a second one.

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
import {
  createHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEvent,
  type HealthEventSource,
} from '../../contracts/health-event.js';
import { createHealthDetectorCycle } from './cycle.js';
import { createBackgroundFailureDetector } from './background-failures.js';
import {
  createPostgresPressureDetector,
  type PostgresPoolOwnerPressure,
} from './postgres-pressure.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const NOW_MS = 1_800_000_000_000;
const CYCLE_MS = 60_000;
const HEALTH_EVENT_ROW_CAP = 5_000;
const SOURCE: HealthEventSource = { owner: { kind: 'system' }, process: 'agent' };

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function stormingPools(active: number): PostgresPoolOwnerPressure[] {
  return [{
    process: 'agent',
    authorities: [{ authorityIndex: 1, capacity: 3, active, waiting: active }],
  }];
}

async function withStore(
  run: (store: PostgresHealthEventStore) => Promise<void>,
): Promise<void> {
  if (!harness) throw new Error('postgres harness not started');
  const database = await harness.createDatabase();
  const pool: Pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'health-detectors-integration-test',
    allowExitOnIdle: true,
  });
  try {
    await run(await PostgresHealthEventStore.fromPool(pool, HEALTH_EVENT_ROW_CAP));
  } finally {
    await pool.end();
  }
}

describe('runtime health detectors over the persisted stream', () => {
  it(
    'records exactly one incident per episode across a restart and closes it once',
    async () => {
      await withStore(async (store) => {
        let clock = NOW_MS;
        let active = 3;
        const buildCycle = () => createHealthDetectorCycle({
          detectors: [createPostgresPressureDetector({
            telemetry: () => stormingPools(active),
            config: DEFAULT_HEALTH_DETECTORS_CONFIG.postgresPressure,
          })],
          stream: store,
          // The real bus sink re-validates and writes; here the cycle writes
          // straight through the same store the sink would use, so every row
          // under test went through `validateHealthEvent` on the way in.
          publisher: { emit: (_event, data) => store.record(data.event) },
          source: SOURCE,
          policy: {
            incidentWindowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
            cooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs,
            incidentScanLimit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
          },
          now: () => clock,
        });

        let cycle = buildCycle();
        for (let step = 0; step < 5; step += 1) {
          clock = NOW_MS + step * CYCLE_MS;
          await cycle.run();
        }

        // Restart mid-storm: a brand new detector runtime, no in-memory state.
        cycle = buildCycle();
        for (let step = 5; step < 40; step += 1) {
          clock = NOW_MS + step * CYCLE_MS;
          await cycle.run();
        }

        const duringStorm = await store.listRecent({ limit: 1_000 });
        const opened = duringStorm.filter(
          event => event.code === 'postgres_pool_pressure_opened',
        );
        expect(opened.length).toBeGreaterThan(1);
        const correlationIds = new Set(opened.map(event => event.correlationId));
        expect(correlationIds.size).toBe(1);
        // Occurrence counts rise monotonically on that one incident.
        const counts = [...opened]
          .sort((left, right) => left.recordedAtMs - right.recordedAtMs)
          .map(event => event.occurrenceCount);
        expect(counts).toEqual([...counts].sort((left, right) => left - right));
        expect(counts[0]).toBe(1);
        expect(duringStorm.some(event => event.code === 'postgres_pool_pressure_closed'))
          .toBe(false);

        // Recovery: exactly one close, on the same correlation id.
        active = 0;
        for (let step = 40; step < 45; step += 1) {
          clock = NOW_MS + step * CYCLE_MS;
          await cycle.run();
        }
        const afterRecovery = await store.listRecent({ limit: 1_000 });
        const closed = afterRecovery.filter(
          event => event.code === 'postgres_pool_pressure_closed',
        );
        expect(closed).toHaveLength(1);
        expect(closed[0]!.correlationId).toBe([...correlationIds][0]);
        expect(closed[0]!.evidence.terminal).toBe(true);

        // And the whole incident is retrievable as one correlated thread.
        const thread: HealthEvent[] = await store.listRecent({
          limit: 1_000,
          correlationId: closed[0]!.correlationId,
        });
        expect(thread.length).toBe(opened.length + 1);
        expect(new Set(thread.map(event => event.provenance.subjectHash)).size).toBe(1);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'turns repeated lane failures into one incident and closes it on recovery',
    async () => {
      await withStore(async (store) => {
        let clock = NOW_MS;
        const cycle = createHealthDetectorCycle({
          detectors: [createBackgroundFailureDetector({
            config: DEFAULT_HEALTH_DETECTORS_CONFIG.backgroundFailures,
          })],
          stream: store,
          publisher: { emit: (_event, data) => store.record(data.event) },
          source: SOURCE,
          policy: {
            incidentWindowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
            cooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs,
            incidentScanLimit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
          },
          now: () => clock,
        });

        // One transient failure, exactly as the supervisor would write it.
        const subjectHash = hashHealthEventSubject('memory_extraction');
        const recordFailure = (atMs: number): Promise<void> => store.record(createHealthEvent({
          owner: SOURCE.owner,
          severity: 'degraded',
          code: 'background_work_job_failed',
          provenance: {
            process: 'agent',
            component: 'background_work',
            observerId: processObserverId(),
            subjectHash,
          },
          observedAtMs: atMs,
        }));

        await recordFailure(NOW_MS);
        clock = NOW_MS + CYCLE_MS;
        await cycle.run();
        expect((await store.listRecent({ limit: 1_000 }))
          .filter(event => event.code.startsWith('background_work_failures'))).toEqual([]);

        // The lane keeps failing: one incident, however many cycles observe it.
        await recordFailure(NOW_MS + CYCLE_MS);
        await recordFailure(NOW_MS + 2 * CYCLE_MS);
        for (let step = 3; step < 40; step += 1) {
          clock = NOW_MS + step * CYCLE_MS;
          await cycle.run();
        }
        const opened = (await store.listRecent({ limit: 1_000 }))
          .filter(event => event.code === 'background_work_failures_opened');
        expect(opened.length).toBeGreaterThan(1);
        expect(new Set(opened.map(event => event.correlationId)).size).toBe(1);

        // Recovery: the failures age past the owner-file window, exactly once.
        clock = NOW_MS
          + DEFAULT_HEALTH_DETECTORS_CONFIG.backgroundFailures.windowMs
          + 10 * CYCLE_MS;
        await cycle.run();
        clock += CYCLE_MS;
        await cycle.run();
        const closed = (await store.listRecent({ limit: 1_000 }))
          .filter(event => event.code === 'background_work_failures_closed');
        expect(closed).toHaveLength(1);
        expect(closed[0]!.correlationId).toBe(opened[0]!.correlationId);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );

  it(
    'writes nothing at all for a healthy pool',
    async () => {
      await withStore(async (store) => {
        let clock = NOW_MS;
        const cycle = createHealthDetectorCycle({
          detectors: [createPostgresPressureDetector({
            telemetry: () => [{
              process: 'agent',
              authorities: [{ authorityIndex: 1, capacity: 3, active: 1, waiting: 0 }],
            }],
            config: DEFAULT_HEALTH_DETECTORS_CONFIG.postgresPressure,
          })],
          stream: store,
          publisher: { emit: (_event, data) => store.record(data.event) },
          source: SOURCE,
          policy: {
            incidentWindowMs: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentWindowMs,
            cooldownMs: DEFAULT_HEALTH_DETECTORS_CONFIG.cooldownMs,
            incidentScanLimit: DEFAULT_HEALTH_DETECTORS_CONFIG.incidentScanLimit,
          },
          now: () => clock,
        });
        for (let step = 0; step < 20; step += 1) {
          clock = NOW_MS + step * CYCLE_MS;
          await cycle.run();
        }
        expect(await store.listRecent({ limit: 1_000 })).toEqual([]);
      });
    },
    INTEGRATION_TIMEOUT_MS,
  );
});
