import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  createIcpCandidateLifecycleSupervisor,
} from '../../core/icp/candidate-lifecycle-supervisor.js';
import { createIcpInitiationSourceRuntime } from '../../core/icp/initiation-source-runtime.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { PostgresIcpInitiationCandidateStore } from './icp-initiation-candidate-store.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const RETRY_CADENCE_MS = 5 * 60_000;
const LOCAL_COMPANION_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const PEER_COMPANION_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

function peers(delivery = vi.fn().mockResolvedValue({ disposition: 'delivered' as const })) {
  return {
    resolveKnownPeer: vi.fn().mockResolvedValue({
      contactId: 'peer-contact',
      displayName: 'Peer',
      peerCompanionId: PEER_COMPANION_ID,
    }),
    executeCompanionOutreach: delivery,
  };
}

describe('Postgres ICP candidate lifecycle supervisor', () => {
  it('claims a due deferred candidate after restart and delivers it when gates reopen', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const schema = 'companion_icp_supervisor_restart';
    let nowMs = Date.parse('2026-08-17T12:00:00.000Z');
    let store: PostgresIcpInitiationCandidateStore | null = null;
    const delivery = vi.fn().mockResolvedValue({ disposition: 'delivered' as const });
    const peerPort = peers(delivery);
    const preflight = vi.fn()
      .mockResolvedValueOnce({
        eligible: false as const,
        reasonCode: 'peer_busy' as const,
        reasonClass: 'deferrable' as const,
      })
      .mockResolvedValue({ eligible: true as const });
    const issuePermit = vi.fn().mockImplementation(async ({ candidate }) => ({
      decision: { eligible: true as const },
      permit: {
        permitId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        candidateId: candidate.candidateId,
        conversationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
        senderCompanionId: LOCAL_COMPANION_ID,
        recipientCompanionId: PEER_COMPANION_ID,
        channelId: `companion-dm:${LOCAL_COMPANION_ID}:${PEER_COMPANION_ID}`,
        provenanceRef: candidate.provenanceRef,
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
        status: 'issued' as const,
        revision: 1,
      },
    }));
    const createRuntime = (candidateStore: PostgresIcpInitiationCandidateStore) => (
      createIcpInitiationSourceRuntime({
        localCompanionId: LOCAL_COMPANION_ID,
        store: candidateStore,
        peers: peerPort,
        gateway: {
          companionInitiationPreflight: preflight,
          companionIssueInitiationPermit: issuePermit,
        },
        consent: { evaluate: vi.fn().mockResolvedValue({ action: 'send' as const }) },
        isExternalCompanionAuthorized: () => true,
        policy: {
          candidateDefaultTtlMs: 24 * 60 * 60_000,
          retryCadenceMs: RETRY_CADENCE_MS,
          maxRetryAttempts: 3,
          permitTtlMs: 5 * 60_000,
        },
        now: () => nowMs,
      })
    );

    try {
      store = await PostgresIcpInitiationCandidateStore.connect(database.databaseUrl, { schema });
      const first = await createRuntime(store).submit({
        source: 'foreground',
        peerContactId: 'peer-contact',
        preferredChannel: 'dm',
        sourceRecordId: 'restart-owned-candidate',
        reasonSummary: 'Resume this candidate without source resubmission.',
        cause: { kind: 'independent' },
      });
      expect(first).toMatchObject({ outcome: 'deferred', status: 'deferred' });

      await store.close();
      store = await PostgresIcpInitiationCandidateStore.connect(database.databaseUrl, { schema });
      nowMs += RETRY_CADENCE_MS;
      const runtime = createRuntime(store);
      const supervisor = createIcpCandidateLifecycleSupervisor({
        store,
        sourceRuntime: runtime,
        retryCadenceMs: RETRY_CADENCE_MS,
        claimLeaseMs: 60_000,
        batchSize: 10,
        now: () => nowMs,
      });

      await expect(supervisor.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
      await expect(store.getCandidate(first.candidateId)).resolves.toMatchObject({
        status: 'consumed',
        deliveryDisposition: 'delivered',
      });
      expect(preflight).toHaveBeenCalledTimes(2);
      expect(issuePermit).toHaveBeenCalledOnce();
      expect(delivery).toHaveBeenCalledOnce();
    } finally {
      if (store) await store.close();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('gives a due candidate to only one concurrent supervisor claim', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const schema = 'companion_icp_supervisor_claim';
    const nowMs = Date.now();
    const storeA = await PostgresIcpInitiationCandidateStore.connect(database.databaseUrl, { schema });
    const storeB = await PostgresIcpInitiationCandidateStore.connect(database.databaseUrl, { schema });
    try {
      await storeA.createCandidate({
        candidateId: '11111111-1111-4111-8111-111111111111',
        rootInitiationId: '11111111-1111-4111-8111-111111111111',
        localCompanionId: LOCAL_COMPANION_ID,
        peerContactId: 'peer-contact',
        peerCompanionId: PEER_COMPANION_ID,
        preferredChannel: 'dm',
        source: 'foreground',
        provenanceRef: 'icp-prov:11111111-1111-4111-8111-111111111111',
        reasonSummary: 'Claim this candidate exactly once.',
        createdAtMs: nowMs - 1_000,
        expiresAtMs: nowMs + 60_000,
        status: 'pending',
        revision: 1,
      });

      await expect(storeA.claimDueCandidates({
        nowMs,
        claimLeaseMs: 60_000,
        limit: 1,
      })).resolves.toEqual([]);
      await expect(storeA.transitionCandidate({
        candidateId: '11111111-1111-4111-8111-111111111111',
        expectedStatus: 'pending',
        expectedRevision: 1,
        status: 'rejected',
        reasonCode: 'policy_denied',
      })).resolves.toMatchObject({ status: 'rejected', revision: 2 });
      await storeA.createCandidate({
        candidateId: '33333333-3333-4333-8333-333333333333',
        rootInitiationId: '33333333-3333-4333-8333-333333333333',
        localCompanionId: LOCAL_COMPANION_ID,
        peerContactId: 'peer-contact',
        peerCompanionId: PEER_COMPANION_ID,
        preferredChannel: 'dm',
        source: 'foreground',
        provenanceRef: 'icp-prov:33333333-3333-4333-8333-333333333333',
        reasonSummary: 'Claim this stale pending candidate exactly once.',
        createdAtMs: nowMs - 60_001,
        expiresAtMs: nowMs + 60_000,
        status: 'pending',
        revision: 1,
      });

      const [claimsA, claimsB] = await Promise.all([
        storeA.claimDueCandidates({ nowMs, claimLeaseMs: 60_000, limit: 1 }),
        storeB.claimDueCandidates({ nowMs, claimLeaseMs: 60_000, limit: 1 }),
      ]);
      expect([...claimsA, ...claimsB]).toHaveLength(1);
      expect([...claimsA, ...claimsB][0]?.candidate).toMatchObject({
        candidateId: '33333333-3333-4333-8333-333333333333',
        status: 'pending',
        revision: 2,
      });
    } finally {
      await storeA.close();
      await storeB.close();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('expires stale work and cancels a repeatedly deferred candidate without source replay', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const schema = 'companion_icp_supervisor_terminal';
    let nowMs = Date.parse('2026-08-17T13:00:00.000Z');
    const store = await PostgresIcpInitiationCandidateStore.connect(database.databaseUrl, { schema });
    const preflight = vi.fn().mockResolvedValue({
      eligible: false as const,
      reasonCode: 'peer_busy' as const,
      reasonClass: 'deferrable' as const,
    });
    const peerPort = peers();
    const runtime = createIcpInitiationSourceRuntime({
      localCompanionId: LOCAL_COMPANION_ID,
      store,
      peers: peerPort,
      gateway: {
        companionInitiationPreflight: preflight,
        companionIssueInitiationPermit: vi.fn(),
      },
      consent: { evaluate: vi.fn() },
      isExternalCompanionAuthorized: () => true,
      policy: {
        candidateDefaultTtlMs: 24 * 60 * 60_000,
        retryCadenceMs: RETRY_CADENCE_MS,
        maxRetryAttempts: 3,
        permitTtlMs: 5 * 60_000,
      },
      now: () => nowMs,
    });
    const supervisor = createIcpCandidateLifecycleSupervisor({
      store,
      sourceRuntime: runtime,
      retryCadenceMs: RETRY_CADENCE_MS,
      claimLeaseMs: 60_000,
      batchSize: 10,
      now: () => nowMs,
    });
    try {
      await store.createCandidate({
        candidateId: '22222222-2222-4222-8222-222222222222',
        rootInitiationId: '22222222-2222-4222-8222-222222222222',
        localCompanionId: LOCAL_COMPANION_ID,
        peerContactId: 'peer-contact',
        peerCompanionId: PEER_COMPANION_ID,
        preferredChannel: 'dm',
        source: 'foreground',
        provenanceRef: 'icp-prov:22222222-2222-4222-8222-222222222222',
        reasonSummary: 'Expire this stale lifecycle row.',
        createdAtMs: nowMs - 2_000,
        expiresAtMs: nowMs - 1_000,
        status: 'pending',
        revision: 1,
      });
      await expect(supervisor.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
      await expect(store.getCandidate('22222222-2222-4222-8222-222222222222'))
        .resolves.toMatchObject({ status: 'expired', reasonCode: 'candidate_expired' });
      expect(preflight).not.toHaveBeenCalled();
      expect(peerPort.resolveKnownPeer).not.toHaveBeenCalled();

      const deferred = await runtime.submit({
        source: 'foreground',
        peerContactId: 'peer-contact',
        preferredChannel: 'dm',
        sourceRecordId: 'retry-to-terminal-cancellation',
        reasonSummary: 'Bound this retry lifecycle without source replay.',
        cause: { kind: 'independent' },
      });
      expect(deferred).toMatchObject({ status: 'deferred', retryEligibleAtMs: nowMs + RETRY_CADENCE_MS });
      for (let pass = 0; pass < 3; pass += 1) {
        nowMs += RETRY_CADENCE_MS;
        await expect(supervisor.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
      }
      await expect(store.getCandidate(deferred.candidateId)).resolves.toMatchObject({
        status: 'cancelled',
        reasonCode: 'peer_busy',
        retryAttempt: 3,
      });
      expect(preflight).toHaveBeenCalledTimes(4);
    } finally {
      await store.close();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('recovers a committed permit after a crash without issuing or consenting again', async () => {
    if (!harness) throw new Error('Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const schema = 'companion_icp_supervisor_permitted';
    const nowMs = Date.parse('2026-08-17T14:00:00.000Z');
    let store: PostgresIcpInitiationCandidateStore | null = null;
    const delivery = vi.fn()
      .mockRejectedValueOnce(new Error('injected crash after permit commit'))
      .mockResolvedValue({ disposition: 'delivered' as const });
    const peerPort = peers(delivery);
    const preflight = vi.fn().mockResolvedValue({ eligible: true as const });
    const consent = vi.fn().mockResolvedValue({ action: 'send' as const });
    const issuePermit = vi.fn().mockImplementation(async ({ candidate }) => ({
      decision: { eligible: true as const },
      permit: {
        permitId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        candidateId: candidate.candidateId,
        conversationId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
        senderCompanionId: LOCAL_COMPANION_ID,
        recipientCompanionId: PEER_COMPANION_ID,
        channelId: `companion-dm:${LOCAL_COMPANION_ID}:${PEER_COMPANION_ID}`,
        provenanceRef: candidate.provenanceRef,
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 60_000,
        status: 'issued' as const,
        revision: 1,
      },
    }));
    const createRuntime = (candidateStore: PostgresIcpInitiationCandidateStore) => (
      createIcpInitiationSourceRuntime({
        localCompanionId: LOCAL_COMPANION_ID,
        store: candidateStore,
        peers: peerPort,
        gateway: {
          companionInitiationPreflight: preflight,
          companionIssueInitiationPermit: issuePermit,
        },
        consent: { evaluate: consent },
        isExternalCompanionAuthorized: () => true,
        now: () => nowMs,
      })
    );
    try {
      store = await PostgresIcpInitiationCandidateStore.connect(database.databaseUrl, { schema });
      await expect(createRuntime(store).submit({
        source: 'foreground',
        peerContactId: 'peer-contact',
        preferredChannel: 'dm',
        sourceRecordId: 'permit-crash-recovery',
        reasonSummary: 'Recover this exact committed permit.',
        cause: { kind: 'independent' },
      })).rejects.toThrow('injected crash after permit commit');
      const [permitted] = await store.listCandidates();
      expect(permitted).toMatchObject({ status: 'permitted' });

      await store.close();
      store = await PostgresIcpInitiationCandidateStore.connect(database.databaseUrl, { schema });
      const supervisor = createIcpCandidateLifecycleSupervisor({
        store,
        sourceRuntime: createRuntime(store),
        retryCadenceMs: RETRY_CADENCE_MS,
        claimLeaseMs: 60_000,
        batchSize: 10,
        now: () => nowMs,
      });
      await expect(supervisor.runOnce()).resolves.toEqual({ claimed: 1, completed: 1, failed: 0 });
      await expect(store.getCandidate(permitted!.candidateId)).resolves.toMatchObject({
        status: 'consumed',
        deliveryDisposition: 'delivered',
      });
      expect(preflight).toHaveBeenCalledOnce();
      expect(consent).toHaveBeenCalledOnce();
      expect(issuePermit).toHaveBeenCalledOnce();
      expect(delivery).toHaveBeenCalledTimes(2);
    } finally {
      if (store) await store.close();
    }
  }, INTEGRATION_TIMEOUT_MS);
});
