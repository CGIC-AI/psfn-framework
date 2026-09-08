// psfn-framework-fxt1 / psfn-framework-h248l.7 — real-Postgres proof that the
// gateway welfare grant verifier honors ONLY a genuinely welfare-escalated,
// running background-work row owned by the authenticated companion. Runs the
// REAL background-work migrations so the table + columns match production; rows
// are seeded directly to pin the exact (welfare_claimed, state) the verifier
// discriminates on.
//
// A FLEET answers through each companion's own local authority: the store below
// stands in for the companion agent's process, reached over the same
// `welfare.grant.verify` contract the reverse-RPC channel carries. The gateway
// opens no sibling schema, so companion ownership is enforced by which store
// answers, not by a schema map the gateway holds.

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
  CompanionAuthorityWelfareGrantVerifier,
  createWelfareGrantVerifier,
  type WelfareGrantVerifier,
} from './welfare-grant-verifier.js';
import {
  WELFARE_GRANT_VERIFY_METHOD,
  parseWelfareGrantVerifyParams,
  type WelfareGrantVerifyResult,
} from './welfare-grant-contract.js';

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

describe('Welfare grant verification (fxt1 / h248l.7, real Postgres)', () => {
  let harness: PostgresTestHarness;

  beforeAll(async () => {
    harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  }, 120_000);

  afterAll(async () => {
    await harness.stop();
  });

  it('verifies fleet welfare grants through each companion\'s own local authority', async () => {
    const database = await harness.createDatabase();
    // Real migrations create agent_background_work_jobs inside each companion
    // schema. Each store IS that companion's local authority: the gateway never
    // touches either one.
    const storeA = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: SCHEMA_A });
    const storeB = await PostgresBackgroundWorkStore.connect(database.databaseUrl, { schema: SCHEMA_B });
    const storesByCompanionId = new Map([[COMPANION_A, storeA], [COMPANION_B, storeB]]);

    const seedPool = createPostgresPool(database.databaseUrl, { applicationName: 'seed', max: 2 });
    let verifier: WelfareGrantVerifier | undefined;
    const asked: Array<{ companionId: string; method: string }> = [];
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

      verifier = new CompanionAuthorityWelfareGrantVerifier({
        companionIds: new Set([COMPANION_A, COMPANION_B]),
        // Stands in for the reverse-RPC hop: the params and result cross the
        // real contract, and the answer comes from the addressed companion's
        // OWN store — exactly what the agent handler does in production.
        requestCompanionAgent: async (companionId, method, params): Promise<WelfareGrantVerifyResult> => {
          asked.push({ companionId, method });
          const request = parseWelfareGrantVerifyParams(params);
          const store = storesByCompanionId.get(companionId);
          if (!store) throw new Error(`No local authority for ${companionId}`);
          const job = await store.get(request.jobId);
          return {
            companionId: request.companionId,
            granted: job !== null && job.state === 'running' && job.welfareClaimed === true,
          };
        },
      });

      // Genuine welfare escalation for the owning companion → honored.
      expect(await verifier.verify('a-welfare-running', COMPANION_A)).toBe(true);
      // Not welfare-claimed → stripped.
      expect(await verifier.verify('a-not-welfare', COMPANION_A)).toBe(false);
      // A plain (non-welfare) queued job → stripped.
      expect(await verifier.verify('a-plain-queued', COMPANION_A)).toBe(false);
      // Unknown job id → stripped.
      expect(await verifier.verify('does-not-exist', COMPANION_A)).toBe(false);
      // OWNERSHIP CLAUSE: companion A presenting companion B's genuinely
      // welfare-claimed running job id → absent from A's own store → stripped.
      expect(await verifier.verify('b-welfare-running', COMPANION_A)).toBe(false);
      // Companion B's own job verifies under B.
      expect(await verifier.verify('b-welfare-running', COMPANION_B)).toBe(true);
      // An unknown fleet companion has no authority to ask → stripped, unasked.
      expect(await verifier.verify('a-welfare-running', 'stranger-companion')).toBe(false);

      // Every answered question went to the authenticated companion itself, and
      // the stranger was never broadcast to the fleet.
      expect(asked).toEqual([
        { companionId: COMPANION_A, method: WELFARE_GRANT_VERIFY_METHOD },
        { companionId: COMPANION_A, method: WELFARE_GRANT_VERIFY_METHOD },
        { companionId: COMPANION_A, method: WELFARE_GRANT_VERIFY_METHOD },
        { companionId: COMPANION_A, method: WELFARE_GRANT_VERIFY_METHOD },
        { companionId: COMPANION_A, method: WELFARE_GRANT_VERIFY_METHOD },
        { companionId: COMPANION_B, method: WELFARE_GRANT_VERIFY_METHOD },
      ]);
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
