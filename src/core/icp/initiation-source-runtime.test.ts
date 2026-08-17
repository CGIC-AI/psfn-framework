import { describe, expect, it, vi } from 'vitest';

import type {
  IcpInitiationCandidateStorePort,
  IcpInitiationCandidateTransitionInput,
} from './autonomy-store-ports.js';
import type {
  IcpInitiationCandidate,
  IcpInitiationCandidateStatus,
} from './initiation-candidate.js';
import {
  createIcpInitiationSourceRuntime,
  ICP_INITIATION_RETRY_COOLDOWN_MS,
  MAX_ICP_INITIATION_RETRY_ATTEMPTS,
  type IcpInitiationConsentEvaluator,
  type IcpInitiationSourceRuntimeDependencies,
} from './initiation-source-runtime.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const OTHER_PEER = '66666666-6666-4666-8666-666666666666';

function createStore(): IcpInitiationCandidateStorePort {
  const rows = new Map<string, IcpInitiationCandidate>();
  return {
    async createCandidate(candidate) {
      if (rows.has(candidate.candidateId)) throw new Error('duplicate candidate');
      rows.set(candidate.candidateId, structuredClone(candidate));
      return structuredClone(candidate);
    },
    async getCandidate(candidateId) {
      const row = rows.get(candidateId);
      return row ? structuredClone(row) : null;
    },
    async getCandidateByPendingFollowUpId(pendingFollowUpId) {
      const row = [...rows.values()].find(
        candidate => candidate.pendingFollowUpId === pendingFollowUpId,
      );
      return row ? structuredClone(row) : null;
    },
    async listCandidates(options) {
      const statuses = new Set(options?.statuses ?? []);
      return [...rows.values()]
        .filter(row => statuses.size === 0 || statuses.has(row.status))
        .map(row => structuredClone(row));
    },
    async transitionCandidate(input: IcpInitiationCandidateTransitionInput) {
      const current = rows.get(input.candidateId);
      if (!current
        || current.status !== input.expectedStatus
        || current.revision !== input.expectedRevision) {
        throw new Error('transition conflict');
      }
      const next: IcpInitiationCandidate = {
        ...current,
        status: input.status,
        ...(input.reasonCode ? { reasonCode: input.reasonCode } : {}),
        ...(input.permitId ? { permitId: input.permitId } : {}),
        ...(input.deliveryDisposition
          ? { deliveryDisposition: input.deliveryDisposition }
          : {}),
        ...(input.retryAttempt !== undefined ? { retryAttempt: input.retryAttempt } : {}),
        ...(input.retryEligibleAtMs !== undefined
          ? { retryEligibleAtMs: input.retryEligibleAtMs }
          : {}),
        revision: current.revision + 1,
      };
      if (input.status !== 'deferred' || input.clearRetryEligibility === true) {
        delete next.retryEligibleAtMs;
      }
      rows.set(next.candidateId, next);
      return structuredClone(next);
    },
    async close() {},
  };
}

function dependencies(overrides: Partial<IcpInitiationSourceRuntimeDependencies> = {}) {
  const consent: IcpInitiationConsentEvaluator = {
    evaluate: vi.fn().mockResolvedValue({ action: 'send' }),
  };
  const deps: IcpInitiationSourceRuntimeDependencies = {
    localCompanionId: LOCAL,
    store: createStore(),
    peers: {
      resolveKnownPeer: vi.fn().mockResolvedValue({
        contactId: 'peer-contact',
        displayName: 'Peer',
        peerCompanionId: PEER,
      }),
      executeCompanionOutreach: vi.fn().mockResolvedValue({ disposition: 'delivered' }),
    },
    gateway: {
      companionInitiationPreflight: vi.fn().mockResolvedValue({ eligible: true }),
      companionIssueInitiationPermit: vi.fn().mockImplementation(async ({ candidate }) => ({
        decision: { eligible: true },
        permit: {
          permitId: '33333333-3333-4333-8333-333333333333',
          candidateId: candidate.candidateId,
          conversationId: '44444444-4444-4444-8444-444444444444',
          senderCompanionId: LOCAL,
          recipientCompanionId: PEER,
          channelId: `companion-dm:${LOCAL}:${PEER}`,
          provenanceRef: candidate.provenanceRef,
          issuedAtMs: 1_700_000_000_000,
          expiresAtMs: 1_700_000_300_000,
          status: 'issued',
          revision: 1,
        },
      })),
    },
    consent,
    isExternalCompanionAuthorized: vi.fn().mockReturnValue(true),
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { deps, consent };
}

function request(
  source: 'free_time' | 'weighted_thought' | 'intention' | 'foreground' | 'felt_impulse' | 'operator_test',
) {
  return {
    source,
    peerContactId: 'peer-contact',
    preferredChannel: 'dm' as const,
    sourceRecordId: `${source}:source-record`,
    reasonSummary: `private ${source} motivation`,
    cause: { kind: 'independent' as const },
  };
}

describe('ICP initiation source runtime', () => {
  it('accepts only after the candidate is durable, then continues outreach in the background', async () => {
    let settleOutreach!: () => void;
    const outreachSettled = new Promise<void>(resolve => {
      settleOutreach = resolve;
    });
    const { deps } = dependencies({
      peers: {
        resolveKnownPeer: vi.fn().mockResolvedValue({
          contactId: 'peer-contact',
          displayName: 'Peer',
          peerCompanionId: PEER,
        }),
        executeCompanionOutreach: vi.fn(async () => {
          await outreachSettled;
          return { disposition: 'delivered' };
        }),
      },
    });
    const runtime = createIcpInitiationSourceRuntime(deps);

    const acceptance = await runtime.accept(request('operator_test'));

    expect(acceptance).toMatchObject({ outcome: 'accepted', status: 'pending' });
    await expect(deps.store.getCandidate(acceptance.candidateId)).resolves.toMatchObject({
      candidateId: acceptance.candidateId,
      source: 'operator_test',
    });
    await vi.waitFor(() => {
      expect(deps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
    });
    settleOutreach();
    await vi.waitFor(async () => {
      await expect(deps.store.getCandidate(acceptance.candidateId)).resolves.toMatchObject({
        status: 'consumed',
        deliveryDisposition: 'delivered',
      });
    });
  });

  it('accepts a durable candidate without waiting for broker preflight', async () => {
    let releasePreflight!: () => void;
    const preflightReleased = new Promise<void>(resolve => {
      releasePreflight = resolve;
    });
    const { deps } = dependencies({
      gateway: {
        companionInitiationPreflight: vi.fn(async () => {
          await preflightReleased;
          return { eligible: true };
        }),
        companionIssueInitiationPermit: vi.fn().mockImplementation(async ({ candidate }) => ({
          decision: { eligible: true },
          permit: {
            permitId: '33333333-3333-4333-8333-333333333333',
            candidateId: candidate.candidateId,
            conversationId: '44444444-4444-4444-8444-444444444444',
            senderCompanionId: LOCAL,
            recipientCompanionId: PEER,
            channelId: `companion-dm:${LOCAL}:${PEER}`,
            provenanceRef: candidate.provenanceRef,
            issuedAtMs: 1_700_000_000_000,
            expiresAtMs: 1_700_000_300_000,
            status: 'issued',
            revision: 1,
          },
        })),
      },
    });
    const runtime = createIcpInitiationSourceRuntime(deps);

    const acceptance = await Promise.race([
      runtime.accept(request('operator_test')),
      new Promise<'timed_out'>(resolve => setTimeout(() => resolve('timed_out'), 25)),
    ]);

    expect(acceptance).not.toBe('timed_out');
    expect(acceptance).toMatchObject({ outcome: 'accepted', status: 'pending' });
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    releasePreflight();
    await vi.waitFor(() => {
      expect(deps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
    });
  });

  it('durably defers a pending candidate when detached broker work fails', async () => {
    const { deps } = dependencies({
      gateway: {
        companionInitiationPreflight: vi.fn().mockRejectedValue(
          new Error('gateway preflight unavailable'),
        ),
        companionIssueInitiationPermit: vi.fn(),
      },
    });
    const runtime = createIcpInitiationSourceRuntime(deps);

    const acceptance = await runtime.accept(request('operator_test'));

    await vi.waitFor(async () => {
      await expect(deps.store.getCandidate(acceptance.candidateId)).resolves.toMatchObject({
        status: 'deferred',
        reasonCode: 'delivery_failed',
        retryAttempt: 1,
        retryEligibleAtMs: 1_700_000_300_000,
      });
    });
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('rejects acceptance when durable candidate creation fails', async () => {
    const store = createStore();
    store.createCandidate = vi.fn(async () => {
      throw new Error('candidate store unavailable');
    });
    const { deps } = dependencies({ store });
    const runtime = createIcpInitiationSourceRuntime(deps);

    await expect(runtime.accept(request('operator_test')))
      .rejects.toThrow('candidate store unavailable');
    expect(deps.gateway.companionInitiationPreflight).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('reports an idempotent terminal replay instead of claiming new work was accepted', async () => {
    const { deps } = dependencies();
    const runtime = createIcpInitiationSourceRuntime(deps);
    const requestInput = request('operator_test');
    const completed = await runtime.submit(requestInput);

    const replay = await runtime.accept(requestInput);

    expect(replay).toMatchObject({
      outcome: 'deduped',
      candidateId: completed.candidateId,
      status: 'consumed',
      deliveryDisposition: 'delivered',
    });
    expect(deps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
  });

  it('treats authenticated operator-test initiation as consent while retaining broker gates', async () => {
    const { deps, consent } = dependencies();
    vi.mocked(consent.evaluate).mockResolvedValue({ action: 'decline' });

    const result = await createIcpInitiationSourceRuntime(deps)
      .submit(request('operator_test'));

    expect(result.outcome).toBe('sent');
    expect(consent.evaluate).not.toHaveBeenCalled();
    expect(deps.gateway.companionInitiationPreflight).toHaveBeenCalledOnce();
    expect(deps.gateway.companionIssueInitiationPermit).toHaveBeenCalledOnce();
    expect(deps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
    await expect(deps.store.getCandidate(result.candidateId)).resolves.toMatchObject({
      source: 'operator_test',
      status: 'consumed',
    });
  });

  it.each(['free_time', 'weighted_thought', 'intention', 'foreground'] as const)(
    'routes %s through one private candidate, preflight, consent, permit, and target turn',
    async (source) => {
      const { deps, consent } = dependencies();
      const runtime = createIcpInitiationSourceRuntime(deps);

      const result = await runtime.submit(request(source));

      expect(result.outcome).toBe('sent');
      expect(deps.gateway.companionInitiationPreflight).toHaveBeenCalledOnce();
      const preflight = vi.mocked(deps.gateway.companionInitiationPreflight).mock.calls[0]![0];
      expect(preflight.candidate).not.toHaveProperty('reasonSummary');
      expect(preflight.candidate).not.toHaveProperty('peerContactId');
      expect(preflight.candidate.source).toBe(source);
      expect(consent.evaluate).toHaveBeenCalledOnce();
      expect(deps.gateway.companionIssueInitiationPermit).toHaveBeenCalledOnce();
      expect(deps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
      const stored = await deps.store.getCandidate(result.candidateId);
      expect(stored).toMatchObject({
        status: 'consumed',
        reasonSummary: `private ${source} motivation`,
        peerContactId: 'peer-contact',
      });
    },
  );

  it('stops before consent when live authority is narrowed during preflight', async () => {
    let enabled = true;
    const { deps, consent } = dependencies({
      isExternalCompanionAuthorized: vi.fn(() => enabled),
      gateway: {
        companionInitiationPreflight: vi.fn(async () => {
          enabled = false;
          return { eligible: true };
        }),
        companionIssueInitiationPermit: vi.fn(),
      },
    });
    const runtime = createIcpInitiationSourceRuntime(deps);

    const result = await runtime.submit(request('weighted_thought'));

    expect(result).toMatchObject({ outcome: 'rejected', reasonCode: 'policy_denied' });
    expect(consent.evaluate).not.toHaveBeenCalled();
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('uses the canonical owner policy for candidate, retry, and permit leases', async () => {
    const nowMs = 1_700_000_000_000;
    const { deps } = dependencies({
      now: () => nowMs,
      policy: {
        candidateDefaultTtlMs: 60_000,
        retryCadenceMs: 12_000,
        maxRetryAttempts: 2,
        permitTtlMs: 30_000,
      },
    });

    const result = await createIcpInitiationSourceRuntime(deps).submit(request('intention'));

    await expect(deps.store.getCandidate(result.candidateId)).resolves.toMatchObject({
      createdAtMs: nowMs,
      expiresAtMs: nowMs + 60_000,
    });
    expect(deps.gateway.companionIssueInitiationPermit).toHaveBeenCalledWith(
      expect.objectContaining({ permitExpiresAtMs: nowMs + 30_000 }),
    );
  });

  it.each(['free_time', 'weighted_thought', 'intention', 'foreground'] as const)(
    'denies %s without external.companion before consent, permit, or target execution',
    async (source) => {
      const { deps, consent } = dependencies({
        isExternalCompanionAuthorized: vi.fn().mockReturnValue(false),
      });

      const result = await createIcpInitiationSourceRuntime(deps).submit(request(source));

      expect(result).toMatchObject({
        outcome: 'rejected',
        status: 'rejected',
        reasonCode: 'policy_denied',
      });
      expect(consent.evaluate).not.toHaveBeenCalled();
      expect(deps.gateway.companionInitiationPreflight).not.toHaveBeenCalled();
      expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
      expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
    },
  );

  it('makes a closed deterministic gate spend zero consent calls and persists deferral', async () => {
    const { deps, consent } = dependencies({
      gateway: {
        companionInitiationPreflight: vi.fn().mockResolvedValue({
          eligible: false,
          reasonCode: 'peer_busy',
          reasonClass: 'deferrable',
        }),
        companionIssueInitiationPermit: vi.fn(),
      },
    });
    const runtime = createIcpInitiationSourceRuntime(deps);

    const result = await runtime.submit(request('free_time'));

    expect(result).toMatchObject({ outcome: 'deferred', reasonCode: 'peer_busy' });
    expect(consent.evaluate).not.toHaveBeenCalled();
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
    expect((await deps.store.getCandidate(result.candidateId))?.status).toBe('deferred');
  });

  it('starts a deferral cooldown when the durable transition occurs after slow preflight', async () => {
    const startedAt = 1_700_000_000_000;
    let nowMs = startedAt;
    const store = createStore();
    const preflight = vi.fn().mockImplementation(async () => {
      nowMs += 60_000;
      return {
        eligible: false as const,
        reasonCode: 'peer_busy' as const,
        reasonClass: 'deferrable' as const,
      };
    });
    const { deps } = dependencies({
      store,
      now: () => nowMs,
      gateway: {
        companionInitiationPreflight: preflight,
        companionIssueInitiationPermit: vi.fn(),
      },
    });
    const sourceRequest = request('intention');

    const deferred = await createIcpInitiationSourceRuntime(deps).submit(sourceRequest);
    await expect(store.getCandidate(deferred.candidateId)).resolves.toMatchObject({
      retryEligibleAtMs: startedAt + 60_000 + ICP_INITIATION_RETRY_COOLDOWN_MS,
    });

    nowMs = startedAt + ICP_INITIATION_RETRY_COOLDOWN_MS;
    await expect(createIcpInitiationSourceRuntime(deps).submit(sourceRequest)).resolves.toMatchObject({
      outcome: 'deduped',
      status: 'deferred',
    });
    expect(preflight).toHaveBeenCalledOnce();
  });

  it('expires after slow preflight before asking for consent', async () => {
    const startedAt = 1_700_000_000_000;
    let nowMs = startedAt;
    const { deps, consent } = dependencies({
      now: () => nowMs,
      gateway: {
        companionInitiationPreflight: vi.fn().mockImplementation(async () => {
          nowMs += 1_001;
          return { eligible: true as const };
        }),
        companionIssueInitiationPermit: vi.fn(),
      },
    });

    await expect(createIcpInitiationSourceRuntime(deps).submit({
      ...request('intention'),
      ttlMs: 1_000,
    })).resolves.toMatchObject({
      outcome: 'deduped',
      status: 'expired',
      reasonCode: 'candidate_expired',
    });
    expect(consent.evaluate).not.toHaveBeenCalled();
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('expires after slow consent before requesting a permit', async () => {
    const startedAt = 1_700_000_000_000;
    let nowMs = startedAt;
    const consent: IcpInitiationConsentEvaluator = {
      evaluate: vi.fn().mockImplementation(async () => {
        nowMs += 1_001;
        return { action: 'send' as const };
      }),
    };
    const { deps } = dependencies({
      now: () => nowMs,
      consent,
    });

    await expect(createIcpInitiationSourceRuntime(deps).submit({
      ...request('intention'),
      ttlMs: 1_000,
    })).resolves.toMatchObject({
      outcome: 'deduped',
      status: 'expired',
      reasonCode: 'candidate_expired',
    });
    expect(consent.evaluate).toHaveBeenCalledOnce();
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('starts the permit TTL after slow preflight instead of from the submit timestamp', async () => {
    const startedAt = 1_700_000_000_000;
    let nowMs = startedAt;
    const { deps } = dependencies({
      now: () => nowMs,
      gateway: {
        companionInitiationPreflight: vi.fn().mockImplementation(async () => {
          nowMs += 60_000;
          return { eligible: true as const };
        }),
        companionIssueInitiationPermit: vi.fn().mockImplementation(async ({ candidate }) => ({
          decision: { eligible: true as const },
          permit: {
            permitId: '33333333-3333-4333-8333-333333333333',
            candidateId: candidate.candidateId,
            conversationId: '44444444-4444-4444-8444-444444444444',
            senderCompanionId: LOCAL,
            recipientCompanionId: PEER,
            channelId: `companion-dm:${LOCAL}:${PEER}`,
            provenanceRef: candidate.provenanceRef,
            issuedAtMs: nowMs,
            expiresAtMs: nowMs + 5 * 60_000,
            status: 'issued' as const,
            revision: 1,
          },
        })),
      },
    });

    await createIcpInitiationSourceRuntime(deps).submit(request('intention'));

    expect(deps.gateway.companionIssueInitiationPermit).toHaveBeenCalledWith(
      expect.objectContaining({
        permitExpiresAtMs: startedAt + 60_000 + 5 * 60_000,
      }),
    );
  });

  it.each([
    ['defer', 'deferred'],
    ['decline', 'declined'],
  ] as const)('persists consent %s and sends nothing', async (action, expectedStatus) => {
    const consent: IcpInitiationConsentEvaluator = {
      evaluate: vi.fn().mockResolvedValue({ action, reason: 'not now' }),
    };
    const { deps } = dependencies({ consent });
    const runtime = createIcpInitiationSourceRuntime(deps);

    const result = await runtime.submit(request('foreground'));

    expect(result.outcome).toBe(action === 'defer' ? 'deferred' : 'declined');
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
    expect((await deps.store.getCandidate(result.candidateId))?.status).toBe(
      expectedStatus as IcpInitiationCandidateStatus,
    );
  });

  it('dedupes a deferred source without repeating consent or broker calls', async () => {
    const store = createStore();
    const firstDeps = dependencies({
      store,
      gateway: {
        companionInitiationPreflight: vi.fn().mockResolvedValue({ eligible: true }),
        companionIssueInitiationPermit: vi.fn(),
      },
      consent: { evaluate: vi.fn().mockResolvedValue({ action: 'defer' }) },
    }).deps;
    const first = await createIcpInitiationSourceRuntime(firstDeps).submit(request('intention'));
    const restartedDeps = dependencies({ store }).deps;

    const replay = await createIcpInitiationSourceRuntime(restartedDeps)
      .submit(request('intention'));

    expect(first).toMatchObject({ outcome: 'deferred', status: 'deferred' });
    expect(replay).toMatchObject({ outcome: 'deduped', status: 'deferred' });
    expect(restartedDeps.consent.evaluate).not.toHaveBeenCalled();
    expect(restartedDeps.gateway.companionInitiationPreflight).not.toHaveBeenCalled();
    expect(restartedDeps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
  });

  it('bounds durable cooldown retries and terminally cancels after the final retry', async () => {
    const store = createStore();
    let nowMs = 1_700_000_000_000;
    const preflight = vi.fn().mockResolvedValue({
      eligible: false,
      reasonCode: 'peer_busy',
      reasonClass: 'deferrable',
    });
    const { deps, consent } = dependencies({
      store,
      now: () => nowMs,
      gateway: {
        companionInitiationPreflight: preflight,
        companionIssueInitiationPermit: vi.fn(),
      },
    });
    const sourceRequest = request('intention');

    for (let attempt = 1; attempt <= MAX_ICP_INITIATION_RETRY_ATTEMPTS; attempt += 1) {
      await expect(createIcpInitiationSourceRuntime(deps).submit(sourceRequest)).resolves.toMatchObject({
        outcome: 'deferred',
        status: 'deferred',
      });
      nowMs += ICP_INITIATION_RETRY_COOLDOWN_MS;
    }
    const exhausted = await createIcpInitiationSourceRuntime(deps).submit(sourceRequest);
    expect(exhausted).toMatchObject({ outcome: 'deferred', status: 'cancelled' });
    await expect(createIcpInitiationSourceRuntime(deps).submit(sourceRequest)).resolves.toMatchObject({
      outcome: 'deduped',
      status: 'cancelled',
    });
    await expect(store.getCandidate(exhausted.candidateId)).resolves.toMatchObject({
      status: 'cancelled',
      retryAttempt: MAX_ICP_INITIATION_RETRY_ATTEMPTS,
    });
    expect(preflight).toHaveBeenCalledTimes(MAX_ICP_INITIATION_RETRY_ATTEMPTS + 1);
    expect(consent.evaluate).not.toHaveBeenCalled();
    expect(deps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(deps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('propagates a suppressed target disposition instead of reporting sent', async () => {
    const { deps } = dependencies();
    vi.mocked(deps.peers.executeCompanionOutreach).mockResolvedValue({
      disposition: 'suppressed',
    });

    await expect(createIcpInitiationSourceRuntime(deps).submit(request('foreground')))
      .resolves.toMatchObject({ outcome: 'suppressed', status: 'consumed' });
  });

  it('dedupes the same durable source across runtime restart and does not repeat sent outreach', async () => {
    const store = createStore();
    const firstDeps = dependencies({ store }).deps;
    const first = createIcpInitiationSourceRuntime(firstDeps);
    const sent = await first.submit(request('intention'));

    const restartedDeps = dependencies({ store }).deps;
    const restarted = createIcpInitiationSourceRuntime(restartedDeps);
    const replay = await restarted.submit(request('intention'));

    expect(replay).toMatchObject({ outcome: 'deduped', candidateId: sent.candidateId });
    expect(restartedDeps.gateway.companionInitiationPreflight).not.toHaveBeenCalled();
    expect(restartedDeps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('rejects a deterministic source replay that mutates its current-room route', async () => {
    const store = createStore();
    const firstDeps = dependencies({ store }).deps;
    const sourceRequest = {
      ...request('foreground'),
      preferredChannel: 'current_room' as const,
      currentRoomChannelId: 'companion-room:library',
    };
    await createIcpInitiationSourceRuntime(firstDeps).submit(sourceRequest);

    const restartedDeps = dependencies({ store }).deps;
    await expect(createIcpInitiationSourceRuntime(restartedDeps).submit({
      ...sourceRequest,
      currentRoomChannelId: 'companion-room:studio',
    })).rejects.toThrow('ICP candidate identity conflict');
    expect(restartedDeps.gateway.companionInitiationPreflight).not.toHaveBeenCalled();
    expect(restartedDeps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(restartedDeps.peers.executeCompanionOutreach).not.toHaveBeenCalled();
  });

  it('persists the permit before delivery and recovers an interrupted target turn after restart', async () => {
    const store = createStore();
    const firstDeps = dependencies({ store }).deps;
    vi.mocked(firstDeps.peers.executeCompanionOutreach).mockRejectedValueOnce(
      new Error('process interrupted after permit issue'),
    );
    const first = createIcpInitiationSourceRuntime(firstDeps);

    await expect(first.submit(request('foreground'))).rejects.toThrow('process interrupted');
    const candidateId = vi.mocked(firstDeps.gateway.companionIssueInitiationPermit)
      .mock.calls[0]![0].candidate.candidateId;
    await expect(store.getCandidate(candidateId)).resolves.toMatchObject({
      status: 'permitted',
      permitId: '33333333-3333-4333-8333-333333333333',
    });

    const restartedDeps = dependencies({ store }).deps;
    const restarted = createIcpInitiationSourceRuntime(restartedDeps);
    await expect(restarted.submit(request('foreground'))).resolves.toMatchObject({
      outcome: 'sent',
      status: 'consumed',
    });
    expect(restartedDeps.gateway.companionInitiationPreflight).not.toHaveBeenCalled();
    expect(restartedDeps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(restartedDeps.peers.executeCompanionOutreach).toHaveBeenCalledWith(
      'peer-contact',
      '33333333-3333-4333-8333-333333333333',
      expect.objectContaining({
        candidateId,
        rootInitiationId: candidateId,
        source: 'foreground',
      }),
      restartedDeps.isExternalCompanionAuthorized,
    );
  });

  it('pins a felt-impulse correlation to its first durable peer across crash and peer reselection', async () => {
    const store = createStore();
    const firstDeps = dependencies({
      store,
      peers: {
        resolveKnownPeer: vi.fn().mockResolvedValue({
          contactId: 'peer-contact',
          displayName: 'First peer',
          peerCompanionId: PEER,
        }),
        executeCompanionOutreach: vi.fn().mockRejectedValueOnce(
          new Error('response lost after durable permit'),
        ),
      },
    }).deps;
    const sourceRequest = {
      ...request('felt_impulse'),
      sourceRecordId: 'felt-impulse:would_message:1780000000000',
    };

    await expect(createIcpInitiationSourceRuntime(firstDeps).submit(sourceRequest))
      .rejects.toThrow('response lost');

    const restartedDeps = dependencies({
      store,
      peers: {
        resolveKnownPeer: vi.fn(async (contactId: string) => contactId === 'peer-contact'
          ? {
              contactId,
              displayName: 'First peer',
              peerCompanionId: PEER,
            }
          : {
              contactId,
              displayName: 'Newly eligible peer',
              peerCompanionId: OTHER_PEER,
            }),
        executeCompanionOutreach: vi.fn().mockResolvedValue({ disposition: 'delivered' }),
      },
    }).deps;
    const replay = await createIcpInitiationSourceRuntime(restartedDeps).submit({
      ...sourceRequest,
      peerContactId: 'newly-eligible-peer-contact',
    });

    expect(replay).toMatchObject({ outcome: 'sent', status: 'consumed' });
    await expect(store.listCandidates()).resolves.toHaveLength(1);
    await expect(store.getCandidate(replay.candidateId)).resolves.toMatchObject({
      peerContactId: 'peer-contact',
      peerCompanionId: PEER,
      status: 'consumed',
    });
    expect(restartedDeps.gateway.companionInitiationPreflight).not.toHaveBeenCalled();
    expect(restartedDeps.gateway.companionIssueInitiationPermit).not.toHaveBeenCalled();
    expect(restartedDeps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
    expect(restartedDeps.peers.executeCompanionOutreach).toHaveBeenCalledWith(
      'peer-contact',
      '33333333-3333-4333-8333-333333333333',
      expect.objectContaining({ candidateId: replay.candidateId, source: 'felt_impulse' }),
      restartedDeps.isExternalCompanionAuthorized,
    );
  });

  it('reconciles a committed permit after the issue response is lost without repeating consent', async () => {
    const store = createStore();
    const permit = {
      permitId: '33333333-3333-4333-8333-333333333333',
      candidateId: '',
      conversationId: '44444444-4444-4444-8444-444444444444',
      senderCompanionId: LOCAL,
      recipientCompanionId: PEER,
      channelId: `companion-dm:${LOCAL}:${PEER}`,
      provenanceRef: '',
      issuedAtMs: 1_700_000_000_000,
      expiresAtMs: 1_700_000_300_000,
      status: 'issued' as const,
      revision: 1,
    };
    let committedPermit: typeof permit | undefined;
    const firstDeps = dependencies({ store }).deps;
    vi.mocked(firstDeps.gateway.companionIssueInitiationPermit)
      .mockImplementationOnce(async ({ candidate }) => {
        committedPermit = {
          ...permit,
          candidateId: candidate.candidateId,
          provenanceRef: candidate.provenanceRef,
        };
        throw new Error('gateway response lost after commit');
      });
    await expect(createIcpInitiationSourceRuntime(firstDeps).submit(request('foreground')))
      .rejects.toThrow('response lost');

    const restartedDeps = dependencies({
      store,
      gateway: {
        companionInitiationPreflight: vi.fn().mockResolvedValue({
          eligible: false,
          reasonCode: 'invitation_outstanding',
          reasonClass: 'deferrable',
        }),
        companionIssueInitiationPermit: vi.fn().mockImplementation(async () => ({
          decision: { eligible: true },
          permit: committedPermit,
        })),
      },
    }).deps;

    await expect(createIcpInitiationSourceRuntime(restartedDeps).submit(request('foreground')))
      .resolves.toMatchObject({ outcome: 'sent', status: 'consumed' });
    expect(restartedDeps.consent.evaluate).not.toHaveBeenCalled();
    expect(restartedDeps.gateway.companionIssueInitiationPermit).toHaveBeenCalledOnce();
    expect(restartedDeps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
  });

  it('preserves an inherited MI root so recursive-only causality is rejected before consent', async () => {
    const { deps, consent } = dependencies({
      gateway: {
        companionInitiationPreflight: vi.fn().mockImplementation(async ({ candidate }) => ({
          eligible: candidate.rootInitiationId === candidate.candidateId,
          ...(candidate.rootInitiationId !== candidate.candidateId
            ? { reasonCode: 'recursive_trigger' as const, reasonClass: 'terminal' as const }
            : {}),
        })),
        companionIssueInitiationPermit: vi.fn(),
      },
    });
    const runtime = createIcpInitiationSourceRuntime(deps);
    const result = await runtime.submit({
      ...request('foreground'),
      cause: {
        kind: 'icp_conversation',
        rootInitiationId: '55555555-5555-4555-8555-555555555555',
      },
    });

    expect(result).toMatchObject({ outcome: 'rejected', reasonCode: 'recursive_trigger' });
    expect(consent.evaluate).not.toHaveBeenCalled();
  });

  it('serializes concurrent submissions for one source into one consent and one target turn', async () => {
    const { deps, consent } = dependencies();
    const runtime = createIcpInitiationSourceRuntime(deps);

    const [first, second] = await Promise.all([
      runtime.submit(request('weighted_thought')),
      runtime.submit(request('weighted_thought')),
    ]);

    expect(first.candidateId).toBe(second.candidateId);
    expect(consent.evaluate).toHaveBeenCalledOnce();
    expect(deps.peers.executeCompanionOutreach).toHaveBeenCalledOnce();
  });
});
