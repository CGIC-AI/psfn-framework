import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool, executeQuery } from '../postgres.js';
import { PostgresIcpFleetHealthReader } from './icp-fleet-health-reader.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';
import { bootstrapSharedSchema } from './shared-schema.js';

const TIMEOUT_MS = 120_000;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OUTSIDE = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const NOW = 1_790_000_000_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

async function insertEpisode(
  pool: ReturnType<typeof createPostgresPool>,
  conversationId: string,
  participants: string[],
  status: string,
): Promise<void> {
  await executeQuery(pool, `
    INSERT INTO icp_conversation_episodes (
      conversation_id, channel_id, participant_companion_ids, root_initiation_id,
      initiated_by_companion_id, initiation_source, provenance_ref, opened_at_ms,
      last_activity_at_ms, status, revision
    ) VALUES ($1, 'companion-dm:test', $2::uuid[], $1, $3, 'free_time', 'icp-prov:test', $4, $4, $5, 1)
  `, [conversationId, participants, participants[0], NOW - 10_000, status]);
}

async function insertTurn(
  pool: ReturnType<typeof createPostgresPool>,
  turnId: string,
  conversationId: string,
  local: string,
  peer: string,
  outcome: string,
  finalizedAtMs: number | null,
): Promise<void> {
  await executeQuery(pool, `
    INSERT INTO icp_fatigue_turn_reservations (
      turn_id, conversation_id, root_initiation_id, local_companion_id, peer_companion_id,
      peer_contact_id, channel_id, decision, amount, reserved_at_ms, finalized_at_ms, outcome
    ) VALUES ($1, $2, $2, $3, $4, 'private-contact', 'companion-dm:test', 'charged', 1, $5, $6, $7)
  `, [turnId, conversationId, local, peer, (finalizedAtMs ?? NOW) - 1_000, finalizedAtMs, outcome]);
}

describe('Postgres ICP fleet health reader', () => {
  it('reads bounded, content-free coordination state for the requested roster', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const databaseUrl = (await harness.createDatabase()).databaseUrl;
    await bootstrapSharedSchema(databaseUrl);
    const store = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B, C],
    });
    const pool = createPostgresPool(databaseUrl, { schema: SHARED_SCHEMA_NAME });
    const reader = PostgresIcpFleetHealthReader.connect(databaseUrl);
    try {
      await store.publishAvailability({
        companionId: A, state: 'available', issuedAtMs: NOW - 1_000,
        expiresAtMs: NOW + 60_000, source: 'runtime', revision: 1,
      });
      await store.publishAvailability({
        companionId: B, state: 'resting', issuedAtMs: NOW - 120_000,
        expiresAtMs: NOW - 60_000, source: 'runtime', revision: 1,
      });
      await store.fenceLifecycleAdmission(C, NOW - 500);

      const e1 = '10000000-0000-4000-8000-000000000001';
      const e2 = '10000000-0000-4000-8000-000000000002';
      const e3 = '10000000-0000-4000-8000-000000000003';
      await insertEpisode(pool, e1, [A, B], 'active');
      await insertEpisode(pool, e2, [A, C], 'invited');
      await insertEpisode(pool, e3, [B, C], 'ended');
      await insertTurn(pool, '20000000-0000-4000-8000-000000000001', e1, A, B, 'delivered', NOW - 5_000);
      await insertTurn(pool, '20000000-0000-4000-8000-000000000002', e1, B, A, 'delivered', NOW - 4_000);
      await insertTurn(pool, '20000000-0000-4000-8000-000000000003', e1, A, B, 'pending', null);
      await insertTurn(pool, '20000000-0000-4000-8000-000000000004', e1, A, B, 'delivered', NOW - 90_000_000);
      await insertTurn(pool, '20000000-0000-4000-8000-000000000005', e2, A, OUTSIDE, 'delivered', NOW - 5_000);

      const read = await reader.read({
        companionIds: [C, B, A],
        nowMs: NOW,
        deliveredSinceMs: NOW - 86_400_000,
      });
      expect([...read.availability.entries()]).toEqual([
        [A, { state: 'available', expiresAtMs: NOW + 60_000 }],
      ]);
      expect([...read.lifecycleFenced]).toEqual([C]);
      // Only active episodes count as active channels; invited and ended do not.
      expect(read.openEpisodes.map(episode => [...episode.participantCompanionIds].sort()))
        .toEqual([[A, B]]);
      expect(read.openEpisodesTruncated).toBe(false);
      expect(read.pairVolume).toEqual([
        { firstCompanionId: A, secondCompanionId: B, deliveredTurns: 2 },
      ]);
      expect(JSON.stringify({ ...read, availability: [...read.availability] }))
        .not.toContain('private-contact');

      await expect(reader.read({ companionIds: [], nowMs: NOW, deliveredSinceMs: NOW }))
        .rejects.toThrow(/bounded non-empty/u);
      await expect(reader.read({ companionIds: [A], nowMs: NOW, deliveredSinceMs: NOW + 1 }))
        .rejects.toThrow(/ordered integer time window/u);
    } finally {
      await reader.close();
      await pool.end();
      await store.close();
    }
  }, TIMEOUT_MS);
});
