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
import { IcpAutonomyInvalidationConflictError } from '../../core/icp/autonomy-store-ports.js';
import type { IcpSharedAutonomyStorePort } from '../../core/icp/autonomy-store-ports.js';
import { GatewayIcpAutonomyBroker } from '../../boundary/gateway/icp-autonomy-broker.js';
import type { GatewayIcpInitiationPolicyAuthority } from '../../boundary/gateway/icp-initiation-policy-authority.js';
import { EventBus } from '../../shared/event-bus.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { PostgresIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';
import { SHARED_SCHEMA_NAME } from './migrations.js';

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
const CHANNEL = `companion-dm:${A}:${B}`;
const CHANNEL_AC = `companion-dm:${A}:${C}`;
const PROVENANCE_HANDLE = `icp-prov:${CANDIDATE_ID}`;
const SECOND_PROVENANCE_HANDLE = `icp-prov:${SECOND_CANDIDATE_ID}`;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is unavailable');
  return (await harness.createDatabase()).databaseUrl;
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
        quietHours: false,
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
    ): GatewayIcpAutonomyBroker => new GatewayIcpAutonomyBroker({
      store: gatedStore(store),
      fleetCompanionIds: new Set(knownCompanionIds),
      isCompanionReady: () => true,
      resolveInitiationChannel: async () => ({ ok: true }),
      policyAuthority: openPolicy,
      eventBus,
      alarm: () => undefined,
      now: () => 10_000,
      randomUuid: () => ids.shift()!,
    });
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
      quietHours: {
        enabled: false,
        startLocalTime: '22:00',
        endLocalTime: '07:00',
        timeZone: 'UTC',
      },
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
      await contactsA.setMachineIntelligence(peerForA.id, true, 'test');
      await contactsB.setMachineIntelligence(peerForB.id, true, 'test');
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
        quietHours: false,
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
        quietHours: {
          enabled: false,
          startLocalTime: '22:00',
          endLocalTime: '07:00',
          timeZone: 'UTC',
        },
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
        peerContactId: 'contact-artemis',
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
