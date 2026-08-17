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

function settings(onDiskEnabled = true): AdminSettingsService {
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
            enabled: onDiskEnabled,
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
    saveSubConfigJson: vi.fn(async () => ({ ok: true, message: 'saved' })),
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
      costProjection: { available: true, unavailableReason: null },
      ...overrides,
    })),
    close: vi.fn(),
  };
}

describe('truthful quiet attribution (psfn-framework-hrmrq.34)', () => {
  it('attributes a disabled runtime to scheduler.json when the owner flag is off', async () => {
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(candidate()),
      projectionStore: projectionStore(sharedStore()),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(false),
      settingsService: settings(false),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });
    const data = await service.getData();
    expect(data.quietState).toBe('disabled');
    expect(data.quietExplanation).toContain('scheduler.json (icpAutonomy.enabled = false)');
    expect(data.quietExplanation).not.toContain('emergency-disabled');
  });

  it('attributes a disabled runtime to the emergency fence when scheduler.json is still enabled', async () => {
    const enablement = createIcpAutonomyRuntimeEnablement(true);
    enablement.disable();
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(candidate()),
      projectionStore: projectionStore(sharedStore()),
      runtimeEnablement: enablement,
      settingsService: settings(true),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });
    const data = await service.getData();
    expect(data.quietState).toBe('disabled');
    expect(data.quietExplanation).toContain('emergency-disabled');
    expect(data.quietExplanation).toContain('restart');
  });

  it('names the single-companion topology instead of claiming the process is disabled', async () => {
    const service = new AdminIcpAutonomyDataService({
      candidateStore: null,
      projectionStore: null,
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(true),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });
    const data = await service.getData();
    expect(data.available).toBe(false);
    expect(data.runtimeEnabled).toBe(true);
    expect(data.quietState).toBe('unavailable_topology');
    expect(data.quietExplanation).toContain('multi-companion');
    expect(data.quietExplanation).toContain('wired but empty');
  });

  it('names the missing sibling-contact seed when the candidate lane is empty with zero companion contacts', async () => {
    const candidates = candidateStore(candidate());
    vi.mocked(candidates.listCandidates).mockResolvedValue([]);
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(sharedStore(), { permits: [] }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(true),
      operatorLeaseTtlMs: 1_000,
      countCompanionPeerContacts: async () => 0,
      now: () => 2_000,
    });
    const data = await service.getData();
    expect(data.quietState).toBe('no_candidates');
    expect(data.companionPeerContactCount).toBe(0);
    expect(data.quietExplanation).toContain('seed:sibling-contacts');
    expect(data.quietExplanation).toContain("channel='companion'");
  });

  it('keeps the neutral no-candidates framing when sibling contacts exist', async () => {
    const candidates = candidateStore(candidate());
    vi.mocked(candidates.listCandidates).mockResolvedValue([]);
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(sharedStore(), { permits: [] }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(true),
      operatorLeaseTtlMs: 1_000,
      countCompanionPeerContacts: async () => 2,
      now: () => 2_000,
    });
    const data = await service.getData();
    expect(data.quietState).toBe('no_candidates');
    expect(data.companionPeerContactCount).toBe(2);
    expect(data.quietExplanation).toContain('quiet is not itself a failure');
  });
});

describe('AdminIcpAutonomyDataService', () => {
  it('projects bounded content-free felt-impulse funnel evidence', async () => {
    const projection = {
      totalQualified: 3,
      preCandidate: { noEligiblePeer: 1, notAuthorized: 1, throttled: 0 },
      candidateLinks: { total: 1, submitted: 1, deduped: 0 },
      candidateLifecycle: {
        pending: 0,
        permitted: 0,
        deferred: 0,
        declined: 0,
        rejected: 0,
        delivered: 1,
        suppressed: 0,
        expired: 0,
        cancelled: 0,
      },
      recent: [{
        correlationId: 'felt-impulse:would_message:1000',
        firstCrossingMs: 1_000,
        firedAtMs: 1_000,
        recordedAtMs: 1_001,
        outcome: 'candidate_linked' as const,
        candidateId: CANDIDATE_ID,
        candidateOutcome: 'submitted' as const,
        lifecycleOutcome: 'delivered' as const,
      }],
    };
    const readProjection = vi.fn(async () => projection);
    const service = new AdminIcpAutonomyDataService({
      feltImpulseFunnelStore: {
        getOutcome: vi.fn(),
        recordOutcome: vi.fn(),
        readProjection,
        close: vi.fn(),
      },
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
    });

    const data = await service.getData();

    expect(readProjection).toHaveBeenCalledWith(50);
    expect(data.feltImpulseFunnel).toEqual(projection);
    expect(JSON.stringify(data.feltImpulseFunnel)).not.toContain('private motivation');
    expect(JSON.stringify(data.feltImpulseFunnel)).not.toContain('peerContactId');
  });

  it('delegates operator test initiation to the model-independent runtime port', async () => {
    const expected = {
      outcome: 'accepted' as const,
      candidateId: CANDIDATE_ID,
      status: 'pending' as const,
      deliveryDisposition: 'pending' as const,
    };
    const trigger = vi.fn(async () => expected);
    const service = new AdminIcpAutonomyDataService({
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      testInitiation: { trigger },
    });

    await expect(service.triggerTestInitiation({
      peerCompanionId: PEER_ID,
      requestId: OTHER_ROOT,
    })).resolves.toEqual(expected);
    expect(trigger).toHaveBeenCalledWith({
      peerCompanionId: PEER_ID,
      requestId: OTHER_ROOT,
    });
  });

  it.each([
    'relation_contract_unavailable',
    'row_contract_invalid',
  ] as const)('keeps core data available while marking only costs unavailable: %s', async (
    unavailableReason,
  ) => {
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(candidate()),
      projectionStore: projectionStore(sharedStore(), {
        costProjection: {
          available: false,
          unavailableReason,
        },
      }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });

    const data = await service.getData();

    expect(data.available).toBe(true);
    expect(data.candidates).toHaveLength(1);
    expect(data.permits).toHaveLength(1);
    expect(data.costs).toEqual([]);
    expect(data.costProjection).toEqual({
      available: false,
      unavailableReason,
    });
    expect(data.quietState).toBe('active');
  });

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

describe('content-free delivery telemetry (psfn-framework-req4p.3)', () => {
  function consumedPermit(overrides: Partial<{
    status: 'consumed';
    consumedAtMs: number;
    candidateId: string;
  }> = {}): IcpAdminSharedProjection['permits'][number] {
    return {
      permitId: PERMIT_ID,
      candidateId: overrides.candidateId ?? CANDIDATE_ID,
      conversationId: CONVERSATION_ID,
      senderCompanionId: LOCAL_ID,
      recipientCompanionId: PEER_ID,
      channelId: `companion-dm:${LOCAL_ID}:${PEER_ID}`,
      provenanceRef: PROVENANCE,
      issuedAtMs: 1_000,
      expiresAtMs: 50_000,
      status: 'consumed',
      consumedAtMs: overrides.consumedAtMs ?? 3_000,
      revision: 5,
      ...overrides,
    };
  }

  it('exposes the content-free delivery disposition on a consumed candidate', async () => {
    const consumed = {
      ...candidate('consumed'),
      deliveryDisposition: 'delivered' as const,
    };
    const candidates = candidateStore(consumed);
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(sharedStore(), {
        availability: [{
          companionId: LOCAL_ID,
          state: 'available',
          issuedAtMs: 1_000,
          expiresAtMs: 50_000,
          source: 'runtime',
          revision: 1,
        }],
        permits: [consumedPermit({ consumedAtMs: 3_000 })],
      }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 4_000,
    });

    const data = await service.getData();

    expect(data.candidates[0].deliveryDisposition).toBe('delivered');
    expect(data.delivery.currentAvailability).toEqual({
      state: 'available',
      source: 'runtime',
      issuedAtMs: 1_000,
      expiresAtMs: 50_000,
      current: true,
    });
    expect(data.delivery.initiation).toEqual({
      invited: 0,
      delivered: 1,
      suppressed: 0,
      deferred: 0,
      declined: 0,
      failed: 0,
      expired: 0,
      cancelled: 0,
    });
    expect(data.delivery.recentOutcome).toEqual({
      kind: 'initiation',
      outcome: 'delivered',
      timestampMs: 3_000,
    });
  });

  it('distinguishes a suppressed (no message sent) consumed candidate from delivered', async () => {
    const suppressed = {
      ...candidate('consumed'),
      deliveryDisposition: 'suppressed' as const,
    };
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(suppressed),
      projectionStore: projectionStore(sharedStore(), {
        permits: [consumedPermit({ consumedAtMs: 3_000 })],
      }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 4_000,
    });

    const data = await service.getData();

    expect(data.delivery.initiation.delivered).toBe(0);
    expect(data.delivery.initiation.suppressed).toBe(1);
    expect(data.delivery.recentOutcome).toEqual({
      kind: 'initiation',
      outcome: 'suppressed',
      timestampMs: 3_000,
    });
  });

  it('maps every initiation lifecycle status to its own counter', async () => {
    const fixtures: Array<{ status: IcpInitiationCandidate['status']; key: string }> = [
      { status: 'pending', key: 'invited' },
      { status: 'permitted', key: 'invited' },
      { status: 'deferred', key: 'deferred' },
      { status: 'declined', key: 'declined' },
      { status: 'rejected', key: 'failed' },
      { status: 'expired', key: 'expired' },
      { status: 'cancelled', key: 'cancelled' },
    ];
    const list = fixtures.map((fixture, index) => ({
      ...candidate(fixture.status),
      candidateId: `${CANDIDATE_ID.slice(0, -1)}${index}`,
      rootInitiationId: `${CANDIDATE_ID.slice(0, -1)}${index}`,
      ...(fixture.status === 'permitted' ? { permitId: PERMIT_ID } : {}),
    }));
    const candidates = candidateStore(list[0]!);
    vi.mocked(candidates.listCandidates).mockResolvedValue(list);
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidates,
      projectionStore: projectionStore(sharedStore(), { permits: [] }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });

    const data = await service.getData();

    expect(data.delivery.initiation).toEqual({
      invited: 2,
      delivered: 0,
      suppressed: 0,
      deferred: 1,
      declined: 1,
      failed: 1,
      expired: 1,
      cancelled: 1,
    });
    // No consumed permits and no delivered/failed turns => no recent event.
    expect(data.delivery.recentOutcome).toBeNull();
  });

  it('aggregates message turn counts from fatigue and keeps the freshest event', async () => {
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(candidate()),
      projectionStore: projectionStore(sharedStore(), {
        permits: [consumedPermit({ consumedAtMs: 2_000 })],
        fatigue: [{
          conversationId: CONVERSATION_ID,
          rootInitiationId: CANDIDATE_ID,
          localCompanionId: LOCAL_ID,
          peerCompanionId: PEER_ID,
          channelId: `companion-dm:${LOCAL_ID}:${PEER_ID}`,
          chargedUnits: 2,
          overchargeUnits: 0,
          turnCount: 4,
          pendingCount: 1,
          deliveredCount: 2,
          failedCount: 1,
          latestReservedAtMs: 5_000,
        }],
      }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 6_000,
    });

    const data = await service.getData();

    expect(data.delivery.messages).toEqual({
      delivered: 2,
      pending: 1,
      failed: 1,
      observed: 4,
    });
    // The message reservation (5_000) is fresher than the initiation (2_000).
    expect(data.delivery.recentOutcome).toEqual({
      kind: 'message',
      outcome: 'delivered',
      timestampMs: 5_000,
    });
  });

  it('reports a stable empty/degraded telemetry block when the control plane is absent', async () => {
    const service = new AdminIcpAutonomyDataService({
      candidateStore: null,
      projectionStore: null,
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 2_000,
    });

    const data = await service.getData();

    expect(data.available).toBe(false);
    expect(data.delivery).toEqual({
      currentAvailability: null,
      initiation: {
        invited: 0,
        delivered: 0,
        suppressed: 0,
        deferred: 0,
        declined: 0,
        failed: 0,
        expired: 0,
        cancelled: 0,
      },
      messages: { delivered: 0, pending: 0, failed: 0, observed: 0 },
      recentOutcome: null,
    });
  });

  it('never leaks message body, channel id, contact identity, provenance text, or reason summary', async () => {
    const consumed = {
      ...candidate('consumed'),
      deliveryDisposition: 'delivered' as const,
    };
    const service = new AdminIcpAutonomyDataService({
      localCompanionId: LOCAL_ID,
      candidateStore: candidateStore(consumed),
      projectionStore: projectionStore(sharedStore(), {
        permits: [consumedPermit({ consumedAtMs: 3_000 })],
        fatigue: [{
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
          latestReservedAtMs: 3_500,
        }],
      }),
      runtimeEnablement: createIcpAutonomyRuntimeEnablement(true),
      settingsService: settings(),
      operatorLeaseTtlMs: 1_000,
      now: () => 4_000,
    });

    const data = await service.getData();
    const serialized = JSON.stringify(data.delivery);

    // The delivery block is content-free: it carries only counts, a
    // disposition enum, an outcome enum, and timestamps. No payload-derived
    // channel ids, contact ids, provenance handles, reason summaries, or
    // message bodies appear in it.
    expect(serialized).not.toContain('companion-dm');
    expect(serialized).not.toContain('private-contact');
    expect(serialized).not.toContain(PROVENANCE);
    expect(serialized).not.toContain('private motivation');
    expect(serialized).not.toContain(CANDIDATE_ID);
    expect(serialized).not.toContain(CONVERSATION_ID);
    expect(data.delivery.recentOutcome?.outcome).toBe('delivered');
  });
});
