import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPool } from '../../../persistence/postgres.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import {
  createIcpCertificationFixture,
  type IcpCertificationFixture,
} from '../icp-certification/fixture.js';
import {
  BACKGROUND_MAINTENANCE_TASK_ID,
} from '../../../core/scheduler/background-maintenance.js';
import {
  FREE_TIME_IDLE_TASK_ID,
  FREE_TIME_QUIET_HOURS_TASK_ID,
} from '../../../core/scheduler/free-time.js';
import {
  TEMPORAL_WAKEUP_MORNING_TASK_ID,
} from '../../../core/scheduler/temporal-wakeup.js';
import {
  WEIGHTED_THOUGHT_OUTREACH_TASK_ID,
} from '../../../core/scheduler/weighted-thought-outreach-lane.js';
import { certifyIdlePurity } from './certification.js';
import { capturePostgresWriteSnapshot } from './postgres-write-snapshot.js';
import {
  startIdlePurityRuntimeHarness,
  type IdlePurityRuntimeHarness,
} from './runtime-harness.js';

const TIMEOUT_MS = 300_000;
const DEFAULT_TEST_IDLE_WINDOW_MS = 1_000;
const DEFAULT_TEST_WARMUP_MS = 0;
const BASELINE_SAMPLE_INTERVAL_MS = 1_500;
const BASELINE_SETTLE_TIMEOUT_MS = 15_000;

function resolveIdleWindowMs(): number {
  const configured = process.env.PSFN_IDLE_PURITY_WINDOW_MS;
  if (configured === undefined) return DEFAULT_TEST_IDLE_WINDOW_MS;
  const duration = Number(configured);
  if (!Number.isSafeInteger(duration) || duration <= 0) {
    throw new Error('PSFN_IDLE_PURITY_WINDOW_MS must be a positive integer');
  }
  return duration;
}

function resolveWarmupMs(): number {
  const configured = process.env.PSFN_IDLE_PURITY_WARMUP_MS;
  if (configured === undefined) return DEFAULT_TEST_WARMUP_MS;
  const duration = Number(configured);
  if (!Number.isSafeInteger(duration) || duration < 0) {
    throw new Error('PSFN_IDLE_PURITY_WARMUP_MS must be a non-negative integer');
  }
  return duration;
}

describe('idle-purity real quiet-runtime certification', () => {
  let postgres: PostgresTestHarness | null = null;
  let fixture: IcpCertificationFixture | null = null;
  let processHarness: IdlePurityRuntimeHarness | null = null;

  beforeAll(async () => {
    postgres = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
  }, TIMEOUT_MS);

  afterEach(async () => {
    await processHarness?.stop();
    processHarness = null;
    fixture?.cleanup();
    fixture = null;
  }, TIMEOUT_MS);

  afterAll(async () => {
    await postgres?.stop();
    postgres = null;
  }, TIMEOUT_MS);

  it('boots enabled automata with no work due and observes no durable churn', async () => {
    if (!postgres) throw new Error('PostgreSQL idle-purity harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({
      databaseUrl,
      autonomyEnabled: true,
      topology: 'single_companion',
    });
    processHarness = await startIdlePurityRuntimeHarness({ fixture });
    await expect(processHarness.schedulerTaskIds()).resolves.toEqual(expect.arrayContaining([
      BACKGROUND_MAINTENANCE_TASK_ID,
      FREE_TIME_IDLE_TASK_ID,
      FREE_TIME_QUIET_HOURS_TASK_ID,
      TEMPORAL_WAKEUP_MORNING_TASK_ID,
      WEIGHTED_THOUGHT_OUTREACH_TASK_ID,
    ]));
    expect(processHarness.modelRequestCount).toBe(0);
    const warmupMs = resolveWarmupMs();
    if (warmupMs > 0) {
      await new Promise<void>(resolveWarmup => setTimeout(resolveWarmup, warmupMs));
    }

    const observerPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-idle-purity-certification',
      max: 1,
      readOnly: true,
    });
    try {
      const report = await certifyIdlePurity({
        allowlist: { filesystem: [] },
        runtimeRoot: fixture.runtimeRoot,
        idleWindowMs: resolveIdleWindowMs(),
        capturePostgresWrites: async () => await capturePostgresWriteSnapshot(observerPool),
        stabilization: {
          sampleIntervalMs: BASELINE_SAMPLE_INTERVAL_MS,
          timeoutMs: BASELINE_SETTLE_TIMEOUT_MS,
        },
      });
      expect(report).toEqual({ allowedChanges: [], violations: [] });
      expect(processHarness.modelRequestCount).toBe(0);
    } finally {
      await observerPool.end();
    }
  }, TIMEOUT_MS);

  it('fails on a real unapproved PostgreSQL write', async () => {
    if (!postgres) throw new Error('PostgreSQL idle-purity harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, topology: 'single_companion' });
    const writerPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-idle-purity-certification-writer-probe',
      max: 1,
    });
    const observerPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-idle-purity-certification-observer-probe',
      max: 1,
      readOnly: true,
    });
    try {
      await writerPool.query('CREATE TABLE public.idle_purity_probe (id integer PRIMARY KEY)');
      await expect(certifyIdlePurity({
        runtimeRoot: fixture.runtimeRoot,
        idleWindowMs: 0,
        capturePostgresWrites: async () => await capturePostgresWriteSnapshot(observerPool),
        wait: async () => {
          await writerPool.query('INSERT INTO public.idle_purity_probe (id) VALUES (1)');
          await writerPool.query('SELECT pg_stat_force_next_flush()');
        },
      })).rejects.toThrow(
        /postgres wrote: public\.idle_purity_probe \(inserted=1, updated=0, deleted=0\)/u,
      );
    } finally {
      await observerPool.end();
      await writerPool.end();
    }
  }, TIMEOUT_MS);

  it('fails when a PostgreSQL sequence advances without a table write', async () => {
    if (!postgres) throw new Error('PostgreSQL idle-purity harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, topology: 'single_companion' });
    const writerPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-idle-purity-certification-sequence-probe',
      max: 1,
    });
    const observerPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-idle-purity-certification-sequence-observer',
      max: 1,
      readOnly: true,
    });
    try {
      await writerPool.query('CREATE SEQUENCE public.idle_purity_sequence');
      await expect(certifyIdlePurity({
        runtimeRoot: fixture.runtimeRoot,
        idleWindowMs: 0,
        capturePostgresWrites: async () => await capturePostgresWriteSnapshot(observerPool),
        wait: async () => {
          await writerPool.query("SELECT nextval('public.idle_purity_sequence')");
        },
      })).rejects.toThrow(/postgres state changed: public\.idle_purity_sequence/u);
    } finally {
      await observerPool.end();
      await writerPool.end();
    }
  }, TIMEOUT_MS);

  it('fails when a PostgreSQL insert and delete leave the same final rows', async () => {
    if (!postgres) throw new Error('PostgreSQL idle-purity harness is unavailable');
    const { databaseUrl } = await postgres.createDatabase();
    fixture = createIcpCertificationFixture({ databaseUrl, topology: 'single_companion' });
    const writerPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-idle-purity-certification-net-zero-probe',
      max: 1,
    });
    const observerPool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-idle-purity-certification-net-zero-observer',
      max: 1,
      readOnly: true,
    });
    try {
      await writerPool.query('CREATE TABLE public.idle_purity_net_zero_probe (id integer PRIMARY KEY)');
      await expect(certifyIdlePurity({
        runtimeRoot: fixture.runtimeRoot,
        idleWindowMs: 0,
        capturePostgresWrites: async () => await capturePostgresWriteSnapshot(observerPool),
        wait: async () => {
          await writerPool.query('INSERT INTO public.idle_purity_net_zero_probe (id) VALUES (1)');
          await writerPool.query('DELETE FROM public.idle_purity_net_zero_probe WHERE id = 1');
          await writerPool.query('SELECT pg_stat_force_next_flush()');
        },
      })).rejects.toThrow(
        /postgres wrote: public\.idle_purity_net_zero_probe \(inserted=1, updated=0, deleted=1\)/u,
      );
    } finally {
      await observerPool.end();
      await writerPool.end();
    }
  }, TIMEOUT_MS);
});
