// psfn-framework-fxt1 — real-Postgres proof that the gateway welfare grant
// verifier honors ONLY a genuinely welfare-escalated, running background-work
// row, scoped to the authenticated companion's schema (design §8 verification
// point 1: companion ownership is the per-companion Postgres schema). Runs the
// REAL background-work migrations so the table + columns match production; rows
// are seeded directly to pin the exact (welfare_claimed, state) the verifier
// discriminates on.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../persistence/postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresBackgroundWorkStore } from '../../persistence/postgres/background-work-store.js';
import {
  createWelfareGrantVerifier,
  type WelfareGrantVerifier,
} from './welfare-grant-verifier.js';

const SCHEMA_A = 'companion_a';
const SCHEMA_B = 'companion_b';
const COMPANION_A = 'companion-a-id';
const COMPANION_B = 'companion-b-id';

async function seedJob(
  pool: Pool,
  schema: string,
  input: { jobId: string; state: string; welfareClaimed: boolean },
): Promise<void> {
  const running = input.state === 'running';
  await pool.query(
    `INSERT INTO "${schema}".agent_background_work_jobs (
       job_id, idempotency_key, logical_session_id, kind, payload_schema_version,
       payload, payload_fingerprint, source_turn_id, source_request_id, source_channel_id,
       state, reason_code, attempt_count, max_attempts, created_at_ms, available_at_ms,
       updated_at_ms, lease_owner, lease_expires_at_ms, revision, welfare_claimed
     ) VALUES (
       $1, $1, $1, 'memory_extraction', 1,
       '{"schemaVersion":1}'::jsonb, 'fp', 'turn-1', 'req-1', 'chan-1',
       $2, 'started', 0, 3, 1, 1,
       1, $3, $4, 1, $5
     )`,
    [
      input.jobId,
      input.state,
      running ? 'owner-1' : null,
      running ? 9_999_999_999_999 : null,
      input.welfareClaimed,
    ],
  );
}

describe('PostgresWelfareGrantVerifier (fxt1, real Postgres)', () => {
  let harness: PostgresTestHarness;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  }, 120_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('verifies welfare grants scoped to the authenticated companion schema', async () => {
    const database = await harness.createDatabase();
    // Real migrations create agent_background_work_jobs inside each companion schema.
    const storeA = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: SCHEMA_A });
    const storeB = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: SCHEMA_B });

    const seedPool = createPostgresPool(database.databaseUrl, { applicationName: 'seed', max: 2 });
    let verifier: WelfareGrantVerifier | undefined;
    try {
      // Companion A's schema: a genuine welfare-claimed running job, plus foils.
      // (The schema's CHECK (state = 'running' OR welfare_claimed = false) makes a
      // welfare-claimed non-running row unrepresentable — the verify predicate's
      // state='running' clause is belt-and-suspenders, so the foils here are a
      // non-welfare running job and a plain queued job.)
      await seedJob(seedPool, SCHEMA_A, { jobId: 'a-welfare-running', state: 'running', welfareClaimed: true });
      await seedJob(seedPool, SCHEMA_A, { jobId: 'a-not-welfare', state: 'running', welfareClaimed: false });
      await seedJob(seedPool, SCHEMA_A, { jobId: 'a-plain-queued', state: 'queued', welfareClaimed: false });
      // Companion B's schema: a genuine welfare-claimed running job of its own.
      await seedJob(seedPool, SCHEMA_B, { jobId: 'b-welfare-running', state: 'running', welfareClaimed: true });

      verifier = createWelfareGrantVerifier({
        databaseUrl: database.databaseUrl,
        fleet: [
          { companionId: COMPANION_A, postgresSchema: SCHEMA_A },
          { companionId: COMPANION_B, postgresSchema: SCHEMA_B },
        ],
      });
      if (!verifier) throw new Error('verifier not constructed');

      // Genuine welfare escalation for the owning companion → honored.
      expect(await verifier.verify('a-welfare-running', COMPANION_A)).toBe(true);
      // Not welfare-claimed → stripped.
      expect(await verifier.verify('a-not-welfare', COMPANION_A)).toBe(false);
      // A plain (non-welfare) queued job → stripped.
      expect(await verifier.verify('a-plain-queued', COMPANION_A)).toBe(false);
      // Unknown job id → stripped.
      expect(await verifier.verify('does-not-exist', COMPANION_A)).toBe(false);
      // OWNERSHIP CLAUSE: companion A presenting companion B's genuinely
      // welfare-claimed running job id → not found under A's schema → stripped.
      expect(await verifier.verify('b-welfare-running', COMPANION_A)).toBe(false);
      // Companion B's own job verifies under B.
      expect(await verifier.verify('b-welfare-running', COMPANION_B)).toBe(true);
      // An unknown fleet companion has no schema to scope to → stripped.
      expect(await verifier.verify('a-welfare-running', 'stranger-companion')).toBe(false);
    } finally {
      await verifier?.close();
      await seedPool.end();
      await storeA.close();
      await storeB.close();
    }
  }, 120_000);

  it('single-companion scope resolves against the default search_path schema', async () => {
    const database = await harness.createDatabase();
    // No schema: the store migrates into the default (public) search_path, which
    // is exactly what a single-companion gateway verifier queries unqualified.
    const store = await PostgresBackgroundWorkStore.connect(database.databaseUrl);
    const seedPool = createPostgresPool(database.databaseUrl, { applicationName: 'seed', max: 2 });
    let verifier: WelfareGrantVerifier | undefined;
    try {
      await seedPool.query(
        `INSERT INTO agent_background_work_jobs (
           job_id, idempotency_key, logical_session_id, kind, payload_schema_version,
           payload, payload_fingerprint, source_turn_id, source_request_id, source_channel_id,
           state, reason_code, attempt_count, max_attempts, created_at_ms, available_at_ms,
           updated_at_ms, lease_owner, lease_expires_at_ms, revision, welfare_claimed
         ) VALUES (
           'solo-welfare', 'solo-welfare', 'session-1', 'memory_extraction', 1,
           '{"schemaVersion":1}'::jsonb, 'fp', 'turn-1', 'req-1', 'chan-1',
           'running', 'started', 0, 3, 1, 1,
           1, 'owner-1', 9999999999999, 1, true
         )`,
      );
      // Single-companion: any authenticated companion resolves to the one schema.
      verifier = createWelfareGrantVerifier({ databaseUrl: database.databaseUrl });
      if (!verifier) throw new Error('verifier not constructed');
      expect(await verifier.verify('solo-welfare', 'the-only-companion')).toBe(true);
      expect(await verifier.verify('missing', 'the-only-companion')).toBe(false);
    } finally {
      await verifier?.close();
      await seedPool.end();
      await store.close();
    }
  }, 120_000);
});
