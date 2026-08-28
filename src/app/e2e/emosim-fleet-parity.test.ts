import { describe, expect, it, vi } from 'vitest';
import { createIcpFeltImpulseInitiationAdapter } from '../../core/icp/felt-impulse-initiation.js';
import type {
  IcpFeltImpulseFunnelRecord,
  IcpFeltImpulseFunnelStorePort,
} from '../../core/icp/felt-impulse-funnel.js';
import type { ObserverEvalSidecarHealthSnapshot } from '../../core/eval/observer-sidecar/types.js';
import { EventBus, type EmotionProactiveTransitionEvent } from '../../shared/event-bus.js';
import { AdminObserverEvalSidecarDataService } from '../../operator/garden/services/observer-eval-sidecar-service.js';

const NOW_MS = 1_780_000_000_000;
const COMPANIONS = Object.freeze([
  {
    companionId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Purrsephone',
    sidecarId: 'emosim-purrsephone',
  },
  {
    companionId: '22222222-2222-4222-8222-222222222222',
    displayName: 'Artemis',
    sidecarId: 'emosim-artemis',
  },
  {
    companionId: '33333333-3333-4333-8333-333333333333',
    displayName: 'V Unit 00',
    sidecarId: 'emosim-v-unit-00',
  },
]);

function healthSnapshot(
  sidecarId: string,
  status: 'enabled' | 'unavailable' = 'enabled',
): ObserverEvalSidecarHealthSnapshot {
  return {
    status,
    observedAt: NOW_MS,
    sidecarId,
    enabled: true,
    available: status === 'enabled',
    accepting: status === 'enabled',
    queue: {
      queuedCount: 0,
      runningCount: 0,
      maxQueuedTurns: 32,
      overflowPolicy: 'drop_newest',
      shuttingDown: false,
    },
    counts: {
      accepted: 1,
      completed: status === 'enabled' ? 1 : 0,
      dropped: 0,
      failed: status === 'unavailable' ? 1 : 0,
      timedOut: 0,
      retried: 0,
      lifecycleHookFailed: 0,
      shutdownTimedOut: 0,
    },
    dropCounts: {},
    failureCounts: status === 'unavailable' ? { observer_unavailable: 1 } : {},
  };
}

function healthService(
  companion: typeof COMPANIONS[number],
  read: () => ObserverEvalSidecarHealthSnapshot,
): AdminObserverEvalSidecarDataService {
  return new AdminObserverEvalSidecarDataService({
    companionId: companion.companionId,
    binding: {
      companionId: companion.companionId,
      sidecarId: companion.sidecarId,
      sessionLabel: `${companion.sidecarId}-session`,
      agentName: `${companion.sidecarId}-agent`,
    },
    configuredEnabled: true,
    proactivityEnabled: true,
    getHealthSnapshot: read,
    nowMs: () => NOW_MS,
  });
}

function durableFunnel(): {
  store: IcpFeltImpulseFunnelStorePort;
  records: Map<string, IcpFeltImpulseFunnelRecord>;
} {
  const records = new Map<string, IcpFeltImpulseFunnelRecord>();
  return {
    records,
    store: {
      async getOutcome(correlationId) {
        return records.get(correlationId) ?? null;
      },
      async recordOutcome(record) {
        const existing = records.get(record.correlationId);
        if (existing) return existing;
        records.set(record.correlationId, structuredClone(record));
        return structuredClone(record);
      },
      async readProjection() {
        throw new Error('not used by the fleet parity harness');
      },
      async close() {},
    },
  };
}

describe('three-companion EmoSim fleet parity', () => {
  it('isolates one outage, recovers honestly, and rejects primary health under a sibling identity', async () => {
    const snapshots = new Map(COMPANIONS.map(companion => (
      [companion.companionId, healthSnapshot(companion.sidecarId)] as const
    )));
    const services = new Map(COMPANIONS.map(companion => (
      [companion.companionId, healthService(companion, () => snapshots.get(companion.companionId)!)] as const
    )));

    const artemis = COMPANIONS[1];
    snapshots.set(artemis.companionId, healthSnapshot(artemis.sidecarId, 'unavailable'));
    const outage = await Promise.all(COMPANIONS.map(async companion => ({
      companionId: companion.companionId,
      health: await services.get(companion.companionId)!.getHealth(),
    })));
    expect(outage.map(entry => [entry.companionId, entry.health.operatingState])).toEqual([
      [COMPANIONS[0].companionId, 'on'],
      [COMPANIONS[1].companionId, 'unhealthy'],
      [COMPANIONS[2].companionId, 'on'],
    ]);

    snapshots.set(artemis.companionId, healthSnapshot(artemis.sidecarId));
    await expect(services.get(artemis.companionId)!.getHealth()).resolves.toMatchObject({
      companionId: artemis.companionId,
      operatingState: 'on',
      runtime: { sidecarId: artemis.sidecarId },
    });
    await expect(healthService(artemis, () => snapshots.get(artemis.companionId)!).getHealth())
      .resolves.toMatchObject({
        companionId: artemis.companionId,
        operatingState: 'on',
        binding: { sessionLabel: `${artemis.sidecarId}-session` },
      });

    const primarySnapshot = snapshots.get(COMPANIONS[0].companionId)!;
    await expect(healthService(artemis, () => primarySnapshot).getHealth()).resolves.toMatchObject({
      companionId: artemis.companionId,
      operatingState: 'unhealthy',
      runtime: null,
    });
  });

  it('routes each qualified would_message to its own durable funnel and typed terminal disposition', async () => {
    const outcomes = await Promise.all(COMPANIONS.map(async (companion, index) => {
      const peer = COMPANIONS[(index + 1) % COMPANIONS.length];
      const funnel = durableFunnel();
      const eventBus = new EventBus();
      const transitions: EmotionProactiveTransitionEvent[] = [];
      eventBus.on('emotion.proactive.transition', event => transitions.push(event));
      const submit = vi.fn(async () => ({
        outcome: 'accepted' as const,
        candidateId: companion.companionId,
        status: 'pending' as const,
      }));
      const firedAtMs = NOW_MS + index;
      const signal = {
        lever: 'would_message' as const,
        correlationId: `felt-impulse:would_message:${firedAtMs}`,
        firedAtMs,
        timestamp: firedAtMs,
      };
      const createAdapter = () => createIcpFeltImpulseInitiationAdapter({
        sourceRuntime: { accept: submit },
        peers: {
          listKnownPeerAvailability: async () => [{
            contactId: `peer-${peer.companionId}`,
            displayName: peer.displayName,
            peerCompanionId: peer.companionId,
            availability: {
              peerCompanionId: peer.companionId,
              connectionState: 'online' as const,
              eligible: true as const,
            },
          }],
        },
        isAuthorized: () => true,
        funnelStore: funnel.store,
        eventBus,
        now: () => firedAtMs,
      });

      const first = await createAdapter().onLeverSignal(signal);
      const restarted = await createAdapter().onLeverSignal(signal);
      return {
        companionId: companion.companionId,
        first,
        restarted,
        records: [...funnel.records.values()],
        transitions,
      };
    }));

    for (const [index, outcome] of outcomes.entries()) {
      const companion = COMPANIONS[index];
      expect(outcome.companionId).toBe(companion.companionId);
      expect(outcome.first).toMatchObject({ kind: 'submitted' });
      expect(outcome.restarted).toEqual({ kind: 'deduped', candidateId: companion.companionId });
      expect(outcome.records).toEqual([expect.objectContaining({
        correlationId: `felt-impulse:would_message:${NOW_MS + index}`,
        outcome: 'candidate_linked',
        candidateId: companion.companionId,
      })]);
      expect(outcome.transitions.at(-1)).toMatchObject({
        stage: 'final_disposition',
        outcome: 'submitted',
        candidateId: companion.companionId,
      });
    }
  });
});
