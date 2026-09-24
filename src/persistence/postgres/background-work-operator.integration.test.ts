import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createBackgroundWorkIdentity,
  fingerprintBackgroundWorkPayload,
  type MemoryExtractionBackgroundPayload,
} from '../../core/agent/background-work/types.js';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresBackgroundWorkStore } from './background-work-store.js';
import { listBackgroundWorkJobs, retireBackgroundWorkJobs } from './background-work-operator.js';

// Timeout-margin policy: see the registered "measured" entry for this file in
// src/test-support/integration-timeout-registry.json.
const TIMEOUT_MS = 120_000;

function input(channelId: string, turnId: string) {
  const payload: MemoryExtractionBackgroundPayload = {
    schemaVersion: 1,
    kind: 'memory_extraction',
    source: {
      schemaVersion: 1,
      logicalSessionId: channelId,
      channelId,
      turnId,
      requestId: `request-${turnId}`,
      turnRecordFingerprint: 'a'.repeat(64),
      createdAtMs: 100,
    },
  };
  return {
    ...createBackgroundWorkIdentity({ logicalSessionId: channelId, turnId, kind: payload.kind }),
    logicalSessionId: channelId,
    kind: payload.kind,
    payload,
    payloadFingerprint: fingerprintBackgroundWorkPayload(payload),
    sourceTurnId: turnId,
    sourceRequestId: `request-${turnId}`,
    sourceChannelId: channelId,
    createdAtMs: 100,
    maxAttempts: 3,
  };
}

describe('background-work operator surface (psfn-framework-gbwpq)', () => {
  let harness: PostgresTestHarness;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  }, TIMEOUT_MS);

  afterAll(async () => {
    await harness.stop();
  }, TIMEOUT_MS);

  it('lists by state and channel prefix, retires dry-run first, and never touches a live lease', async () => {
    const database = await harness.createDatabase();
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: 'companion_a' });
    const pool = createPostgresPool(database.databaseUrl, {
      applicationName: 'background-work-operator-test',
      allowExitOnIdle: true,
      max: 2,
      schema: 'companion_a',
    });
    try {
      await store.enqueue(input('hub-device:aaa', 'turn-1'));
      await store.enqueue(input('hub-device:bbb', 'turn-2'));
      await store.enqueue(input('discord:ccc', 'turn-3'));
      // A running job with a live lease, and one whose holder is gone.
      await pool.query(`
        UPDATE agent_background_work_jobs
        SET state = 'running', reason_code = 'started', lease_owner = 'agent-1',
            lease_expires_at_ms = CASE source_turn_id WHEN 'turn-1' THEN 10000 ELSE 500 END
        WHERE source_turn_id IN ('turn-1', 'turn-2')
      `);

      const hubJobs = await listBackgroundWorkJobs(pool, { channelPrefix: 'hub-device:', limit: 10 });
      expect(hubJobs.map(job => job.sourceTurnId)).toEqual(['turn-1', 'turn-2']);
      expect(hubJobs[0]).toMatchObject({ state: 'running', leaseOwner: 'agent-1', leaseExpiryCount: 0 });
      expect(await listBackgroundWorkJobs(pool, { states: ['queued'], limit: 10 }))
        .toHaveLength(1);
      // LIKE metacharacters in the prefix are literal.
      expect(await listBackgroundWorkJobs(pool, { channelPrefix: 'hub_device', limit: 10 })).toEqual([]);

      const dryRun = await retireBackgroundWorkJobs(pool, {
        channelPrefix: 'hub-device:', limit: 10, nowMs: 1_000, apply: false,
      });
      expect(dryRun.applied).toBe(false);
      expect(dryRun.retired.map(job => job.sourceTurnId)).toEqual(['turn-2']);
      expect(dryRun.skippedLiveLease.map(job => job.sourceTurnId)).toEqual(['turn-1']);
      expect((await listBackgroundWorkJobs(pool, { channelPrefix: 'hub-device:', limit: 10 }))
        .map(job => job.state)).toEqual(['running', 'running']);

      const applied = await retireBackgroundWorkJobs(pool, {
        channelPrefix: 'hub-device:', limit: 10, nowMs: 1_000, apply: true,
      });
      expect(applied.retired).toEqual([expect.objectContaining({
        sourceTurnId: 'turn-2', state: 'stale_discarded', reasonCode: 'operator_retired', leaseOwner: null,
      })]);
      expect((await listBackgroundWorkJobs(pool, { jobIds: [hubJobs[0]!.jobId], limit: 1 }))[0])
        .toMatchObject({ state: 'running', leaseOwner: 'agent-1' });
      expect(await listBackgroundWorkJobs(pool, { channelPrefix: 'discord:', limit: 10 }))
        .toEqual([expect.objectContaining({ state: 'queued' })]);

      await expect(retireBackgroundWorkJobs(pool, { limit: 10, nowMs: 1_000, apply: true }))
        .rejects.toThrow(/requires --job ids or a --channel-prefix/);
    } finally {
      await pool.end();
      await store.close();
    }
  }, TIMEOUT_MS);
});
