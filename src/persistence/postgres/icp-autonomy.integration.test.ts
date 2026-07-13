import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';

const TEST_IMAGE = 'postgres:16-alpine';
const TIMEOUT_MS = 120_000;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const ROOT_ID = '33333333-3333-4333-8333-333333333333';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const CHANNEL = `companion-dm:${A}:${B}`;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  return (await harness.createDatabase()).databaseUrl;
}

describe('ICP autonomy Postgres persistence', () => {
  it('isolates private candidates by companion schema and survives restart', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const storeA = await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
      schema: 'companion_a',
    });
    const storeB = await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
      schema: 'companion_b',
    });
    try {
      await storeA.createCandidate({
        candidateId: CANDIDATE_ID,
        rootInitiationId: ROOT_ID,
        localCompanionId: A,
        peerContactId: 'contact-artemis',
        peerCompanionId: B,
        preferredChannel: 'dm',
        source: 'weighted_thought',
        provenanceRef: 'weighted-thought:wt-42',
        reasonSummary: 'Private motivation that must never enter shared state.',
        createdAtMs: 10_000,
        expiresAtMs: 70_000,
        status: 'pending',
        revision: 1,
      });
      expect(await storeB.getCandidate(CANDIDATE_ID)).toBeNull();
    } finally {
      await storeA.close();
      await storeB.close();
    }

    const restarted = await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
      schema: 'companion_a',
    });
    try {
      expect((await restarted.getCandidate(CANDIDATE_ID))?.reasonSummary)
        .toContain('Private motivation');
    } finally {
      await restarted.close();
    }

    const pool = createPostgresPool(databaseUrl, { max: 1, allowExitOnIdle: true });
    try {
      const sharedColumns = await pool.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'shared'
          AND table_name IN (
            'icp_availability_leases', 'icp_conversation_episodes', 'icp_initiation_permits'
          )
      `);
      expect(sharedColumns.rows.map(row => row.column_name)).not.toContain('reason_summary');
      const privateColumn = await pool.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'companion_a'
          AND table_name = 'icp_initiation_candidates'
          AND column_name = 'reason_summary'
      `);
      expect(privateColumn.rows).toHaveLength(1);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('round-trips shared state and permits exactly one concurrent consumer', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const storeA = await PostgresIcpSharedAutonomyStore.connect(databaseUrl);
    const storeB = await PostgresIcpSharedAutonomyStore.connect(databaseUrl);
    try {
      await storeA.publishAvailability({
        companionId: B,
        state: 'open_to_chat',
        issuedAtMs: 1_000,
        expiresAtMs: 61_000,
        source: 'companion',
        revision: 1,
      });
      expect((await storeB.getAvailability(B))?.state).toBe('open_to_chat');
      await storeB.publishAvailability({
        companionId: B,
        state: 'busy',
        issuedAtMs: 2_000,
        expiresAtMs: 62_000,
        source: 'companion',
        revision: 2,
      });
      await expect(storeA.publishAvailability({
        companionId: B,
        state: 'available',
        issuedAtMs: 3_000,
        expiresAtMs: 63_000,
        source: 'companion',
        revision: 2,
      })).rejects.toThrow('revision conflict');

      await storeA.createEpisode({
        conversationId: CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'free_time',
        provenanceRef: 'free-time:block:17',
        openedAtMs: 10_000,
        lastActivityAtMs: 10_000,
        status: 'invited',
        revision: 1,
      });
      await storeA.issuePermit({
        permitId: PERMIT_ID,
        candidateId: CANDIDATE_ID,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        provenanceRef: 'free-time:block:17',
        issuedAtMs: 10_000,
        expiresAtMs: 70_000,
        status: 'issued',
        revision: 1,
      });

      const input = {
        permitId: PERMIT_ID,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        consumedAtMs: 11_000,
      };
      const results = await Promise.all([
        storeA.consumePermit(input),
        storeB.consumePermit(input),
      ]);
      expect(results.map(result => result.outcome).sort()).toEqual(['consumed', 'replayed']);
      expect((await storeA.getPermit(PERMIT_ID))?.status).toBe('consumed');

      const active = await storeB.transitionEpisode({
        conversationId: CONVERSATION_ID,
        expectedStatus: 'invited',
        expectedRevision: 1,
        status: 'active',
        lastActivityAtMs: 11_000,
      });
      expect(active.revision).toBe(2);
      await expect(storeA.transitionEpisode({
        conversationId: CONVERSATION_ID,
        expectedStatus: 'invited',
        expectedRevision: 1,
        status: 'declined',
        lastActivityAtMs: 11_000,
        closeReasonCode: 'conversation_declined',
      })).rejects.toThrow('transition conflict');
    } finally {
      await storeA.close();
      await storeB.close();
    }

    const restarted = await PostgresIcpSharedAutonomyStore.connect(databaseUrl);
    try {
      expect((await restarted.getEpisode(CONVERSATION_ID))?.status).toBe('active');
      expect((await restarted.getPermit(PERMIT_ID))?.status).toBe('consumed');
    } finally {
      await restarted.close();
    }
  }, TIMEOUT_MS);
});
