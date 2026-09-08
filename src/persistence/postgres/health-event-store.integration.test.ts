import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresHealthEventStore } from './health-event-store.js';
import {
  createHealthEvent,
  hashHealthEventSubject,
  processObserverId,
  type HealthEvent,
  type HealthEventInput,
} from '../../shared/contracts/health-event.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const NOW_MS = 1_800_000_000_000;
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function event(overrides: Partial<HealthEventInput> = {}): HealthEvent {
  return createHealthEvent({
    owner: { kind: 'system' },
    severity: 'degraded',
    code: 'scheduler_task_failed',
    provenance: {
      process: 'agent',
      component: 'scheduler',
      observerId: processObserverId(),
      subjectHash: hashHealthEventSubject('backup'),
    },
    observedAtMs: NOW_MS,
    ...overrides,
  });
}

async function withDatabase<T>(
  run: (pool: Pool, databaseUrl: string) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('postgres harness not started');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'health-event-store-test',
    allowExitOnIdle: true,
  });
  try {
    return await run(pool, database.databaseUrl);
  } finally {
    await pool.end();
  }
}

describe('PostgresHealthEventStore', () => {
  it('round-trips a companion-owned envelope with causation and evidence intact', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresHealthEventStore.fromPool(pool, 100);
      const cause = event();
      const effect = event({
        owner: { kind: 'companion', companionId: COMPANION_ID as never },
        code: 'background_work_job_failed',
        correlationId: cause.correlationId,
        causationId: cause.eventId,
        provenance: {
          process: 'agent',
          component: 'background_work',
          observerId: processObserverId(),
          subjectHash: hashHealthEventSubject('memory_refresh'),
        },
        occurrenceCount: 4,
        observedAtMs: NOW_MS,
        lastObservedAtMs: NOW_MS + 2_000,
        recordedAtMs: NOW_MS + 2_500,
        evidence: { attemptCount: 5, jobAgeMs: 900, terminal: true },
      });
      await store.record(cause);
      await store.record(effect);

      const rows = await store.listRecent();
      expect(rows).toHaveLength(2);
      // Newest-first by record time.
      expect(rows[0]).toEqual(effect);
      expect(rows[1]).toEqual(cause);
      expect(rows[0].owner).toEqual({ kind: 'companion', companionId: COMPANION_ID });
      expect(rows[0].causationId).toBe(cause.eventId);
      expect(rows[0].evidence).toEqual({ attemptCount: 5, jobAgeMs: 900, terminal: true });
      expect(rows[1].owner).toEqual({ kind: 'system' });
      expect(rows[1].causationId).toBeUndefined();
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('bounds the stream to the owner-file row cap, keeping the newest', async () => {
    await withDatabase(async (pool) => {
      const maxRows = 5;
      const store = await PostgresHealthEventStore.fromPool(pool, maxRows);
      const written: HealthEvent[] = [];
      for (let index = 0; index < maxRows + 7; index += 1) {
        const record = event({ observedAtMs: NOW_MS + index * 1_000 });
        written.push(record);
        await store.record(record);
      }

      const rows = await store.listRecent({ limit: 1_000 });
      expect(rows).toHaveLength(maxRows);
      expect(rows.map(row => row.eventId)).toEqual(
        written.slice(-maxRows).reverse().map(row => row.eventId),
      );
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('survives restart: a fresh store over the same database keeps the bound', async () => {
    await withDatabase(async (pool, databaseUrl) => {
      const first = await PostgresHealthEventStore.fromPool(pool, 3);
      for (let index = 0; index < 4; index += 1) {
        await first.record(event({ observedAtMs: NOW_MS + index * 1_000 }));
      }
      await first.close();

      const reopened = await PostgresHealthEventStore.connect(databaseUrl, 3);
      try {
        const rows = await reopened.listRecent();
        expect(rows).toHaveLength(3);
        expect(rows[0].recordedAtMs).toBe(NOW_MS + 3_000);
        // The cap still holds across the restart boundary.
        await reopened.record(event({ observedAtMs: NOW_MS + 9_000 }));
        expect(await reopened.listRecent()).toHaveLength(3);
      } finally {
        await reopened.close();
      }
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('is idempotent on eventId so a redelivered bus event never double-counts', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresHealthEventStore.fromPool(pool, 100);
      const record = event();
      await store.record(record);
      await store.record(record);
      expect(await store.listRecent()).toHaveLength(1);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('narrows reads to one incident and one time window', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresHealthEventStore.fromPool(pool, 100);
      const incident = event({ observedAtMs: NOW_MS });
      const sameIncident = event({
        correlationId: incident.correlationId,
        observedAtMs: NOW_MS + 1_000,
      });
      const other = event({ observedAtMs: NOW_MS + 2_000 });
      for (const record of [incident, sameIncident, other]) await store.record(record);

      const byIncident = await store.listRecent({ correlationId: incident.correlationId });
      expect(byIncident.map(row => row.eventId))
        .toEqual([sameIncident.eventId, incident.eventId]);
      const byWindow = await store.listRecent({ sinceMs: NOW_MS + 1_000 });
      expect(byWindow.map(row => row.eventId)).toEqual([other.eventId, sameIncident.eventId]);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('refuses an unbounded read limit and an undeclared row cap', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresHealthEventStore.fromPool(pool, 100);
      await expect(store.listRecent({ limit: 0 })).rejects.toThrow(/limit/u);
      await expect(store.listRecent({ limit: 1_001 })).rejects.toThrow(/limit/u);
      await expect(store.listRecent({ sinceMs: -1 })).rejects.toThrow(/sinceMs/u);
      await expect(PostgresHealthEventStore.fromPool(pool, 0))
        .rejects.toThrow(/positive settings-owned row cap/u);
    });
  }, INTEGRATION_TIMEOUT_MS);

  it('refuses a persisted row the envelope contract would not accept', async () => {
    await withDatabase(async (pool) => {
      const store = await PostgresHealthEventStore.fromPool(pool, 100);
      await store.record(event());
      // A row hand-edited to an unknown code must fail closed on read rather
      // than reaching a detector as a half-typed object.
      await pool.query("UPDATE runtime_health_events SET code = 'everything_broke'");
      await expect(store.listRecent()).rejects.toThrow(/code must be one of/u);
    });
  }, INTEGRATION_TIMEOUT_MS);
});
