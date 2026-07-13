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
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';
import { PostgresIcpInitiationPolicyAuthority } from './icp-initiation-policy-authority.js';
import { PostgresIcpSharedAutonomyStore } from './icp-shared-autonomy-store.js';

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

describe('ICP autonomy Postgres persistence', () => {
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
    const knownCompanionIds = [A, B];
    const storeA = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
    const storeB = await PostgresIcpSharedAutonomyStore.connect(databaseUrl, { knownCompanionIds });
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
      await storeA.issuePermit({
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
      });
      const permitRace = await Promise.allSettled([
        storeA.createEpisodeAndIssuePermit(raceInput(
          RACE_CONVERSATION_A,
          RACE_PERMIT_A,
          RACE_CANDIDATE_A,
          A,
          B,
        )),
        storeB.createEpisodeAndIssuePermit(raceInput(
          RACE_CONVERSATION_B,
          RACE_PERMIT_B,
          RACE_CANDIDATE_B,
          B,
          A,
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
