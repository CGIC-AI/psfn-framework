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
  type IcpInitiationConsentEvaluator,
  type IcpInitiationSourceRuntimeDependencies,
} from './initiation-source-runtime.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';

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
        revision: current.revision + 1,
      };
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
      executeCompanionOutreach: vi.fn().mockResolvedValue(undefined),
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
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return { deps, consent };
}

function request(source: 'free_time' | 'weighted_thought' | 'intention' | 'foreground') {
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
    );
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
