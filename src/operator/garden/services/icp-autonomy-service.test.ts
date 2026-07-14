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
