import { describe, expect, it, vi } from 'vitest';

import type {
  IcpInitiationCandidateStorePort,
  IcpSharedAutonomyStorePort,
} from '../../../core/icp/autonomy-store-ports.js';
import type { IcpInitiationCandidate } from '../../../core/icp/initiation-candidate.js';
import { createIcpAutonomyRuntimeEnablement } from '../../../core/icp/runtime-enablement.js';
import type {
  IcpAdminProjectionStore,
  IcpAdminSharedProjection,
} from '../../../persistence/postgres/icp-admin-projection-store.js';
import type { AdminSettingsService } from './types/settings.js';
import { AdminIcpAutonomyDataService } from './icp-autonomy-service.js';

const LOCAL_ID = '11111111-1111-4111-8111-111111111111';
const PEER_ID = '22222222-2222-4222-8222-222222222222';
const CANDIDATE_ID = '33333333-3333-4333-8333-333333333333';
const CONVERSATION_ID = '44444444-4444-4444-8444-444444444444';
const PERMIT_ID = '55555555-5555-4555-8555-555555555555';
const PROVENANCE = 'icp-prov:66666666-6666-4666-8666-666666666666';
const OTHER_B = '77777777-7777-4777-8777-777777777777';
const OTHER_C = '88888888-8888-4888-8888-888888888888';
const OTHER_CONVERSATION = '99999999-9999-4999-8999-999999999999';
const OTHER_ROOT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_CANDIDATE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const OTHER_PERMIT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const OTHER_PROVENANCE = 'icp-prov:dddddddd-dddd-4ddd-8ddd-dddddddddddd';

function candidate(status: IcpInitiationCandidate['status'] = 'pending'): IcpInitiationCandidate {
  return {
    candidateId: CANDIDATE_ID,
    rootInitiationId: CANDIDATE_ID,
    localCompanionId: LOCAL_ID,
    peerContactId: 'private-contact-id',
    peerCompanionId: PEER_ID,
    preferredChannel: 'dm',
    source: 'weighted_thought',
    provenanceRef: PROVENANCE,
    reasonSummary: 'private motivation must never leave the service',
    createdAtMs: 1_000,
    expiresAtMs: 50_000,
    status,
    ...(status === 'permitted' ? { permitId: PERMIT_ID } : {}),
    revision: 3,
  };
}

function settings(): AdminSettingsService {
  return {
    getSettingsData: vi.fn(async () => ({
      effectiveIcpAutonomy: {
        scheduler: {
          ownerFile: 'scheduler.json',
          effectiveValue: {
            enabled: true,
            candidate: { defaultTtlMs: 1, retryCadenceMs: 1, maxRetryAttempts: 1 },
            permit: { ttlMs: 1 },
            availability: { operatorLeaseTtlMs: 1_000 },
          },
          onDiskValue: {
            enabled: true,
            candidate: { defaultTtlMs: 1, retryCadenceMs: 1, maxRetryAttempts: 1 },
            permit: { ttlMs: 1 },
            availability: { operatorLeaseTtlMs: 1_000 },
          },
          restartRequired: false,
        },
        chargePolicy: {
          ownerFile: 'charge-policy.json',
          effectiveValue: null,
          onDiskValue: {} as never,
          restartRequired: false,
        },
      },
    }) as never),
    getSubConfigJson: vi.fn(() => JSON.stringify({ icpAutonomy: { enabled: true } })),
    saveSubConfigJson: vi.fn(() => ({ ok: true, message: 'saved' })),
  } as unknown as AdminSettingsService;
}

function candidateStore(value: IcpInitiationCandidate): IcpInitiationCandidateStorePort {
  return {
    createCandidate: vi.fn(),
    getCandidate: vi.fn(async () => value),
    getCandidateByPendingFollowUpId: vi.fn(),
    listCandidates: vi.fn(async () => [value]),
    transitionCandidate: vi.fn(async input => ({
      ...value,
      status: input.status,
      ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
      revision: value.revision + 1,
    })),
    close: vi.fn(),
  };
}

function sharedStore(order: string[] = []): IcpSharedAutonomyStorePort {
  return {
    getAvailability: vi.fn(async () => null),
    publishAvailabilityAndInvalidate: vi.fn(async lease => {
      order.push('invalidate');
      return { lease, revokedPermits: [] };
    }),
    getPermitByCandidate: vi.fn(async () => ({
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: LOCAL_ID,
      recipientCompanionId: PEER_ID,
      channelId: `companion:${LOCAL_ID}:${PEER_ID}`,
      provenanceRef: PROVENANCE,
      issuedAtMs: 1_000,
      expiresAtMs: 50_000,
      status: 'issued',
      revision: 2,
    })),
    revokePermit: vi.fn(async () => {
      order.push('revoke');
      return {} as never;
    }),
  } as unknown as IcpSharedAutonomyStorePort;
}

function projectionStore(
  shared: IcpSharedAutonomyStorePort,
  overrides: Partial<IcpAdminSharedProjection> = {},
): IcpAdminProjectionStore {
  return {
    localCompanionId: LOCAL_ID,
    shared,
    readProjection: vi.fn(async () => ({
      availability: [],
      episodes: [],
      permits: [{
        permitId: PERMIT_ID,
        candidateId: CANDIDATE_ID,
        conversationId: CONVERSATION_ID,
        senderCompanionId: LOCAL_ID,
        recipientCompanionId: PEER_ID,
        channelId: `companion:${LOCAL_ID}:${PEER_ID}`,
        provenanceRef: PROVENANCE,
        issuedAtMs: 1_000,
        expiresAtMs: 50_000,
        status: 'issued',
        revision: 2,
      }],
      fatigue: [],
      costs: [],
      ...overrides,
    })),
    close: vi.fn(),
  };
}

describe('AdminIcpAutonomyDataService', () => {
  it('returns bounded control-plane state without private motivation, contacts, or bearer permits', async () => {
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(candidate()),
      projectionStore: projectionStore(sharedStore()),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });

    const data = await service.getData();
    const serialized = JSON.stringify(data);
    expect(data.quietState).toBe('active');
    expect(data.permits[0]).not.toHaveProperty('permitId');
    expect(serialized).not.toContain('private motivation');
    expect(serialized).not.toContain('private-contact-id');
    expect(serialized).not.toContain(PERMIT_ID);
    expect(data.redaction).toEqual({
      privateMotivation: 'withheld',
      peerContactIds: 'withheld',
      permitBearerIds: 'withheld',
      transcripts: 'not_collected',
    });
  });

  it('excludes unrelated B-to-C tenant lifecycle, cost, reasons, and failures from local A', async () => {
    const candidates = candidateStore(candidate());
    vi.mocked(candidates.listCandidates).mockResolvedValue([
      candidate(),
      {
        ...candidate('rejected'),
        candidateId: OTHER_CANDIDATE,
        rootInitiationId: OTHER_ROOT,
        localCompanionId: OTHER_B,
        peerCompanionId: OTHER_C,
        peerContactId: 'unrelated-private-contact',
        provenanceRef: OTHER_PROVENANCE,
        reasonSummary: 'unrelated private motivation',
        reasonCode: 'delivery_failed',
      },
    ]);
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(sharedStore(), {
        availability: [
          {
            companionId: LOCAL_ID,
            state: 'available',
            issuedAtMs: 1_000,
            expiresAtMs: 50_000,
            source: 'runtime',
            revision: 1,
          },
          {
            companionId: OTHER_B,
            state: 'do_not_disturb',
            issuedAtMs: 1_000,
            expiresAtMs: 50_000,
            source: 'operator',
            revision: 9,
          },
        ],
        episodes: [
          {
            conversationId: CONVERSATION_ID,
            channelId: `companion-dm:${LOCAL_ID}:${PEER_ID}`,
            participantCompanionIds: [LOCAL_ID, PEER_ID],
            rootInitiationId: CANDIDATE_ID,
            initiatedByCompanionId: LOCAL_ID,
            initiationSource: 'weighted_thought',
            provenanceRef: PROVENANCE,
            openedAtMs: 1_000,
            lastActivityAtMs: 2_000,
            status: 'active',
            revision: 2,
          },
          {
            conversationId: OTHER_CONVERSATION,
            channelId: `companion-dm:${OTHER_B}:${OTHER_C}`,
            participantCompanionIds: [OTHER_B, OTHER_C],
            rootInitiationId: OTHER_ROOT,
            initiatedByCompanionId: OTHER_B,
            initiationSource: 'intention',
            provenanceRef: OTHER_PROVENANCE,
            openedAtMs: 4_000,
            lastActivityAtMs: 5_000,
            status: 'suppressed',
            closeReasonCode: 'delivery_failed',
            revision: 8,
          },
        ],
        permits: [
          {
            permitId: PERMIT_ID,
            candidateId: CANDIDATE_ID,
            conversationId: CONVERSATION_ID,
            senderCompanionId: LOCAL_ID,
            recipientCompanionId: PEER_ID,
            channelId: `companion-dm:${LOCAL_ID}:${PEER_ID}`,
            provenanceRef: PROVENANCE,
            issuedAtMs: 1_000,
            expiresAtMs: 50_000,
            status: 'issued',
            revision: 2,
          },
          {
            permitId: OTHER_PERMIT,
            candidateId: OTHER_CANDIDATE,
            conversationId: OTHER_CONVERSATION,
            senderCompanionId: OTHER_B,
            recipientCompanionId: OTHER_C,
            channelId: `companion-dm:${OTHER_B}:${OTHER_C}`,
            provenanceRef: OTHER_PROVENANCE,
            issuedAtMs: 4_000,
            expiresAtMs: 50_000,
            status: 'revoked',
            revokedAtMs: 5_000,
            reasonCode: 'delivery_failed',
            revision: 9,
          },
        ],
        fatigue: [
          {
            conversationId: CONVERSATION_ID,
            rootInitiationId: CANDIDATE_ID,
            localCompanionId: LOCAL_ID,
            peerCompanionId: PEER_ID,
            channelId: `companion-dm:${LOCAL_ID}:${PEER_ID}`,
            chargedUnits: 1,
            overchargeUnits: 0,
            turnCount: 1,
            pendingCount: 0,
            deliveredCount: 1,
            failedCount: 0,
            latestReservedAtMs: 2_000,
          },
          {
            conversationId: OTHER_CONVERSATION,
            rootInitiationId: OTHER_ROOT,
            localCompanionId: OTHER_B,
            peerCompanionId: OTHER_C,
            channelId: `companion-dm:${OTHER_B}:${OTHER_C}`,
            chargedUnits: 99,
            overchargeUnits: 99,
            turnCount: 99,
            pendingCount: 0,
            deliveredCount: 0,
            failedCount: 99,
            latestReservedAtMs: 5_000,
          },
        ],
        costs: [
          {
            conversationId: CONVERSATION_ID,
            rootInitiationId: CANDIDATE_ID,
            recordedAtMs: 2_000,
            actualCostUsd: 0.01,
            pendingProjectedCostUsd: 0,
            projectedTotalCostUsd: 0.01,
            warningThresholdUsd: 1,
            hardLimitUsd: 2,
            unknownCostAttemptCount: 0,
            allowed: true,
            reason: 'below_warning',
            participantCompanionIds: [LOCAL_ID, PEER_ID],
          },
          {
            conversationId: OTHER_CONVERSATION,
            rootInitiationId: OTHER_ROOT,
            recordedAtMs: 5_000,
            actualCostUsd: 99.99,
            pendingProjectedCostUsd: 99.99,
            projectedTotalCostUsd: 199.98,
            warningThresholdUsd: 1,
            hardLimitUsd: 2,
            unknownCostAttemptCount: 9,
            allowed: false,
            reason: 'hard_limit_exceeded',
            participantCompanionIds: [OTHER_B, OTHER_C],
          },
        ],
      }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 6_000,
    });

    const data = await service.getData();
    const serialized = JSON.stringify(data);
    expect(data.availability).toHaveLength(1);
    expect(data.candidates).toHaveLength(1);
    expect(data.episodes).toHaveLength(1);
    expect(data.permits).toHaveLength(1);
    expect(data.fatigue).toHaveLength(1);
    expect(data.costs).toHaveLength(1);
    expect(data.failureCount).toBe(0);
    expect(data.reasonCounts).toEqual([]);
    expect(data.quietState).toBe('active');
    expect(serialized).not.toContain(OTHER_C);
    expect(serialized).not.toContain(OTHER_CONVERSATION);
    expect(serialized).not.toContain(OTHER_PROVENANCE);
    expect(serialized).not.toContain('delivery_failed');
    expect(serialized).not.toContain('99.99');
  });

  it('revokes an issued permit before cancelling a permitted candidate', async () => {
    const order: string[] = [];
    const candidates = candidateStore(candidate('permitted'));
    vi.mocked(candidates.transitionCandidate).mockImplementation(async input => {
      order.push('candidate');
      return { ...candidate('permitted'), status: input.status, revision: 4 };
    });
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(sharedStore(order)),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });

    await expect(service.cancelCandidate({
      candidateId: CANDIDATE_ID,
      expectedRevision: 3,
    })).resolves.toMatchObject({ ok: true, revokedPermitCount: 1 });
    expect(order).toEqual(['revoke', 'candidate']);
  });

  it('can cancel a permitted candidate whose permit was already safely revoked by DND', async () => {
    const order: string[] = [];
    const shared = sharedStore(order);
    vi.mocked(shared.getPermitByCandidate).mockResolvedValue({
      permitId: PERMIT_ID,
      candidateId: CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: LOCAL_ID,
      recipientCompanionId: PEER_ID,
      channelId: `companion:${LOCAL_ID}:${PEER_ID}`,
      provenanceRef: PROVENANCE,
      issuedAtMs: 1_000,
      expiresAtMs: 50_000,
      status: 'revoked',
      revokedAtMs: 2_000,
      reasonCode: 'peer_do_not_disturb',
      revision: 3,
    });
    const candidates = candidateStore(candidate('permitted'));
    vi.mocked(candidates.transitionCandidate).mockImplementation(async input => {
      order.push('candidate');
      return { ...candidate('permitted'), status: input.status, revision: 4 };
    });
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(shared),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 3_000,
    });

    await expect(service.cancelCandidate({
      candidateId: CANDIDATE_ID,
      expectedRevision: 3,
    })).resolves.toMatchObject({ ok: true, revokedPermitCount: 0 });
    expect(order).toEqual(['candidate']);
  });

  it('publishes local operator DND through the invalidating store primitive', async () => {
    const shared = sharedStore();
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(candidate()),
      projectionStore: projectionStore(shared),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 5_000,
      now: () => 10_000,
    });

    await service.setDoNotDisturb();
    expect(shared.publishAvailabilityAndInvalidate).toHaveBeenCalledWith({
      companionId: LOCAL_ID,
      state: 'do_not_disturb',
      issuedAtMs: 10_000,
      expiresAtMs: 15_000,
      source: 'operator',
      revision: 1,
    }, 'peer_do_not_disturb');
  });

  it('emergency disable narrows live authority, invalidates permits, and persists owner enablement false', async () => {
    const runtimeEnablement = createIcpAutonomyRuntimeEnablement(true);
    const settingsService = settings();
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(candidate()),
      projectionStore: projectionStore(sharedStore()),
      runtimeEnablement,
      settingsService,
      operatorLeaseTtlMs: 5_000,
      now: () => 10_000,
    });

    await service.emergencyDisable();
    expect(runtimeEnablement.isEnabled()).toBe(false);
    const [, savedJson] = vi.mocked(settingsService.saveSubConfigJson).mock.calls[0]!;
    expect(JSON.parse(savedJson)).toEqual({ icpAutonomy: { enabled: false } });
  });

  it('fails closed on stale candidate revisions', async () => {
    const candidates = candidateStore(candidate());
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(sharedStore()),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
    });

    await expect(service.cancelCandidate({
      candidateId: CANDIDATE_ID,
      expectedRevision: 2,
    })).rejects.toThrow('revision conflict');
    expect(candidates.transitionCandidate).not.toHaveBeenCalled();
  });
});
