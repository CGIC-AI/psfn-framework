import { describe, expect, it, vi } from 'vitest';

import type {
  IcpInitiationCandidateStorePort,
  IcpInitiationCandidateTransitionInput,
} from '../../core/icp/autonomy-store-ports.js';
import type { IcpInitiationCandidate } from '../../core/icp/initiation-candidate.js';
import type {
  IcpFeltImpulseFunnelRecord,
  IcpFeltImpulseFunnelStorePort,
} from '../../core/icp/felt-impulse-funnel.js';
import { ObserverEvalLeverStage } from '../../core/eval/observer-sidecar/config.js';
import type { ObserverEvalSidecarLeverPersistencePort } from '../../core/eval/observer-sidecar/persistence.js';
import { EventBus, type EmotionProactiveTransitionEvent } from '../../shared/event-bus.js';
import { createDefaultObserverEvalSidecarLeverSettings } from '../../system/config/runtime-config-contracts.js';
import { DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG } from '../../system/config/icp-autonomy-scheduler-config.js';
import { wireIcpInitiationSources } from './icp-initiation-source-wiring.js';

const LOCAL = '11111111-1111-4111-8111-111111111111';
const PEER = '22222222-2222-4222-8222-222222222222';
const NOW_MS = 1_780_000_000_000;
const MINUTE_MS = 60_000;

function createCandidateStore(): {
  store: IcpInitiationCandidateStorePort;
  rows: Map<string, IcpInitiationCandidate>;
} {
  const rows = new Map<string, IcpInitiationCandidate>();
  return {
    rows,
    store: {
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
    },
  };
}

function createLeverPersistence(): ObserverEvalSidecarLeverPersistencePort {
  return {
    recordLeverEvent: vi.fn(async input => ({ ...input, retention: input.retention })) as never,
    queryLeverEvents: vi.fn(async () => []),
    loadLeverState: vi.fn(async () => []),
    saveLeverState: vi.fn(async () => undefined),
    pruneExpiredLeverEvents: vi.fn(async () => ({ prunedEventIds: [] })),
  } as unknown as ObserverEvalSidecarLeverPersistencePort;
}

function createWiringInput(eventBus: EventBus, enabled = true) {
  const { store, rows } = createCandidateStore();
  const funnelRows = new Map<string, IcpFeltImpulseFunnelRecord>();
  const feltImpulseFunnelStore: IcpFeltImpulseFunnelStorePort = {
    async getOutcome(correlationId) {
      return funnelRows.get(correlationId) ?? null;
    },
    async recordOutcome(record) {
      const existing = funnelRows.get(record.correlationId);
      if (existing) return existing;
      funnelRows.set(record.correlationId, structuredClone(record));
      return structuredClone(record);
    },
    async readProjection() {
      throw new Error('not used by source wiring');
    },
    async close() {},
  };
  const peerRuntime = {
    resolveKnownPeer: vi.fn(async () => ({
      contactId: 'peer-contact',
      displayName: 'Peer',
      peerCompanionId: PEER,
    })),
    executeCompanionOutreach: vi.fn(async () => ({ disposition: 'delivered' as const })),
    listKnownPeerAvailability: vi.fn(async () => [{
      contactId: 'peer-contact',
      displayName: 'Peer',
      peerCompanionId: PEER,
      availability: { eligible: true as const },
    }]),
  };
  return {
    rows,
    funnelRows,
    input: {
      config: { ...structuredClone(DEFAULT_ICP_AUTONOMY_SCHEDULER_CONFIG), enabled },
      localCompanionId: LOCAL,
      candidateStore: store,
      feltImpulseFunnelStore,
      peers: peerRuntime,
      gateway: {
        companionInitiationPreflight: vi.fn(async () => ({ eligible: true as const })),
        companionIssueInitiationPermit: vi.fn(async ({ candidate }) => ({
          decision: { eligible: true as const },
          permit: {
            permitId: '33333333-3333-4333-8333-333333333333',
            candidateId: candidate.candidateId,
            conversationId: '44444444-4444-4444-8444-444444444444',
            senderCompanionId: LOCAL,
            recipientCompanionId: PEER,
            channelId: `companion-dm:${LOCAL}:${PEER}`,
            provenanceRef: candidate.provenanceRef,
            issuedAtMs: NOW_MS,
            expiresAtMs: NOW_MS + 5 * MINUTE_MS,
            status: 'issued' as const,
            revision: 1,
          },
        })),
      },
      isExternalCompanionAuthorized: vi.fn(() => true),
      llmProvider: { complete: vi.fn(async () => ({ content: '{"action":"send"}' })) },
      eventBus,
      pendingFollowUpStore: undefined as never,
      concernStore: undefined as never,
      socialDesireStore: undefined,
      presenceEnabled: false,
      contactStore: undefined as never,
      weightedThoughtStore: undefined,
      lifecycleConfig: undefined as never,
      peerDirectory: peerRuntime,
    },
  };
}

describe('ICP felt-impulse startup wiring', () => {
  it('turns one qualifying would_message crossing into exactly one candidate', async () => {
    const eventBus = new EventBus();
    const transitions: EmotionProactiveTransitionEvent[] = [];
    eventBus.on('emotion.proactive.transition', event => {
      transitions.push(event);
    });
    const { input, rows, funnelRows } = createWiringInput(eventBus);
    wireIcpInitiationSources(input);

    const stage = new ObserverEvalLeverStage({
      settings: { ...createDefaultObserverEvalSidecarLeverSettings(), enabled: true },
      persistence: createLeverPersistence(),
      sidecarId: 'startup-wiring-test',
      retentionDays: 14,
      emitFeltImpulse: event => eventBus.emitRequired('icp.felt_impulse.lever', event),
      emitProactiveTransition: event => eventBus.emit('emotion.proactive.transition', event),
    });
    const observe = (observedAtMs: number) => stage.evaluateObservation({
      runId: 'run-startup-wiring',
      observationId: `obs-${observedAtMs}`,
      snapshot: {
        t: 0,
        mood: { valence: 0.2, arousal: 0.1 },
        dominant: 'Calmness',
        emotions: { Calmness: 0.3 },
        drives: { socialNeed: 0.8, sleepPressure: 0.2 },
      },
      observedAtMs,
    });

    await observe(NOW_MS);
    await observe(NOW_MS + 30 * MINUTE_MS);
    await observe(NOW_MS + 35 * MINUTE_MS);

    expect(rows.size).toBe(1);
    expect([...funnelRows.values()]).toEqual([
      expect.objectContaining({
        correlationId: `felt-impulse:would_message:${NOW_MS}`,
        outcome: 'candidate_linked',
      }),
    ]);
    expect([...rows.values()][0]).toMatchObject({ source: 'felt_impulse', status: 'consumed' });
    expect(transitions.map(event => event.stage)).toEqual([
      'would_message',
      'felt_impulse',
      'candidate_submission',
      'final_disposition',
    ]);
    expect(new Set(transitions.map(event => event.correlationId))).toEqual(new Set([
      `felt-impulse:would_message:${NOW_MS}`,
    ]));
    expect(transitions.every(event => (
      !('content' in event) && !('message' in event) && !('reasonSummary' in event)
    ))).toBe(true);
  });

  it('fails closed with a terminal disposition when the candidate lane is disabled', async () => {
    const eventBus = new EventBus();
    const transitions: EmotionProactiveTransitionEvent[] = [];
    eventBus.on('emotion.proactive.transition', event => {
      transitions.push(event);
    });
    const { input, rows, funnelRows } = createWiringInput(eventBus, false);
    wireIcpInitiationSources(input);

    await expect(eventBus.emitRequired('icp.felt_impulse.lever', {
      lever: 'would_message',
      correlationId: `felt-impulse:would_message:${NOW_MS}`,
      firedAtMs: NOW_MS,
      timestamp: NOW_MS,
    })).resolves.toBeUndefined();

    expect(rows.size).toBe(0);
    expect([...funnelRows.values()]).toEqual([{
      correlationId: `felt-impulse:would_message:${NOW_MS}`,
      firedAtMs: NOW_MS,
      recordedAtMs: expect.any(Number),
      outcome: 'not_authorized',
    }]);
    expect(transitions).toEqual([
      expect.objectContaining({
        correlationId: `felt-impulse:would_message:${NOW_MS}`,
        stage: 'felt_impulse',
        outcome: 'received',
      }),
      expect.objectContaining({
        correlationId: `felt-impulse:would_message:${NOW_MS}`,
        stage: 'final_disposition',
        outcome: 'not_authorized',
      }),
    ]);
  });
});
