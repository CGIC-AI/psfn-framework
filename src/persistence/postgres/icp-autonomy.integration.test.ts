import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../postgres.js';
import { createPostgresContactStore } from '../../core/contacts/postgres-adapter.js';
import { ContactBlockListStore } from '../../core/cogsec/contact-block-list.js';
import { resolveContactBlockListPath } from '../layout.js';
import { toIcpInitiationCandidateSharedMetadata } from '../../core/icp/initiation-candidate.js';
import {
  IcpAutonomyInvalidationConflictError,
  IcpDyadLifecycleConflictError,
} from '../../core/icp/autonomy-store-ports.js';
import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import { GatewayIcpAutonomyBroker } from '../../boundary/gateway/icp-autonomy-broker.js';
import type { GatewayIcpInitiationPolicyAuthority } from '../../boundary/gateway/icp-initiation-policy-authority.js';
import { EventBus } from '../../shared/event-bus.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { PostgresIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';
import { POSTGRES_SHARED_MIGRATIONS, SHARED_SCHEMA_NAME } from './migrations.js';
import { bootstrapSharedSchema } from './shared-schema.js';

const TIMEOUT_MS = 120_000;
const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CANDIDATE_ID = '11111111-1111-4111-8111-111111111111';
const CONVERSATION_ID = '22222222-2222-4222-8222-222222222222';
const ROOT_ID = '33333333-3333-4333-8333-333333333333';
const PERMIT_ID = '44444444-4444-4444-8444-444444444444';
const SECOND_CONVERSATION_ID = '55555555-5555-4555-8555-555555555555';
const SECOND_PERMIT_ID = '66666666-6666-4666-8666-666666666666';
const SECOND_CANDIDATE_ID = '77777777-7777-4777-8777-777777777777';
const RACE_CONVERSATION_A = '88888888-8888-4888-8888-888888888888';
const RACE_CONVERSATION_B = '99999999-9999-4999-8999-999999999999';
const RACE_PERMIT_A = 'aaaaaaaa-1111-4111-8111-111111111111';
const RACE_PERMIT_B = 'bbbbbbbb-2222-4222-8222-222222222222';
const RACE_CANDIDATE_A = 'cccccccc-3333-4333-8333-333333333333';
const RACE_CANDIDATE_B = 'dddddddd-4444-4444-8444-444444444444';
const LIFECYCLE_DELIVERY_ID = 'eeeeeeee-5555-4555-8555-555555555555';
const OPERATOR_TEST_CONVERSATION_ID = 'ffffffff-6666-4666-8666-666666666666';
const ROOM_CONVERSATION_ID = '12121212-7777-4777-8777-777777777777';
const UNRELATED_CONVERSATION_ID = '23232323-8888-4888-8888-888888888888';
const UNRELATED_PERMIT_ID = '34343434-9999-4999-8999-999999999999';
const UNRELATED_CANDIDATE_ID = '45454545-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OPERATOR_TEST_PERMIT_ID = '56565656-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OPERATOR_TEST_CANDIDATE_ID = '67676767-cccc-4ccc-8ccc-cccccccccccc';
const LIFECYCLE_RACE_CONVERSATION_ID = '78787878-dddd-4ddd-8ddd-dddddddddddd';
const LIFECYCLE_RACE_PERMIT_ID = '89898989-eeee-4eee-8eee-eeeeeeeeeeee';
const LIFECYCLE_RACE_CANDIDATE_ID = '90909090-ffff-4fff-8fff-ffffffffffff';
const CHANNEL = `companion-dm:${A}:${B}`;
const CHANNEL_AC = `companion-dm:${A}:${C}`;
const PROVENANCE_HANDLE = `icp-prov:${CANDIDATE_ID}`;
const SECOND_PROVENANCE_HANDLE = `icp-prov:${SECOND_CANDIDATE_ID}`;
const ICP_INTEGRATION_FIXTURE_ACTOR = 'operator:icp-autonomy-integration';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  const databaseUrl = (await harness.createDatabase()).databaseUrl;
  await bootstrapSharedSchema(databaseUrl);
  return databaseUrl;
}

function deferred(): { reached: Promise<void>; release: () => void; wait: () => Promise<void> } {
  let markReached!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { markReached = resolve; });
  const released = new Promise<void>(resolve => { release = resolve; });
  return {
    reached,
    release,
    wait: async () => {
      markReached();
      await released;
    },
  };
}

describe('ICP autonomy Postgres persistence', () => {
  it('backfills valid legacy episodes into one dyad and rejects ambiguous ownership', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const installLegacySharedSchema = async (databaseUrl: string) => {
      const pool = createPostgresPool(databaseUrl, { max: 1, allowExitOnIdle: true });
      await pool.query(`CREATE SCHEMA ${SHARED_SCHEMA_NAME}`);
      await pool.query(`SET search_path TO ${SHARED_SCHEMA_NAME}`);
      const dyadMigrationIndex = POSTGRES_SHARED_MIGRATIONS.findIndex(statement =>
        statement.includes('ICP dyad backfill rejected ambiguous pair/channel ownership'));
      if (dyadMigrationIndex < 0) throw new Error('dyad migration boundary missing');
      for (const statement of POSTGRES_SHARED_MIGRATIONS.slice(0, dyadMigrationIndex)) {
        await pool.query(statement);
      }
      return { pool, dyadMigrationIndex };
    };

    const validUrl = (await harness.createDatabase()).databaseUrl;
    const valid = await installLegacySharedSchema(validUrl);
    try {
      await valid.pool.query(
        'CREATE TABLE transcript_sentinel (conversation_id UUID PRIMARY KEY, body TEXT NOT NULL)',
      );
      await valid.pool.query(`
        INSERT INTO icp_conversation_episodes (
          conversation_id, channel_id, participant_companion_ids, root_initiation_id,
          initiated_by_companion_id, initiation_source, provenance_ref, opened_at_ms,
          last_activity_at_ms, status, revision
        ) VALUES
          ($1, $3, ARRAY[$4::uuid, $5::uuid], $6, $4, 'foreground', $7, 1000, 1000, 'ended', 1),
          ($2, $3, ARRAY[$4::uuid, $5::uuid], $6, $5, 'foreground', $8, 2000, 2000, 'invited', 1)
      `, [
        CONVERSATION_ID,
        SECOND_CONVERSATION_ID,
        CHANNEL,
        A,
        B,
        ROOT_ID,
        PROVENANCE_HANDLE,
        SECOND_PROVENANCE_HANDLE,
      ]);
      await valid.pool.query(
        "INSERT INTO transcript_sentinel VALUES ($1, 'legacy transcript stays put')",
        [CONVERSATION_ID],
      );
      for (const statement of POSTGRES_SHARED_MIGRATIONS.slice(valid.dyadMigrationIndex)) {
        await valid.pool.query(statement);
      }
      const dyads = await valid.pool.query<{
        dyad_id: string;
        channel_id: string;
        provenance_conversation_ids: string[];
      }>('SELECT dyad_id, channel_id, provenance_conversation_ids FROM icp_dyads');
      expect(dyads.rows).toEqual([{
        dyad_id: CONVERSATION_ID,
        channel_id: CHANNEL,
        provenance_conversation_ids: [CONVERSATION_ID, SECOND_CONVERSATION_ID],
      }]);
      const links = await valid.pool.query<{ count: number }>(
        'SELECT count(DISTINCT dyad_id)::int AS count FROM icp_conversation_episodes',
      );
      expect(links.rows[0]?.count).toBe(1);
      await expect(valid.pool.query('SELECT body FROM transcript_sentinel'))
        .resolves.toMatchObject({ rows: [{ body: 'legacy transcript stays put' }] });
    } finally {
      await valid.pool.end();
    }

    const suppressedUrl = (await harness.createDatabase()).databaseUrl;
    const suppressed = await installLegacySharedSchema(suppressedUrl);
    try {
      await suppressed.pool.query(`
        INSERT INTO icp_conversation_episodes (
          conversation_id, channel_id, participant_companion_ids, root_initiation_id,
          initiated_by_companion_id, initiation_source, provenance_ref, opened_at_ms,
          last_activity_at_ms, status, close_reason_code, revision
        ) VALUES
          ($1, $3, ARRAY[$4::uuid, $5::uuid], $6, $4, 'foreground', $7,
            1000, 1000, 'ended', 'conversation_ended', 1),
          ($2, $3, ARRAY[$4::uuid, $5::uuid], $6, $4, 'foreground', $8,
            2000, 2000, 'suppressed', 'fatigue_exhausted', 1)
      `, [
        CONVERSATION_ID, SECOND_CONVERSATION_ID, CHANNEL, A, B, ROOT_ID,
        PROVENANCE_HANDLE, SECOND_PROVENANCE_HANDLE,
      ]);
      for (const statement of POSTGRES_SHARED_MIGRATIONS.slice(suppressed.dyadMigrationIndex)) {
        await suppressed.pool.query(statement);
      }
      await expect(suppressed.pool.query(`
        SELECT status, closed_at_ms::text, close_reason_code FROM icp_dyads
      `)).resolves.toMatchObject({ rows: [{
        status: 'open',
        closed_at_ms: null,
        close_reason_code: null,
      }] });
    } finally {
      await suppressed.pool.end();
    }

    const ambiguousUrl = (await harness.createDatabase()).databaseUrl;
    const ambiguous = await installLegacySharedSchema(ambiguousUrl);
    try {
      await ambiguous.pool.query(`
        INSERT INTO icp_conversation_episodes (
          conversation_id, channel_id, participant_companion_ids, root_initiation_id,
          initiated_by_companion_id, initiation_source, provenance_ref, opened_at_ms,
          last_activity_at_ms, status, revision
        ) VALUES ($1, $6, ARRAY[$2::uuid, $3::uuid], $4, $2,
          'foreground', $5, 1000, 1000, 'invited', 1)
      `, [CONVERSATION_ID, A, B, ROOT_ID, PROVENANCE_HANDLE, CHANNEL_AC]);
      await expect(ambiguous.pool.query(POSTGRES_SHARED_MIGRATIONS[ambiguous.dyadMigrationIndex]!))
        .rejects.toThrow('ambiguous pair/channel ownership');
      await expect(ambiguous.pool.query("SELECT to_regclass('icp_dyads')::text AS relation"))
        .resolves.toMatchObject({ rows: [{ relation: null }] });
    } finally {
      await ambiguous.pool.end();
    }
  }, TIMEOUT_MS);

  it('enforces operator over companion over runtime availability precedence', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const store = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    try {
      await store.publishAvailability({
        companionId: A,
        state: 'available',
        issuedAtMs: 1_000,
        expiresAtMs: 61_000,
        source: 'runtime',
        revision: 1,
      });
      await expect(store.publishAvailability({
        companionId: A,
        state: 'busy',
        issuedAtMs: 2_000,
        expiresAtMs: 62_000,
        source: 'companion',
        revision: 2,
      })).resolves.toMatchObject({ source: 'companion', state: 'busy', revision: 2 });
      await expect(store.publishAvailability({
        companionId: A,
        state: 'available',
        issuedAtMs: 3_000,
        expiresAtMs: 63_000,
        source: 'runtime',
        revision: 3,
      })).rejects.toThrow(/availability revision conflict/i);

      await expect(store.publishAvailability({
        companionId: A,
        state: 'do_not_disturb',
        issuedAtMs: 4_000,
        expiresAtMs: 64_000,
        source: 'operator',
        revision: 3,
      })).resolves.toMatchObject({ source: 'operator', state: 'do_not_disturb', revision: 3 });
      await expect(store.publishAvailability({
        companionId: A,
        state: 'open_to_chat',
        issuedAtMs: 5_000,
        expiresAtMs: 65_000,
        source: 'companion',
        revision: 4,
      })).rejects.toThrow(/availability revision conflict/i);
    } finally {
      await store.close();
    }
  });

  it('recovers open-dyad discovery and distinct continuation delivery outcomes after restart', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const first = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    await first.createEpisode({
      conversationId: CONVERSATION_ID,
      channelId: CHANNEL,
      participantCompanionIds: [A, B],
      rootInitiationId: ROOT_ID,
      initiatedByCompanionId: A,
      initiationSource: 'foreground',
      provenanceRef: PROVENANCE_HANDLE,
      openedAtMs: 1_000,
      lastActivityAtMs: 1_000,
      status: 'invited',
      revision: 1,
    });
    await first.createDyadContinuation({
      dyadId: CONVERSATION_ID,
      expectedLifecycleRevision: 1,
      episode: {
        conversationId: RACE_CONVERSATION_A,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: RACE_PERMIT_A,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: `icp-prov:${RACE_PERMIT_A}`,
        openedAtMs: 2_000,
        lastActivityAtMs: 2_000,
        status: 'invited',
        revision: 1,
      },
      delivery: {
        deliveryId: RACE_PERMIT_A,
        dyadId: CONVERSATION_ID,
        conversationId: RACE_CONVERSATION_A,
        senderCompanionId: A,
        recipientCompanionId: B,
        outcome: 'queued',
        createdAtMs: 2_000,
        updatedAtMs: 2_000,
        attempt: 0,
        dyadLifecycleRevision: 1,
        revision: 1,
      },
    });
    await first.transitionDyadDelivery({
      deliveryId: RACE_PERMIT_A,
      expectedOutcomes: ['queued'],
      outcome: 'failed',
      updatedAtMs: 2_100,
      attempt: 1,
      reasonCode: 'delivery_failed',
    });
    await first.transitionDyadDelivery({
      deliveryId: RACE_PERMIT_A,
      expectedOutcomes: ['failed'],
      outcome: 'retrying',
      updatedAtMs: 2_200,
      attempt: 2,
    });
    await first.close();

    const restarted = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    try {
      await expect(restarted.listDyadsForCompanion(A)).resolves.toEqual([
        expect.objectContaining({
          dyadId: CONVERSATION_ID,
          channelId: CHANNEL,
          status: 'open',
          provenanceConversationIds: [CONVERSATION_ID, RACE_CONVERSATION_A].sort(),
        }),
      ]);
      await expect(restarted.listDyadsForCompanion(C)).rejects.toThrow('Unknown ICP dyad owner');
      await expect(restarted.getLatestDyadDelivery(CONVERSATION_ID)).resolves.toMatchObject({
        deliveryId: RACE_PERMIT_A,
        outcome: 'retrying',
        attempt: 2,
      });
      await expect(restarted.transitionDyadDelivery({
        deliveryId: RACE_PERMIT_A,
        expectedOutcomes: ['retrying'],
        outcome: 'delivered',
        updatedAtMs: 2_300,
        attempt: 2,
        gatewayMessageId: 'companion-continuation-recovered',
      })).resolves.toMatchObject({
        outcome: 'delivered',
        gatewayMessageId: 'companion-continuation-recovered',
      });
    } finally {
      await restarted.close();
    }
  }, TIMEOUT_MS);

  it('persists bilateral lifecycle controls, fences stale work, and reopens only by consent permit', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const store = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B, C],
    });
    try {
      await store.createEpisode({
        conversationId: CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: PROVENANCE_HANDLE,
        openedAtMs: 1_000,
        lastActivityAtMs: 1_000,
        status: 'invited',
        revision: 1,
      });
      await store.createDyadContinuation({
        dyadId: CONVERSATION_ID,
        expectedLifecycleRevision: 1,
        episode: {
          conversationId: RACE_CONVERSATION_A,
          channelId: CHANNEL,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT_ID,
          initiatedByCompanionId: A,
          initiationSource: 'foreground',
          provenanceRef: `icp-prov:${RACE_CONVERSATION_A}`,
          openedAtMs: 2_000,
          lastActivityAtMs: 2_000,
          status: 'invited',
          revision: 1,
        },
        delivery: {
          deliveryId: LIFECYCLE_DELIVERY_ID,
          dyadId: CONVERSATION_ID,
          conversationId: RACE_CONVERSATION_A,
          senderCompanionId: A,
          recipientCompanionId: B,
          outcome: 'queued',
          createdAtMs: 2_000,
          updatedAtMs: 2_000,
          attempt: 0,
          dyadLifecycleRevision: 1,
          revision: 1,
        },
      });
      await store.createEpisodeAndIssuePermit({
        episode: {
          conversationId: UNRELATED_CONVERSATION_ID,
          channelId: CHANNEL_AC,
          participantCompanionIds: [A, C],
          rootInitiationId: UNRELATED_CANDIDATE_ID,
          initiatedByCompanionId: A,
          initiationSource: 'intention',
          provenanceRef: `icp-prov:${UNRELATED_CANDIDATE_ID}`,
          openedAtMs: 2_100,
          lastActivityAtMs: 2_100,
          status: 'invited',
          revision: 1,
        },
        permit: {
          permitId: UNRELATED_PERMIT_ID,
          candidateId: UNRELATED_CANDIDATE_ID,
          conversationId: UNRELATED_CONVERSATION_ID,
          senderCompanionId: A,
          recipientCompanionId: C,
          channelId: CHANNEL_AC,
          provenanceRef: `icp-prov:${UNRELATED_CANDIDATE_ID}`,
          issuedAtMs: 2_100,
          expiresAtMs: 50_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: await store.captureInvalidationFence(A, C),
      });
      await store.createEpisodeAndIssuePermit({
        episode: {
          conversationId: OPERATOR_TEST_CONVERSATION_ID,
          channelId: CHANNEL,
          participantCompanionIds: [A, B],
          rootInitiationId: OPERATOR_TEST_CANDIDATE_ID,
          initiatedByCompanionId: A,
          initiationSource: 'operator_test',
          provenanceRef: `icp-prov:${OPERATOR_TEST_CANDIDATE_ID}`,
          openedAtMs: 2_200,
          lastActivityAtMs: 2_200,
          status: 'invited',
          revision: 1,
        },
        permit: {
          permitId: OPERATOR_TEST_PERMIT_ID,
          candidateId: OPERATOR_TEST_CANDIDATE_ID,
          conversationId: OPERATOR_TEST_CONVERSATION_ID,
          senderCompanionId: A,
          recipientCompanionId: B,
          channelId: CHANNEL,
          provenanceRef: `icp-prov:${OPERATOR_TEST_CANDIDATE_ID}`,
          issuedAtMs: 2_200,
          expiresAtMs: 2_500,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: await store.captureInvalidationFence(A, B),
      });

      const paused = await store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: A,
        expectedRevision: 1,
        action: 'pause',
        transitionedAtMs: 3_000,
      });
      expect(paused).toMatchObject({
        dyad: { status: 'paused', lifecycleRevision: 2 },
        fencedDeliveries: [{ deliveryId: LIFECYCLE_DELIVERY_ID, outcome: 'suppressed' }],
      });
      await expect(store.getPermit(UNRELATED_PERMIT_ID)).resolves.toMatchObject({ status: 'issued' });
      await expect(store.getPermit(OPERATOR_TEST_PERMIT_ID))
        .resolves.toMatchObject({ status: 'issued' });
      await expect(store.createDyadContinuation({
        dyadId: CONVERSATION_ID,
        expectedLifecycleRevision: 1,
        episode: {
          conversationId: RACE_CONVERSATION_B,
          channelId: CHANNEL,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT_ID,
          initiatedByCompanionId: B,
          initiationSource: 'foreground',
          provenanceRef: `icp-prov:${RACE_CONVERSATION_B}`,
          openedAtMs: 3_100,
          lastActivityAtMs: 3_100,
          status: 'invited',
          revision: 1,
        },
        delivery: {
          deliveryId: RACE_PERMIT_B,
          dyadId: CONVERSATION_ID,
          conversationId: RACE_CONVERSATION_B,
          senderCompanionId: B,
          recipientCompanionId: A,
          outcome: 'queued',
          createdAtMs: 3_100,
          updatedAtMs: 3_100,
          attempt: 0,
          dyadLifecycleRevision: 1,
          revision: 1,
        },
      })).rejects.toThrow('requires an owned open dyad');

      await expect(store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: A,
        expectedRevision: 2,
        action: 'resume',
        transitionedAtMs: 4_000,
      })).resolves.toMatchObject({ dyad: { status: 'open', lifecycleRevision: 3 } });
      await expect(store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: B,
        expectedRevision: 3,
        action: 'close',
        transitionedAtMs: 5_000,
      })).resolves.toMatchObject({ dyad: { status: 'closed', lifecycleRevision: 4 } });
      await expect(store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: A,
        expectedRevision: 4,
        action: 'close',
        transitionedAtMs: 5_050,
      })).resolves.toMatchObject({ dyad: { status: 'closed', lifecycleRevision: 5 } });
      await expect(store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: A,
        expectedRevision: 5,
        action: 'block',
        transitionedAtMs: 5_100,
      })).resolves.toMatchObject({ dyad: { status: 'blocked', lifecycleRevision: 6 } });
      await expect(store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: B,
        expectedRevision: 6,
        action: 'block',
        transitionedAtMs: 5_110,
      })).resolves.toMatchObject({ dyad: { status: 'blocked', lifecycleRevision: 7 } });

      await store.createEpisodeAndIssuePermit({
        episode: {
          conversationId: RACE_CONVERSATION_B,
          channelId: CHANNEL,
          participantCompanionIds: [A, B],
          rootInitiationId: RACE_CANDIDATE_B,
          initiatedByCompanionId: A,
          initiationSource: 'intention',
          provenanceRef: `icp-prov:${RACE_CANDIDATE_B}`,
          openedAtMs: 5_120,
          lastActivityAtMs: 5_120,
          status: 'invited',
          revision: 1,
        },
        permit: {
          permitId: RACE_PERMIT_B,
          candidateId: RACE_CANDIDATE_B,
          conversationId: RACE_CONVERSATION_B,
          senderCompanionId: A,
          recipientCompanionId: B,
          channelId: CHANNEL,
          provenanceRef: `icp-prov:${RACE_CANDIDATE_B}`,
          issuedAtMs: 5_120,
          expiresAtMs: 50_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: await store.captureInvalidationFence(A, B),
      });
      await expect(store.consumePermit({
        permitId: RACE_PERMIT_B,
        conversationId: RACE_CONVERSATION_B,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        consumedAtMs: 5_130,
        expectedInvalidationFence: await store.captureInvalidationFence(A, B),
      })).rejects.toMatchObject({ reasonCode: 'dyad_blocked' });
      await expect(store.getPermit(RACE_PERMIT_B)).resolves.toMatchObject({ status: 'issued' });

      await expect(store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: A,
        expectedRevision: 7,
        action: 'unblock',
        transitionedAtMs: 5_200,
      })).resolves.toMatchObject({
        dyad: { status: 'blocked', lifecycleRevision: 8 },
        revokedPermits: [{ permitId: RACE_PERMIT_B, status: 'revoked' }],
      });
      await expect(store.transitionDyad({
        dyadId: CONVERSATION_ID,
        actorCompanionId: B,
        expectedRevision: 8,
        action: 'unblock',
        transitionedAtMs: 5_210,
      })).resolves.toMatchObject({ dyad: { status: 'closed', lifecycleRevision: 9 } });

      const reopenFence = await store.captureInvalidationFence(A, B);
      const reopen = await store.createEpisodeAndIssuePermit({
        episode: {
          conversationId: SECOND_CONVERSATION_ID,
          channelId: CHANNEL,
          participantCompanionIds: [A, B],
          rootInitiationId: SECOND_CANDIDATE_ID,
          initiatedByCompanionId: A,
          initiationSource: 'intention',
          provenanceRef: SECOND_PROVENANCE_HANDLE,
          openedAtMs: 6_000,
          lastActivityAtMs: 6_000,
          status: 'invited',
          revision: 1,
        },
        permit: {
          permitId: SECOND_PERMIT_ID,
          candidateId: SECOND_CANDIDATE_ID,
          conversationId: SECOND_CONVERSATION_ID,
          senderCompanionId: A,
          recipientCompanionId: B,
          channelId: CHANNEL,
          provenanceRef: SECOND_PROVENANCE_HANDLE,
          issuedAtMs: 6_000,
          expiresAtMs: 60_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: reopenFence,
      });
      expect(reopen.dyad).toMatchObject({ dyadId: CONVERSATION_ID, status: 'closed' });
      const consumeInput = {
        permitId: SECOND_PERMIT_ID,
        conversationId: SECOND_CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        consumedAtMs: 7_000,
        expectedInvalidationFence: await store.captureInvalidationFence(A, B),
      };
      await expect(store.consumePermit(consumeInput)).resolves.toMatchObject({
        outcome: 'consumed',
        permit: { status: 'consumed' },
      });
      await expect(store.consumePermit(consumeInput)).resolves.toMatchObject({ outcome: 'replayed' });
      await expect(store.getDyad(CONVERSATION_ID)).resolves.toMatchObject({
        dyadId: CONVERSATION_ID,
        channelId: CHANNEL,
        status: 'open',
        lifecycleRevision: 10,
      });

      await store.transitionEpisode({
        conversationId: SECOND_CONVERSATION_ID,
        expectedStatus: 'invited',
        expectedRevision: 1,
        expectedLastActivityAtMs: 6_000,
        status: 'ended',
        lastActivityAtMs: 7_100,
        closeReasonCode: 'conversation_ended',
      });
      await expect(store.getDyad(CONVERSATION_ID)).resolves.toMatchObject({ status: 'open' });

      await store.createEpisode({
        conversationId: ROOM_CONVERSATION_ID,
        channelId: 'companion-room:studio',
        participantCompanionIds: [A, B],
        rootInitiationId: ROOM_CONVERSATION_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: `icp-prov:${ROOM_CONVERSATION_ID}`,
        openedAtMs: 9_000,
        lastActivityAtMs: 9_000,
        status: 'invited',
        revision: 1,
      });
      const pool = createPostgresPool(databaseUrl, { schema: SHARED_SCHEMA_NAME, max: 1 });
      try {
        await expect(pool.query(`
          SELECT conversation_id FROM icp_conversation_episodes
          WHERE conversation_id IN ($1, $2) AND dyad_id IS NULL ORDER BY conversation_id
        `, [OPERATOR_TEST_CONVERSATION_ID, ROOM_CONVERSATION_ID])).resolves.toMatchObject({
          rowCount: 2,
        });
      } finally {
        await pool.end();
      }
    } finally {
      await store.close();
    }

    const restarted = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B, C],
    });
    try {
      await expect(restarted.getDyad(CONVERSATION_ID)).resolves.toMatchObject({
        status: 'open',
        lifecycleRevision: 10,
      });
    } finally {
      await restarted.close();
    }
  }, TIMEOUT_MS);

  it('serializes concurrent same-revision lifecycle transitions with a typed stale loser', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const first = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    const second = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    try {
      await first.createEpisode({
        conversationId: CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: PROVENANCE_HANDLE,
        openedAtMs: 1_000,
        lastActivityAtMs: 1_000,
        status: 'invited',
        revision: 1,
      });
      const settled = await Promise.allSettled([
        first.transitionDyad({
          dyadId: CONVERSATION_ID,
          actorCompanionId: A,
          expectedRevision: 1,
          action: 'pause',
          transitionedAtMs: 2_000,
        }),
        second.transitionDyad({
          dyadId: CONVERSATION_ID,
          actorCompanionId: B,
          expectedRevision: 1,
          action: 'close',
          transitionedAtMs: 2_000,
        }),
      ]);
      expect(settled.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = settled.find(result => result.status === 'rejected');
      expect(rejected).toMatchObject({
        status: 'rejected',
        reason: expect.objectContaining({ reasonCode: 'dyad_stale_revision' }),
      });
      if (rejected?.status === 'rejected') {
        expect(rejected.reason).toBeInstanceOf(IcpDyadLifecycleConflictError);
      }
      await expect(first.getDyad(CONVERSATION_ID)).resolves.toMatchObject({ lifecycleRevision: 2 });
    } finally {
      await first.close();
      await second.close();
    }
  }, TIMEOUT_MS);

  it('never leaves a pre-close consent permit issued across the lifecycle race', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const first = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    const second = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    try {
      await first.createEpisode({
        conversationId: CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: PROVENANCE_HANDLE,
        openedAtMs: 1_000,
        lastActivityAtMs: 1_000,
        status: 'invited',
        revision: 1,
      });
      const preCloseFence = await second.captureInvalidationFence(A, B);
      const results = await Promise.allSettled([
        first.transitionDyad({
          dyadId: CONVERSATION_ID,
          actorCompanionId: B,
          expectedRevision: 1,
          action: 'close',
          transitionedAtMs: 2_000,
        }),
        second.createEpisodeAndIssuePermit({
          episode: {
            conversationId: LIFECYCLE_RACE_CONVERSATION_ID,
            channelId: CHANNEL,
            participantCompanionIds: [A, B],
            rootInitiationId: LIFECYCLE_RACE_CANDIDATE_ID,
            initiatedByCompanionId: A,
            initiationSource: 'intention',
            provenanceRef: `icp-prov:${LIFECYCLE_RACE_CANDIDATE_ID}`,
            openedAtMs: 1_500,
            lastActivityAtMs: 1_500,
            status: 'invited',
            revision: 1,
          },
          permit: {
            permitId: LIFECYCLE_RACE_PERMIT_ID,
            candidateId: LIFECYCLE_RACE_CANDIDATE_ID,
            conversationId: LIFECYCLE_RACE_CONVERSATION_ID,
            senderCompanionId: A,
            recipientCompanionId: B,
            channelId: CHANNEL,
            provenanceRef: `icp-prov:${LIFECYCLE_RACE_CANDIDATE_ID}`,
            issuedAtMs: 1_500,
            expiresAtMs: 50_000,
            status: 'issued',
            revision: 1,
          },
          expectedInvalidationFence: preCloseFence,
        }),
      ]);
      expect(results[0]).toMatchObject({ status: 'fulfilled' });
      await expect(first.getDyad(CONVERSATION_ID)).resolves.toMatchObject({
        status: 'closed',
        lifecycleRevision: 2,
      });
      const permit = await first.getPermit(LIFECYCLE_RACE_PERMIT_ID);
      expect(permit === null || permit.status === 'revoked').toBe(true);
      if (results[1].status === 'rejected') {
        expect(results[1].reason).toMatchObject({ reasonCode: 'dyad_stale_revision' });
      }
    } finally {
      await first.close();
      await second.close();
    }
  }, TIMEOUT_MS);

  it('preserves a concurrent higher-authority choice while runtime availability is suppressed', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const runtimeStore = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    const companionStore = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    const broker = new GatewayIcpAutonomyBroker({
      store: runtimeStore,
      fleetCompanionIds: new Set([A, B]),
      isCompanionReady: () => true,
      readCompanionFatiguePosture: () => 'clear',
      hasRuntimeAvailabilityCapability: () => true,
      resolveInitiationChannel: async () => ({ ok: true }),
      policyAuthority: {
        resolve: async () => ({
          canonicalPeerContact: true,
          trustAllows: true,
          senderBlocksPeer: false,
          peerBlocksSender: false,
          provenanceFresh: true,
          recursiveMiOnlyRoot: false,
          socialPressureAllows: true,
          chargeAllows: true,
          fatigueAllows: true,
          costAllows: true,
        }),
        authorizeHandoff: async () => ({ eligible: true }),
        runAuthorizedHandoff: async <T>(_input: unknown, operation: () => Promise<T>) => ({
          decision: { eligible: true as const },
          result: await operation(),
        }),
      },
      eventBus: new EventBus(),
      alarm: () => undefined,
      now: () => 1_000,
    });
    try {
      await broker.refreshRuntimeAvailability(A, {
        state: 'available',
        expiresAtMs: 61_000,
      });
      await expect(runtimeStore.getAvailability(A)).resolves.toMatchObject({
        source: 'runtime',
        state: 'available',
        revision: 1,
      });

      const [suppressed, chosen] = await Promise.all([
        broker.clearRuntimeAvailability(A),
        companionStore.publishAvailability({
          companionId: A,
          state: 'open_to_chat',
          issuedAtMs: 2_000,
          expiresAtMs: 62_000,
          source: 'companion',
          revision: 2,
        }),
      ]);

      expect(suppressed).toMatchObject({ eligible: false });
      expect(chosen).toMatchObject({ source: 'companion', state: 'open_to_chat' });
      await expect(runtimeStore.getAvailability(A)).resolves.toMatchObject({
        source: 'companion',
        state: 'open_to_chat',
      });
    } finally {
      await runtimeStore.close();
      await companionStore.close();
    }
  });

  it('reconciles simultaneous identical-candidate permit issuance to one durable permit', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const knownCompanionIds = [A, B];
    const storeA = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const storeB = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    let arrivals = 0;
    let release!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const issueBarrier = async (): Promise<void> => {
      arrivals += 1;
      if (arrivals === 2) release();
      await released;
    };
    const gatedStore = (store: PostgresIcpSharedAutonomyStore): IcpSharedAutonomyStorePort => (
      new Proxy(store, {
        get(target, property) {
          if (property === 'createEpisodeAndIssuePermit') {
            return async (input: Parameters<IcpSharedAutonomyStorePort['createEpisodeAndIssuePermit']>[0]) => {
              await issueBarrier();
              return await target.createEpisodeAndIssuePermit(input);
            };
          }
          const value = Reflect.get(target, property);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      })
    );
    const eventBus = new EventBus();
    const lifecycleEvents: unknown[] = [];
    eventBus.on('icp.permit.lifecycle', event => lifecycleEvents.push(event));
    const openPolicy: Pick<
      GatewayIcpInitiationPolicyAuthority,
      'resolve' | 'authorizeHandoff' | 'runAuthorizedHandoff'
    > = {
      resolve: async () => ({
        canonicalPeerContact: true,
        trustAllows: true,
        senderBlocksPeer: false,
        peerBlocksSender: false,
        provenanceFresh: true,
        recursiveMiOnlyRoot: false,
        socialPressureAllows: true,
        chargeAllows: true,
        fatigueAllows: true,
        costAllows: true,
      }),
      authorizeHandoff: async () => ({ eligible: true as const }),
      runAuthorizedHandoff: async <T>(_input: unknown, operation: () => Promise<T>) => ({
        decision: { eligible: true as const },
        result: await operation(),
      }),
    };
    const makeBroker = (
      store: PostgresIcpSharedAutonomyStore,
      ids: string[],
    ): GatewayIcpAutonomyBroker => {
      const broker = new GatewayIcpAutonomyBroker({
        store: gatedStore(store),
        fleetCompanionIds: new Set(knownCompanionIds),
        isCompanionReady: () => true,
        readCompanionFatiguePosture: () => 'clear',
        hasRuntimeAvailabilityCapability: () => true,
        resolveInitiationChannel: async () => ({ ok: true }),
        policyAuthority: openPolicy,
        eventBus,
        alarm: () => undefined,
        now: () => 10_000,
        randomUuid: () => ids.shift()!,
      });
      for (const companionId of knownCompanionIds) {
        broker.markRuntimeAvailabilityActive(companionId);
      }
      return broker;
    };
    const brokerA = makeBroker(storeA, [RACE_CONVERSATION_A, RACE_PERMIT_A]);
    const brokerB = makeBroker(storeB, [RACE_CONVERSATION_B, RACE_PERMIT_B]);
    const input = {
      candidate: {
        candidateId: RACE_CANDIDATE_A,
        rootInitiationId: RACE_CANDIDATE_A,
        localCompanionId: A,
        peerCompanionId: B,
        preferredChannel: 'dm' as const,
        source: 'foreground' as const,
        provenanceRef: `icp-prov:${RACE_CANDIDATE_A}`,
        createdAtMs: 9_000,
        expiresAtMs: 70_000,
        status: 'pending' as const,
        revision: 1,
      },
      channelId: CHANNEL,
      permitExpiresAtMs: 70_000,
    };
    try {
      await storeA.publishAvailability({
        companionId: B,
        state: 'open_to_chat',
        issuedAtMs: 9_000,
        expiresAtMs: 70_000,
        source: 'companion',
        revision: 1,
      });

      const [first, second] = await Promise.all([
        brokerA.issuePermit(A, input),
        brokerB.issuePermit(A, input),
      ]);

      expect(first.decision).toEqual({ eligible: true });
      expect(second.decision).toEqual({ eligible: true });
      expect(first.permit).toBeDefined();
      expect(second.permit).toBeDefined();
      expect(first.permit?.permitId).toBe(second.permit?.permitId);
      expect(lifecycleEvents).toHaveLength(1);
      const episodes = await Promise.all([
        storeA.getEpisode(RACE_CONVERSATION_A),
        storeA.getEpisode(RACE_CONVERSATION_B),
      ]);
      expect(episodes.filter(Boolean)).toHaveLength(1);
    } finally {
      await storeA.close();
      await storeB.close();
    }
  }, TIMEOUT_MS);

  it('rejects stale issue and consume operations after durable invalidation advances', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const knownCompanionIds = [A, B];
    const storeA = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const storeB = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const issueInput = {
      episode: {
        conversationId: CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground' as const,
        provenanceRef: PROVENANCE_HANDLE,
        openedAtMs: 10_000,
        lastActivityAtMs: 10_000,
        status: 'invited' as const,
        revision: 1,
      },
      permit: {
        permitId: PERMIT_ID,
        candidateId: CANDIDATE_ID,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        provenanceRef: PROVENANCE_HANDLE,
        issuedAtMs: 10_000,
        expiresAtMs: 70_000,
        status: 'issued' as const,
        revision: 1,
      },
    };
    try {
      const staleIssueFence = await storeA.captureInvalidationFence(A, B);
      await storeB.revokeOutstandingPermitsForCompanion(B, 9_000, 'peer_do_not_disturb');
      await expect(storeA.createEpisodeAndIssuePermit({
        ...issueInput,
        expectedInvalidationFence: staleIssueFence,
      })).rejects.toBeInstanceOf(IcpAutonomyInvalidationConflictError);
      await expect(storeA.getEpisode(CONVERSATION_ID)).resolves.toBeNull();

      const issueFence = await storeA.captureInvalidationFence(A, B);
      await storeA.createEpisodeAndIssuePermit({
        ...issueInput,
        expectedInvalidationFence: issueFence,
      });
      const staleConsumeFence = await storeA.captureInvalidationFence(A, B);
      await storeB.revokeOutstandingPermitsForCompanion(A, 11_000, 'peer_blocked');
      await expect(storeA.consumePermit({
        permitId: PERMIT_ID,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        consumedAtMs: 12_000,
        expectedInvalidationFence: staleConsumeFence,
      })).resolves.toMatchObject({
        outcome: 'revoked',
        permit: { status: 'revoked', reasonCode: 'peer_blocked' },
      });
    } finally {
      await storeA.close();
      await storeB.close();
    }
  }, TIMEOUT_MS);

  it('commits restrictive publish and clear with fence advancement and revocation atomically', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const knownCompanionIds = [A, B];
    const storeA = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const storeB = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const blockerPool = createPostgresPool(databaseUrl, {
      schema: SHARED_SCHEMA_NAME,
      allowExitOnIdle: true,
      max: 1,
    });
    const blocker = await blockerPool.connect();
    const runWhileFenceLocked = async <T>(
      operation: () => Promise<T>,
      observeBeforeCommit: () => Promise<void>,
    ): Promise<T> => {
      await blocker.query('BEGIN');
      await blocker.query(`
        SELECT companion_id
        FROM icp_autonomy_invalidation_fences
        WHERE companion_id = $1
        FOR UPDATE
      `, [B]);
      const result = operation();
      let settled = false;
      void result.then(
        () => { settled = true; },
        () => { settled = true; },
      );
      try {
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(settled).toBe(false);
        await observeBeforeCommit();
      } finally {
        await blocker.query('COMMIT');
      }
      return await result;
    };
    try {
      await storeA.publishAvailability({
        companionId: B,
        state: 'open_to_chat',
        issuedAtMs: 1_000,
        expiresAtMs: 61_000,
        source: 'companion',
        revision: 1,
      });
      await storeA.createEpisode({
        conversationId: CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: PROVENANCE_HANDLE,
        openedAtMs: 10_000,
        lastActivityAtMs: 10_000,
        status: 'invited',
        revision: 1,
      });
      await expect(storeB.getDyadBetween(B, A)).resolves.toMatchObject({
        dyadId: CONVERSATION_ID,
        channelId: CHANNEL,
        status: 'open',
        provenanceConversationIds: [CONVERSATION_ID],
      });
      await storeA.issuePermit({
        permit: {
          permitId: PERMIT_ID,
          candidateId: CANDIDATE_ID,
          conversationId: CONVERSATION_ID,
          senderCompanionId: A,
          recipientCompanionId: B,
          channelId: CHANNEL,
          provenanceRef: PROVENANCE_HANDLE,
          issuedAtMs: 10_000,
          expiresAtMs: 70_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: await storeA.captureInvalidationFence(A, B),
      });

      const published = await runWhileFenceLocked(
        async () => await storeB.publishAvailabilityAndInvalidate({
          companionId: B,
          state: 'do_not_disturb',
          issuedAtMs: 11_000,
          expiresAtMs: 71_000,
          source: 'companion',
          revision: 2,
        }, 'peer_do_not_disturb'),
        async () => {
          await expect(storeA.getAvailability(B)).resolves.toMatchObject({
            state: 'open_to_chat',
            revision: 1,
          });
          await expect(storeA.getPermit(PERMIT_ID)).resolves.toMatchObject({ status: 'issued' });
        },
      );
      expect(published).toMatchObject({
        lease: { state: 'do_not_disturb', revision: 2 },
        revokedPermits: [{ permitId: PERMIT_ID, status: 'revoked' }],
      });
      await expect(storeA.getPermit(PERMIT_ID)).resolves.toMatchObject({
        status: 'revoked',
        reasonCode: 'peer_do_not_disturb',
      });

      await storeA.publishAvailability({
        companionId: B,
        state: 'open_to_chat',
        issuedAtMs: 12_000,
        expiresAtMs: 72_000,
        source: 'companion',
        revision: 3,
      });
      await storeA.createEpisode({
        conversationId: SECOND_CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: SECOND_PROVENANCE_HANDLE,
        openedAtMs: 20_000,
        lastActivityAtMs: 20_000,
        status: 'invited',
        revision: 1,
      });
      await expect(storeB.getDyadBetween(A, B)).resolves.toMatchObject({
        dyadId: CONVERSATION_ID,
        status: 'open',
        provenanceConversationIds: [CONVERSATION_ID, SECOND_CONVERSATION_ID],
      });
      await storeA.issuePermit({
        permit: {
          permitId: SECOND_PERMIT_ID,
          candidateId: SECOND_CANDIDATE_ID,
          conversationId: SECOND_CONVERSATION_ID,
          senderCompanionId: A,
          recipientCompanionId: B,
          channelId: CHANNEL,
          provenanceRef: SECOND_PROVENANCE_HANDLE,
          issuedAtMs: 20_000,
          expiresAtMs: 80_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: await storeA.captureInvalidationFence(A, B),
      });

      const fenceBeforeRejectedPublish = await storeA.captureInvalidationFence(A, B);
      await expect(storeB.publishAvailabilityAndInvalidate({
        companionId: B,
        state: 'do_not_disturb',
        issuedAtMs: 20_500,
        expiresAtMs: 80_500,
        source: 'companion',
        revision: 3,
      }, 'peer_do_not_disturb')).rejects.toThrow('revision conflict');
      await expect(storeA.captureInvalidationFence(A, B))
        .resolves.toEqual(fenceBeforeRejectedPublish);
      await expect(storeA.getAvailability(B)).resolves.toMatchObject({
        state: 'open_to_chat',
        revision: 3,
      });
      await expect(storeA.getPermit(SECOND_PERMIT_ID)).resolves.toMatchObject({ status: 'issued' });

      const cleared = await runWhileFenceLocked(
        async () => await storeB.clearAvailabilityAndInvalidate(
          B,
          3,
          { source: 'companion', nowMs: 21_000 },
          'availability_missing',
        ),
        async () => {
          await expect(storeA.getAvailability(B)).resolves.toMatchObject({
            state: 'open_to_chat',
            revision: 3,
          });
          await expect(storeA.getPermit(SECOND_PERMIT_ID)).resolves.toMatchObject({ status: 'issued' });
        },
      );
      expect(cleared).toMatchObject({
        cleared: true,
        revokedPermits: [{ permitId: SECOND_PERMIT_ID, status: 'revoked' }],
      });
      await expect(storeA.getAvailability(B)).resolves.toBeNull();
      await expect(storeA.getPermit(SECOND_PERMIT_ID)).resolves.toMatchObject({
        status: 'revoked',
        reasonCode: 'availability_missing',
      });
    } finally {
      blocker.release();
      await blockerPool.end();
      await storeA.close();
      await storeB.close();
    }
  }, TIMEOUT_MS);

  it('derives initiation policy from canonical companion owners and bilateral blocks', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const dataRoot = mkdtempSync(join(tmpdir(), 'psfn-icp-policy-'));
    const companionADataDir = join(dataRoot, 'a');
    const companionBDataDir = join(dataRoot, 'b');
    mkdirSync(companionADataDir, { recursive: true });
    mkdirSync(companionBDataDir, { recursive: true });
    const poolA = createPostgresPool(databaseUrl, {
      schema: 'companion_a',
      allowExitOnIdle: true,
    });
    const poolB = createPostgresPool(databaseUrl, {
      schema: 'companion_b',
      allowExitOnIdle: true,
    });
    const candidateStore = await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
      schema: 'companion_a',
    });
    const peerCandidateStore = await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
      schema: 'companion_b',
    });
    const contactsA = await createPostgresContactStore(databaseUrl, undefined, { pool: poolA });
    const contactsB = await createPostgresContactStore(databaseUrl, undefined, { pool: poolB });
    const nowMs = Date.now();
    const authority = new PostgresIcpInitiationPolicyAuthority(databaseUrl, {
      fleet: [
        { companionId: A, postgresSchema: 'companion_a', companionDataDir: companionADataDir },
        { companionId: B, postgresSchema: 'companion_b', companionDataDir: companionBDataDir },
      ],
      capacityAuthority: {
        resolve: async () => ({
          socialPressureAllows: true,
          chargeAllows: true,
          fatigueAllows: true,
          costAllows: true,
        }),
      },
      causalityAuthority: { isIndependentRoot: async () => true },
    });
    try {
      const peerForA = await contactsA.resolveChannelIdentity('companion', B, 'Companion B');
      const peerForB = await contactsB.resolveChannelIdentity('companion', A, 'Companion A');
      expect(await contactsA.setTrustLevel(
        peerForA.id,
        'trusted',
        ICP_INTEGRATION_FIXTURE_ACTOR,
      )).toBe(true);
      expect(await contactsB.setTrustLevel(
        peerForB.id,
        'trusted',
        ICP_INTEGRATION_FIXTURE_ACTOR,
      )).toBe(true);
      expect(await contactsA.setMachineIntelligence(
        peerForA.id,
        true,
        ICP_INTEGRATION_FIXTURE_ACTOR,
      )).toBe(true);
      expect(await contactsB.setMachineIntelligence(
        peerForB.id,
        true,
        ICP_INTEGRATION_FIXTURE_ACTOR,
      )).toBe(true);
      const privateCandidate = await candidateStore.createCandidate({
        candidateId: CANDIDATE_ID,
        rootInitiationId: ROOT_ID,
        localCompanionId: A,
        peerContactId: peerForA.id,
        peerCompanionId: B,
        preferredChannel: 'dm',
        source: 'weighted_thought',
        provenanceRef: PROVENANCE_HANDLE,
        reasonSummary: 'Private reason is never selected by the gateway authority.',
        createdAtMs: nowMs - 1_000,
        expiresAtMs: nowMs + 60_000,
        status: 'pending',
        revision: 1,
      });
      const sharedCandidate = toIcpInitiationCandidateSharedMetadata(privateCandidate);
      const open = await authority.resolve({
        senderCompanionId: A,
        candidate: sharedCandidate,
        channelId: CHANNEL,
        nowMs,
      });
      expect(open).toEqual({
        canonicalPeerContact: true,
        trustAllows: true,
        senderBlocksPeer: false,
        peerBlocksSender: false,
        provenanceFresh: true,
        recursiveMiOnlyRoot: false,
        socialPressureAllows: true,
        chargeAllows: true,
        fatigueAllows: true,
        costAllows: true,
      });
      const handoffPermit = {
        permitId: PERMIT_ID,
        candidateId: CANDIDATE_ID,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        provenanceRef: PROVENANCE_HANDLE,
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 30_000,
        status: 'issued' as const,
        revision: 1,
      };
      await expect(authority.authorizeHandoff({
        senderCompanionId: A,
        peerContactId: peerForA.id,
        permit: handoffPermit,
        nowMs,
      })).resolves.toEqual({ eligible: true });
      await expect(authority.authorizeHandoff({
        senderCompanionId: A,
        peerContactId: peerForB.id,
        permit: handoffPermit,
        nowMs,
      })).resolves.toEqual({ eligible: false, reasonCode: 'invalid_identity' });

      const assertMutationWaitsForAuthorization = async (
        mutate: () => Promise<unknown>,
        expectedDenial: 'invalid_identity' | 'policy_denied' | 'stale_provenance',
        restore: () => Promise<unknown>,
      ): Promise<void> => {
        const consumeGate = deferred();
        const authorized = authority.runAuthorizedHandoff({
          senderCompanionId: A,
          peerContactId: peerForA.id,
          permit: handoffPermit,
          nowMs,
        }, async () => {
          await consumeGate.wait();
          return 'permit-consumed';
        });
        await consumeGate.reached;
        let mutationSettled = false;
        const mutation = mutate().finally(() => { mutationSettled = true; });
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        expect(mutationSettled).toBe(false);
        consumeGate.release();
        await expect(authorized).resolves.toEqual({
          decision: { eligible: true },
          result: 'permit-consumed',
        });
        await mutation;
        await expect(authority.authorizeHandoff({
          senderCompanionId: A,
          peerContactId: peerForA.id,
          permit: handoffPermit,
          nowMs,
        })).resolves.toEqual({ eligible: false, reasonCode: expectedDenial });
        await restore();
      };

      await assertMutationWaitsForAuthorization(
        async () => await poolA.query(
          'UPDATE contacts SET trust_level = $1 WHERE id = $2',
          ['public', peerForA.id],
        ),
        'policy_denied',
        async () => await poolA.query(
          'UPDATE contacts SET trust_level = $1 WHERE id = $2',
          ['regular', peerForA.id],
        ),
      );
      await assertMutationWaitsForAuthorization(
        async () => await poolA.query(`
          UPDATE contact_channel_ids
          SET channel_user_id = $1
          WHERE contact_id = $2 AND channel = 'companion' AND channel_user_id = $3
        `, [C, peerForA.id, B]),
        'invalid_identity',
        async () => await poolA.query(`
          UPDATE contact_channel_ids
          SET channel_user_id = $1
          WHERE contact_id = $2 AND channel = 'companion' AND channel_user_id = $3
        `, [B, peerForA.id, C]),
      );

      const identityInserter = await poolA.connect();
      let identityInsertionOpen = false;
      try {
        await identityInserter.query('BEGIN');
        identityInsertionOpen = true;
        const observedAt = new Date(nowMs).toISOString();
        await identityInserter.query(`
          INSERT INTO contact_channel_ids (
            contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
          ) VALUES ($1, 'companion', $2, 'invite_only', $3, $3)
        `, [peerForA.id, C, observedAt]);

        let deliveryCount = 0;
        let authorizationSettled = false;
        const authorization = authority.runAuthorizedHandoff({
          senderCompanionId: A,
          peerContactId: peerForA.id,
          permit: handoffPermit,
          nowMs,
        }, async () => {
          deliveryCount += 1;
          return 'permit-consumed';
        });
        void authorization.then(
          () => { authorizationSettled = true; },
          () => { authorizationSettled = true; },
        );
        await new Promise<void>(resolve => setTimeout(resolve, 25));
        expect(authorizationSettled).toBe(false);

        await identityInserter.query('COMMIT');
        identityInsertionOpen = false;
        await expect(authorization).resolves.toEqual({
          decision: { eligible: false, reasonCode: 'invalid_identity' },
        });
        expect(deliveryCount).toBe(0);
        await expect(authority.authorizeHandoff({
          senderCompanionId: A,
          peerContactId: peerForA.id,
          permit: handoffPermit,
          nowMs,
        })).resolves.toEqual({ eligible: false, reasonCode: 'invalid_identity' });
      } finally {
        if (identityInsertionOpen) await identityInserter.query('ROLLBACK');
        identityInserter.release();
        await poolA.query(`
          DELETE FROM contact_channel_ids
          WHERE contact_id = $1 AND channel = 'companion' AND channel_user_id = $2
        `, [peerForA.id, C]);
      }

      await assertMutationWaitsForAuthorization(
        async () => await poolA.query(`
          UPDATE icp_initiation_candidates
          SET status = 'deferred', revision = revision + 1
          WHERE candidate_id = $1
        `, [CANDIDATE_ID]),
        'stale_provenance',
        async () => await poolA.query(`
          UPDATE icp_initiation_candidates
          SET status = 'pending', revision = revision + 1
          WHERE candidate_id = $1
        `, [CANDIDATE_ID]),
      );

      await poolA.query(`
        UPDATE icp_initiation_candidates
        SET status = 'consumed', revision = revision + 1
        WHERE candidate_id = $1
      `, [CANDIDATE_ID]);
      await expect(authority.authorizeHandoff({
        senderCompanionId: A,
        peerContactId: peerForA.id,
        permit: { ...handoffPermit, status: 'consumed', revision: 2 },
        nowMs,
      })).resolves.toEqual({ eligible: true });
      await expect(authority.authorizeHandoff({
        senderCompanionId: A,
        peerContactId: peerForA.id,
        permit: handoffPermit,
        nowMs,
      })).resolves.toEqual({ eligible: false, reasonCode: 'stale_provenance' });
      await poolA.query(`
        UPDATE icp_initiation_candidates
        SET status = 'pending', revision = revision + 1
        WHERE candidate_id = $1
      `, [CANDIDATE_ID]);

      new ContactBlockListStore(resolveContactBlockListPath(companionBDataDir)).block({
        channelType: 'companion',
        contactId: A,
        mode: 'hard',
        scope: 'dm',
        actor: { kind: 'companion', id: B },
      });
      await expect(authority.resolve({
        senderCompanionId: A,
        candidate: sharedCandidate,
        channelId: CHANNEL,
        nowMs,
      })).resolves.toMatchObject({ peerBlocksSender: true });
      await expect(authority.authorizeHandoff({
        senderCompanionId: A,
        peerContactId: peerForA.id,
        permit: handoffPermit,
        nowMs,
      })).resolves.toEqual({ eligible: false, reasonCode: 'peer_blocked' });

      const denyMissingOwners = new PostgresIcpInitiationPolicyAuthority(databaseUrl, {
        fleet: [
          { companionId: A, postgresSchema: 'companion_a', companionDataDir: companionADataDir },
          { companionId: B, postgresSchema: 'companion_b', companionDataDir: companionBDataDir },
        ],
      });
      try {
        await expect(denyMissingOwners.resolve({
          senderCompanionId: A,
          candidate: sharedCandidate,
          channelId: CHANNEL,
          nowMs,
        })).resolves.toMatchObject({
          recursiveMiOnlyRoot: true,
          socialPressureAllows: false,
          chargeAllows: false,
          fatigueAllows: false,
          costAllows: false,
        });
      } finally {
        await denyMissingOwners.close();
      }
    } finally {
      await authority.close();
      await candidateStore.close();
      await peerCandidateStore.close();
      await poolA.end();
      await poolB.end();
      rmSync(dataRoot, { recursive: true, force: true });
    }
  }, TIMEOUT_MS);

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
        peerContactId: 'contact-fixture-companion',
        peerCompanionId: B,
        preferredChannel: 'dm',
        source: 'weighted_thought',
        provenanceRef: PROVENANCE_HANDLE,
        reasonSummary: 'Private motivation that must never enter shared state.',
        continuationTaskKind: 'research',
        createdAtMs: 10_000,
        expiresAtMs: 70_000,
        status: 'pending',
        revision: 1,
      });
      expect(await storeB.getCandidate(CANDIDATE_ID)).toBeNull();
      await storeA.transitionCandidate({
        candidateId: CANDIDATE_ID,
        expectedStatus: 'pending',
        expectedRevision: 1,
        status: 'permitted',
        permitId: PERMIT_ID,
      });
    } finally {
      await storeA.close();
      await storeB.close();
    }

    const restarted = await PostgresIcpInitiationCandidateStore.connect(databaseUrl, {
      schema: 'companion_a',
    });
    try {
      expect(await restarted.getCandidate(CANDIDATE_ID)).toMatchObject({
        reasonSummary: expect.stringContaining('Private motivation'),
        continuationTaskKind: 'research',
        status: 'permitted',
        permitId: PERMIT_ID,
        revision: 2,
      });
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
      expect(sharedColumns.rows.map(row => row.column_name)).not.toContain('continuation_task_kind');
      const privateColumn = await pool.query<{ column_name: string }>(`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'companion_a'
          AND table_name = 'icp_initiation_candidates'
          AND column_name IN ('reason_summary', 'continuation_task_kind')
      `);
      expect(privateColumn.rows.map(row => row.column_name).sort()).toEqual([
        'continuation_task_kind',
        'reason_summary',
      ]);
    } finally {
      await pool.end();
    }
  }, TIMEOUT_MS);

  it('round-trips shared state and permits exactly one concurrent consumer', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const knownCompanionIds = [A, B];
    const storeA = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const storeB = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const invalidationPool = createPostgresPool(databaseUrl, {
      schema: SHARED_SCHEMA_NAME,
      allowExitOnIdle: true,
      max: 1,
    });
    const invalidator = await invalidationPool.connect();
    let invalidationOpen = false;
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
        provenanceRef: PROVENANCE_HANDLE,
        openedAtMs: 10_000,
        lastActivityAtMs: 10_000,
        status: 'invited',
        revision: 1,
      });
      const initialFence = await storeA.captureInvalidationFence(A, B);
      await storeA.issuePermit({
        permit: {
          permitId: PERMIT_ID,
          candidateId: CANDIDATE_ID,
          conversationId: CONVERSATION_ID,
          senderCompanionId: A,
          recipientCompanionId: B,
          channelId: CHANNEL,
          provenanceRef: PROVENANCE_HANDLE,
          issuedAtMs: 10_000,
          expiresAtMs: 70_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: initialFence,
      });

      const consumptionFence = await storeA.captureInvalidationFence(A, B);
      const input = {
        permitId: PERMIT_ID,
        conversationId: CONVERSATION_ID,
        senderCompanionId: A,
        recipientCompanionId: B,
        channelId: CHANNEL,
        consumedAtMs: 11_000,
        expectedInvalidationFence: consumptionFence,
      };
      const results = await Promise.all([
        storeA.consumePermit(input),
        storeB.consumePermit(input),
      ]);
      expect(results.map(result => result.outcome).sort()).toEqual(['consumed', 'replayed']);
      expect((await storeA.getPermit(PERMIT_ID))?.status).toBe('consumed');

      await invalidator.query('BEGIN');
      invalidationOpen = true;
      await invalidator.query(`
        UPDATE icp_autonomy_invalidation_fences
        SET generation = generation + 1,
            invalidated_at_ms = $2,
            last_reason_code = 'peer_blocked'
        WHERE companion_id = $1
      `, [A, 11_500]);
      let deliveryCount = 0;
      let recoverySettled = false;
      const recovery = (async () => {
        const result = await storeA.consumePermit(input);
        deliveryCount += 1;
        return result;
      })();
      void recovery.then(
        () => { recoverySettled = true; },
        () => { recoverySettled = true; },
      );
      await new Promise<void>(resolve => setTimeout(resolve, 25));
      expect(recoverySettled).toBe(false);
      await invalidator.query('COMMIT');
      invalidationOpen = false;
      await expect(recovery).rejects.toBeInstanceOf(IcpAutonomyInvalidationConflictError);
      expect(deliveryCount).toBe(0);

      const active = await storeB.transitionEpisode({
        conversationId: CONVERSATION_ID,
        expectedStatus: 'invited',
        expectedRevision: 1,
        expectedLastActivityAtMs: 10_000,
        status: 'active',
        lastActivityAtMs: 11_000,
      });
      expect(active.revision).toBe(2);
      await expect(storeA.transitionEpisode({
        conversationId: CONVERSATION_ID,
        expectedStatus: 'invited',
        expectedRevision: 1,
        expectedLastActivityAtMs: 10_000,
        status: 'declined',
        lastActivityAtMs: 11_000,
        closeReasonCode: 'conversation_declined',
      })).rejects.toThrow('transition conflict');

      await expect(storeA.transitionEpisode({
        conversationId: CONVERSATION_ID,
        expectedStatus: 'active',
        expectedRevision: 2,
        expectedLastActivityAtMs: 10_000,
        status: 'ended',
        lastActivityAtMs: 10_500,
        closeReasonCode: 'conversation_ended',
      })).rejects.toThrow('transition conflict');

      await storeA.createEpisode({
        conversationId: SECOND_CONVERSATION_ID,
        channelId: CHANNEL,
        participantCompanionIds: [A, B],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: SECOND_PROVENANCE_HANDLE,
        openedAtMs: 20_000,
        lastActivityAtMs: 20_000,
        status: 'invited',
        revision: 1,
      });
      await storeA.issuePermit({
        permit: {
          permitId: SECOND_PERMIT_ID,
          candidateId: SECOND_CANDIDATE_ID,
          conversationId: SECOND_CONVERSATION_ID,
          senderCompanionId: A,
          recipientCompanionId: B,
          channelId: CHANNEL,
          provenanceRef: SECOND_PROVENANCE_HANDLE,
          issuedAtMs: 20_000,
          expiresAtMs: 80_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: await storeA.captureInvalidationFence(A, B),
      });
      await expect(storeA.revokePermit(
        SECOND_PERMIT_ID,
        1,
        19_999,
        'operator_cancelled',
      )).rejects.toThrow('revocation conflict');
      const revoked = await storeA.revokePermit(
        SECOND_PERMIT_ID,
        1,
        20_001,
        'operator_cancelled',
      );
      expect(revoked.status).toBe('revoked');

      const raceInput = (
        conversationId: string,
        permitId: string,
        candidateId: string,
        senderCompanionId: string,
        recipientCompanionId: string,
        expectedInvalidationFence: Awaited<ReturnType<typeof storeA.captureInvalidationFence>>,
      ) => ({
        episode: {
          conversationId,
          channelId: CHANNEL,
          participantCompanionIds: [A, B],
          rootInitiationId: ROOT_ID,
          initiatedByCompanionId: senderCompanionId,
          initiationSource: 'foreground' as const,
          provenanceRef: `icp-prov:${candidateId}`,
          openedAtMs: 30_000,
          lastActivityAtMs: 30_000,
          status: 'invited' as const,
          revision: 1,
        },
        permit: {
          permitId,
          candidateId,
          conversationId,
          senderCompanionId,
          recipientCompanionId,
          channelId: CHANNEL,
          provenanceRef: `icp-prov:${candidateId}`,
          issuedAtMs: 30_000,
          expiresAtMs: 90_000,
          status: 'issued' as const,
          revision: 1,
        },
        expectedInvalidationFence,
      });
      const raceFence = await storeA.captureInvalidationFence(A, B);
      const permitRace = await Promise.allSettled([
        storeA.createEpisodeAndIssuePermit(raceInput(
          RACE_CONVERSATION_A,
          RACE_PERMIT_A,
          RACE_CANDIDATE_A,
          A,
          B,
          raceFence,
        )),
        storeB.createEpisodeAndIssuePermit(raceInput(
          RACE_CONVERSATION_B,
          RACE_PERMIT_B,
          RACE_CANDIDATE_B,
          B,
          A,
          raceFence,
        )),
      ]);
      expect(permitRace.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(permitRace.filter(result => result.status === 'rejected')).toHaveLength(1);
      const raceEpisodes = await Promise.all([
        storeA.getEpisode(RACE_CONVERSATION_A),
        storeA.getEpisode(RACE_CONVERSATION_B),
      ]);
      expect(raceEpisodes.filter(Boolean)).toHaveLength(1);
      const orderedDyad = await storeA.getDyadBetween(A, B);
      const reversedDyad = await storeB.getDyadBetween(B, A);
      expect(reversedDyad).toEqual(orderedDyad);
      expect(orderedDyad).toMatchObject({
        dyadId: CONVERSATION_ID,
        channelId: CHANNEL,
        status: 'open',
      });
      expect(orderedDyad?.provenanceConversationIds).toHaveLength(3);
      expect(orderedDyad?.provenanceConversationIds).toEqual(expect.arrayContaining([
        CONVERSATION_ID,
        SECOND_CONVERSATION_ID,
        (raceEpisodes.find(Boolean) as { conversationId: string }).conversationId,
      ]));
      expect(await storeA.findOutstandingPermitBetween(A, B, 31_000)).not.toBeNull();
      const invalidated = await storeB.revokeOutstandingPermitsForCompanion(
        B,
        31_000,
        'peer_offline',
      );
      expect(invalidated).toHaveLength(1);
      expect(invalidated[0]).toMatchObject({ status: 'revoked', reasonCode: 'peer_offline' });
    } finally {
      if (invalidationOpen) await invalidator.query('ROLLBACK');
      invalidator.release();
      await invalidationPool.end();
      await storeA.close();
      await storeB.close();
    }

    const restarted = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    try {
      await expect(restarted.getDyadBetween(B, A)).resolves.toMatchObject({
        dyadId: CONVERSATION_ID,
        channelId: CHANNEL,
        status: 'open',
      });
      expect((await restarted.getEpisode(CONVERSATION_ID))?.status).toBe('active');
      expect((await restarted.getPermit(PERMIT_ID))?.status).toBe('consumed');
      expect(await restarted.findOutstandingPermitBetween(A, B, 31_001)).toBeNull();
      const racePermits = await Promise.all([
        restarted.getPermit(RACE_PERMIT_A),
        restarted.getPermit(RACE_PERMIT_B),
      ]);
      expect(racePermits.filter(permit => permit?.status === 'revoked')).toHaveLength(1);
    } finally {
      await restarted.close();
    }
  }, TIMEOUT_MS);

  it('enforces operator lease precedence atomically and revokes permits after fleet removal', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const knownCompanionIds = [A, B, C];
    const storeA = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const storeB = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const fleetConversationId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const fleetPermitId = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
    const fleetCandidateId = '12121212-1212-4212-8212-121212121212';
    const fleetProvenanceHandle = `icp-prov:${fleetCandidateId}`;
    const fleetIssuedAtMs = Date.now();
    try {
      const sameRevisionRace = await Promise.allSettled([
        storeA.publishAvailability({
          companionId: A,
          state: 'open_to_chat',
          issuedAtMs: 5_000,
          expiresAtMs: 65_000,
          source: 'companion',
          revision: 1,
        }),
        storeB.publishAvailability({
          companionId: A,
          state: 'do_not_disturb',
          issuedAtMs: 5_001,
          expiresAtMs: 65_001,
          source: 'operator',
          revision: 1,
        }),
      ]);
      expect(sameRevisionRace[1]).toMatchObject({ status: 'fulfilled' });
      await expect(storeA.getAvailability(A)).resolves.toMatchObject({
        source: 'operator',
        state: 'do_not_disturb',
      });

      await storeA.publishAvailability({
        companionId: B,
        state: 'do_not_disturb',
        issuedAtMs: 10_000,
        expiresAtMs: 70_000,
        source: 'operator',
        revision: 1,
      });
      const companionMutations = await Promise.allSettled([
        storeA.publishAvailability({
          companionId: B,
          state: 'open_to_chat',
          issuedAtMs: 20_000,
          expiresAtMs: 80_000,
          source: 'companion',
          revision: 2,
        }),
        storeB.clearAvailability(B, 1, { source: 'companion', nowMs: 20_000 }),
      ]);
      expect(companionMutations[0]).toMatchObject({ status: 'rejected' });
      expect(companionMutations[1]).toEqual({ status: 'fulfilled', value: false });
      await expect(storeB.getAvailability(B)).resolves.toMatchObject({
        source: 'operator',
        state: 'do_not_disturb',
        revision: 1,
      });
      await expect(storeB.clearAvailability(B, 1, { source: 'operator', nowMs: 20_001 }))
        .resolves.toBe(true);

      await storeA.createEpisode({
        conversationId: fleetConversationId,
        channelId: CHANNEL_AC,
        participantCompanionIds: [A, C],
        rootInitiationId: ROOT_ID,
        initiatedByCompanionId: A,
        initiationSource: 'foreground',
        provenanceRef: fleetProvenanceHandle,
        openedAtMs: fleetIssuedAtMs,
        lastActivityAtMs: fleetIssuedAtMs,
        status: 'invited',
        revision: 1,
      });
      await storeA.issuePermit({
        permit: {
          permitId: fleetPermitId,
          candidateId: fleetCandidateId,
          conversationId: fleetConversationId,
          senderCompanionId: A,
          recipientCompanionId: C,
          channelId: CHANNEL_AC,
          provenanceRef: fleetProvenanceHandle,
          issuedAtMs: fleetIssuedAtMs,
          expiresAtMs: fleetIssuedAtMs + 60_000,
          status: 'issued',
          revision: 1,
        },
        expectedInvalidationFence: await storeA.captureInvalidationFence(A, C),
      });
    } finally {
      await storeA.close();
      await storeB.close();
    }

    const restartedAfterFleetRemoval = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, {
      knownCompanionIds: [A, B],
    });
    try {
      await expect(restartedAfterFleetRemoval.getPermit(fleetPermitId)).resolves.toMatchObject({
        status: 'revoked',
        reasonCode: 'unknown_participant',
        revision: 2,
      });
    } finally {
      await restartedAfterFleetRemoval.close();
    }
  }, TIMEOUT_MS);
});
