import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { DurableRestWindowPolicy } from '../../core/scheduler/rest-window-policy.js';
import { PostgresSchedulerLaneStateStore } from './scheduler-lane-state-store.js';
import { createPostgresPool } from '../postgres.js';

const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness();
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

/** A database with the companion schemas pre-provisioned, as tenancy does in production. */
async function databaseUrl(schemas: readonly string[]): Promise<string> {
  if (!harness) throw new Error('PostgreSQL integration harness is not available');
  const { databaseUrl: url } = await harness.createDatabase();
  const admin = createPostgresPool(url, { applicationName: 'scheduler-lane-state-admin', max: 1 });
  try {
    for (const schema of schemas) await admin.query(`CREATE SCHEMA ${schema}`);
  } finally {
    await admin.end();
  }
  return url;
}

describe('PostgresSchedulerLaneStateStore', () => {
  it('keeps rest silence across restart, extend-only, and isolated per companion schema (89muv)', async () => {
    const url = await databaseUrl(['companion_lane_state_alpha', 'companion_lane_state_beta']);
    const stores: PostgresSchedulerLaneStateStore[] = [];
    const connect = async (schema: string) => {
      const store = await PostgresSchedulerLaneStateStore.connect(url, { schema, now: () => 1 });
      stores.push(store);
      return store;
    };
    try {
      const alpha = await connect('companion_lane_state_alpha');
      await new DurableRestWindowPolicy(alpha).recordSilence({ lane: 'quiet_hours', nowMs: 0, durationMs: 60_000 });
      await alpha.extendSilence('quiet_hours', 10_000);
      await alpha.close();
      stores.pop();

      const alphaRestarted = await connect('companion_lane_state_alpha');
      const policy = new DurableRestWindowPolicy(alphaRestarted);
      await expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 30_000 })).resolves.toBe(true);
      await expect(policy.isSilenced({ lane: 'idle', nowMs: 30_000 })).resolves.toBe(false);
      await expect(policy.isSilenced({ lane: 'quiet_hours', nowMs: 60_000 })).resolves.toBe(false);
      await expect(alphaRestarted.readSilencedUntil('quiet_hours')).resolves.toBe(60_000);

      const beta = await connect('companion_lane_state_beta');
      await expect(beta.readSilencedUntil('quiet_hours')).resolves.toBeNull();
    } finally {
      await Promise.all(stores.map(store => store.close()));
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('persists world exploration invitation state across restart (orn69)', async () => {
    const url = await databaseUrl(['companion_world_state']);
    const first = await PostgresSchedulerLaneStateStore.connect(url, { schema: 'companion_world_state' });
    try {
      await expect(first.load()).resolves.toBeNull();
      await first.save({ lastInvitedAtMs: 1_000, dayKey: '2026-09-24', turnsToday: 1 });
      await first.save({ lastInvitedAtMs: 2_000, dayKey: '2026-09-24', turnsToday: 2 });
    } finally {
      await first.close();
    }
    const restarted = await PostgresSchedulerLaneStateStore.connect(url, { schema: 'companion_world_state' });
    try {
      await expect(restarted.load()).resolves.toEqual({ lastInvitedAtMs: 2_000, dayKey: '2026-09-24', turnsToday: 2 });
      await expect(restarted.save({ lastInvitedAtMs: 3_000, dayKey: 'tomorrow', turnsToday: 0 })).rejects.toThrow(/dayKey/);
    } finally {
      await restarted.close();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
