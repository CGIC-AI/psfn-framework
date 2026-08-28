import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { IcpAvailabilityState } from '../../shared/contracts/icp-autonomy.js';
import type { KnownCompanionPeerAvailability } from './agent-facing-autonomy.js';
import type { IcpInitiationSourceAcceptance } from './initiation-source-runtime.js';
import type { IcpFeltImpulseFunnelStorePort } from './felt-impulse-funnel.js';
import {
  createIcpFeltImpulseInitiationAdapter,
  FELT_IMPULSE_MIN_INTERVAL_MS,
} from './felt-impulse-initiation.js';

const T0 = Date.parse('2026-07-30T12:00:00.000Z');

function peerOf(
  contactId: string,
  overrides: { eligible?: boolean; leaseState?: IcpAvailabilityState } = {},
): KnownCompanionPeerAvailability {
  return {
    contactId,
    displayName: contactId,
    peerCompanionId: '11111111-1111-4111-8111-111111111111',
    availability: {
      peerCompanionId: '11111111-1111-4111-8111-111111111111',
      connectionState: 'online',
      eligible: overrides.eligible ?? true,
      ...(overrides.leaseState
        ? {
          lease: {
            companionId: '11111111-1111-4111-8111-111111111111',
            state: overrides.leaseState,
            source: 'companion' as const,
            issuedAtMs: T0 - 1_000,
            expiresAtMs: T0 + 60_000,
            revision: 1,
          },
        }
        : {}),
    },
  };
}

function submittedResult(): IcpInitiationSourceAcceptance {
  return {
    outcome: 'accepted',
    candidateId: '33333333-3333-4333-8333-333333333333',
    status: 'pending',
  };
}

function signal(
  firedAtMs = T0,
  correlationId = `felt-impulse:would_message:${firedAtMs}`,
) {
  return {
    schemaVersion: 1 as const,
    impulseVersion: 'emosim-proactivity.impulse.v1' as const,
    kind: 'would_message' as const,
    companionId: '11111111-1111-4111-8111-111111111111',
    source: { model: 'emo_sim', version: 'emo_sim/server.py#http-api.v1' },
    lineage: {
      schemaVersion: 1 as const,
      inputId: `turn:${firedAtMs}`,
      projectionVersion: 'psfn.observer-sidecar.appraisal-projection.v3',
      privacyClass: 'content_redacted',
      rawContentRedacted: true as const,
    },
    firstCrossingMs: Number(correlationId.slice(correlationId.lastIndexOf(':') + 1)),
    thresholdProfile: {
      profileId: 'would-message-v1',
      socialNeedThreshold: 0.7,
      attachmentIntensityThreshold: 0.5,
      sustainMs: 1_800_000,
      cooldownMs: 21_600_000,
    },
    dedupeKey: correlationId,
    correlationId,
    firedAtMs,
    confidence: 0.82,
    availability: 'available' as const,
    authority: 'qualified_source_fire' as const,
  };
}

function volatileFunnelStore(): IcpFeltImpulseFunnelStorePort {
  const records = new Map<string, Parameters<IcpFeltImpulseFunnelStorePort['recordOutcome']>[0]>();
  return {
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
      throw new Error('not used by producer unit tests');
    },
    async close() {},
  };
}

describe('felt-impulse ICP initiation (psfn-framework-hrmrq.34, operator ruling D4)', () => {
  it('links a submitted candidate durably and deduplicates it after adapter restart', async () => {
    let durable: Record<string, unknown> | null = null;
    const funnelStore = {
      getOutcome: vi.fn(async () => durable),
      recordOutcome: vi.fn(async (record: Record<string, unknown>) => {
        durable ??= record;
        return durable;
      }),
    };
    const firstSubmit = vi.fn(async () => submittedResult());
    const first = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: firstSubmit },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      funnelStore,
      now: () => T0,
    });

    await expect(first.onImpulse(signal())).resolves.toMatchObject({ kind: 'submitted' });
    expect(funnelStore.recordOutcome).toHaveBeenCalledWith({
      correlationId: `felt-impulse:would_message:${T0}`,
      firstCrossingMs: T0,
      firedAtMs: T0,
      recordedAtMs: T0,
      outcome: 'candidate_linked',
      candidateId: submittedResult().candidateId,
      candidateOutcome: 'submitted',
    });

    const restartedSubmit = vi.fn();
    const restarted = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: restartedSubmit },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      funnelStore,
      now: () => T0 + FELT_IMPULSE_MIN_INTERVAL_MS,
    });

    await expect(restarted.onImpulse(signal())).resolves.toEqual({
      kind: 'deduped',
      candidateId: submittedResult().candidateId,
    });
    expect(restartedSubmit).not.toHaveBeenCalled();
    expect(funnelStore.recordOutcome).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(durable)).not.toContain('wanting to reach out');
  });

  it('replays the durable winner when a concurrent atomic candidate link wins', async () => {
    const candidateId = '44444444-4444-4444-8444-444444444444';
    const durable = {
      correlationId: `felt-impulse:would_message:${T0}`,
      firstCrossingMs: T0,
      firedAtMs: T0,
      recordedAtMs: T0,
      outcome: 'candidate_linked' as const,
      candidateId,
      candidateOutcome: 'submitted' as const,
    };
    const funnelStore = {
      getOutcome: vi.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValue(durable),
      recordOutcome: vi.fn(),
      readProjection: vi.fn(),
      close: vi.fn(),
    };
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: {
        accept: vi.fn().mockRejectedValue(new Error('concurrent candidate link conflict')),
      },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      funnelStore,
      now: () => T0,
    });

    await expect(adapter.onImpulse(signal())).resolves.toEqual({
      kind: 'deduped',
      candidateId,
    });
    expect(funnelStore.getOutcome).toHaveBeenCalledTimes(2);
    expect(funnelStore.recordOutcome).not.toHaveBeenCalled();
  });

  it('replays a durable no-peer outcome after adapter restart without reevaluating the fire', async () => {
    const records = new Map<string, {
      correlationId: string;
      firedAtMs: number;
      recordedAtMs: number;
      outcome: 'no_eligible_peer';
    }>();
    const funnelStore = {
      getOutcome: vi.fn(async (correlationId: string) => records.get(correlationId) ?? null),
      recordOutcome: vi.fn(async (record: {
        correlationId: string;
        firedAtMs: number;
        recordedAtMs: number;
        outcome: 'no_eligible_peer';
      }) => {
        const existing = records.get(record.correlationId);
        if (existing) return existing;
        records.set(record.correlationId, record);
        return record;
      }),
      readProjection: vi.fn(),
      close: vi.fn(),
    };
    const first = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: vi.fn() },
      peers: { listKnownPeerAvailability: async () => [] },
      isAuthorized: () => true,
      funnelStore,
      now: () => T0,
    });

    await expect(first.onImpulse(signal())).resolves.toEqual({ kind: 'no_eligible_peer' });
    expect(funnelStore.recordOutcome).toHaveBeenCalledWith({
      correlationId: `felt-impulse:would_message:${T0}`,
      firstCrossingMs: T0,
      firedAtMs: T0,
      recordedAtMs: T0,
      outcome: 'no_eligible_peer',
    });

    const submitAfterRestart = vi.fn();
    const listAfterRestart = vi.fn();
    const restarted = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submitAfterRestart },
      peers: { listKnownPeerAvailability: listAfterRestart },
      isAuthorized: () => false,
      funnelStore,
      now: () => T0 + FELT_IMPULSE_MIN_INTERVAL_MS,
    });

    await expect(restarted.onImpulse(signal())).resolves.toEqual({
      kind: 'no_eligible_peer',
    });
    expect(submitAfterRestart).not.toHaveBeenCalled();
    expect(listAfterRestart).not.toHaveBeenCalled();
    expect(funnelStore.recordOutcome).toHaveBeenCalledTimes(1);
  });

  it('submits an ICP candidate with source felt_impulse when the lever fires', async () => {
    const firedAtMs = T0 + 30 * 60_000;
    const submit = vi.fn(async () => submittedResult());
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submit },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      funnelStore: volatileFunnelStore(),
      now: () => firedAtMs,
    });

    const outcome = await adapter.onImpulse(signal(
      firedAtMs,
      `felt-impulse:would_message:${T0}`,
    ));
    expect(outcome.kind).toBe('submitted');
    expect(submit).toHaveBeenCalledWith({
      source: 'felt_impulse',
      peerContactId: 'peer-a',
      preferredChannel: 'dm',
      sourceRecordId: `felt-impulse:would_message:${T0}`,
      feltImpulseFiredAtMs: firedAtMs,
      reasonSummary: 'Felt social impulse: the affect model sustained wanting to reach out.',
      cause: { kind: 'independent' },
    });
  });

  it('prefers an eligible peer over an ineligible one, deterministically', async () => {
    const submit = vi.fn(async () => submittedResult());
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submit },
      peers: {
        listKnownPeerAvailability: async () => [
          peerOf('peer-a', { eligible: false }),
          peerOf('peer-b', { eligible: true }),
        ],
      },
      isAuthorized: () => true,
      funnelStore: volatileFunnelStore(),
      now: () => T0,
    });

    await adapter.onImpulse(signal());
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ peerContactId: 'peer-b' });
  });

  it('submits nothing when every known peer is currently ineligible', async () => {
    const submit = vi.fn(async () => submittedResult());
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submit },
      peers: {
        listKnownPeerAvailability: async () => [
          peerOf('peer-a', { eligible: false, leaseState: 'busy' }),
          peerOf('peer-b', { eligible: false, leaseState: 'do_not_disturb' }),
        ],
      },
      isAuthorized: () => true,
      funnelStore: volatileFunnelStore(),
      now: () => T0,
    });

    await expect(adapter.onImpulse(signal())).resolves.toEqual({
      kind: 'no_eligible_peer',
    });
    expect(submit).not.toHaveBeenCalled();
  });

  it('fails EXPLICITLY (event + outcome) when no companion-channel sibling contact exists', async () => {
    const submit = vi.fn();
    const eventBus = new EventBus();
    const outcomes: Array<{ outcome: string; reason?: string }> = [];
    eventBus.on('icp.felt_impulse.outcome', (payload) => outcomes.push({
      outcome: payload.outcome,
      ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
    }));
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submit },
      peers: { listKnownPeerAvailability: async () => [] },
      isAuthorized: () => true,
      funnelStore: volatileFunnelStore(),
      eventBus,
      now: () => T0,
    });

    const outcome = await adapter.onImpulse(signal());
    expect(outcome).toEqual({ kind: 'no_eligible_peer' });
    expect(submit).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { outcome: 'no_eligible_peer', reason: 'missing_or_ineligible_companion_channel_contacts' },
    ]);
  });

  it('does nothing when the runtime fence or capability tier denies autonomy', async () => {
    const submit = vi.fn();
    const list = vi.fn();
    let durable: Record<string, unknown> | null = null;
    const funnelStore = {
      getOutcome: vi.fn(async () => durable),
      recordOutcome: vi.fn(async (record: Record<string, unknown>) => {
        durable ??= record;
        return durable;
      }),
    };
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submit },
      peers: { listKnownPeerAvailability: list },
      isAuthorized: () => false,
      funnelStore,
      now: () => T0,
    });

    const outcome = await adapter.onImpulse(signal());
    expect(outcome).toEqual({ kind: 'not_authorized' });
    expect(submit).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
    expect(funnelStore.recordOutcome).toHaveBeenCalledWith({
      correlationId: `felt-impulse:would_message:${T0}`,
      firstCrossingMs: T0,
      firedAtMs: T0,
      recordedAtMs: T0,
      outcome: 'not_authorized',
    });
  });

  it('throttles repeat submissions inside the local flood floor', async () => {
    let nowMs = T0;
    const submit = vi.fn(async () => submittedResult());
    const records = new Map<string, Record<string, unknown>>();
    const funnelStore = {
      getOutcome: vi.fn(async (correlationId: string) => records.get(correlationId) ?? null),
      recordOutcome: vi.fn(async (record: Record<string, unknown>) => {
        const correlationId = String(record.correlationId);
        const existing = records.get(correlationId);
        if (existing) return existing;
        records.set(correlationId, record);
        return record;
      }),
    };
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submit },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      funnelStore,
      now: () => nowMs,
    });

    await adapter.onImpulse(signal(T0));
    nowMs = T0 + 60_000;
    const second = await adapter.onImpulse(signal(nowMs));
    expect(second).toEqual({ kind: 'throttled', nextEligibleAtMs: T0 + FELT_IMPULSE_MIN_INTERVAL_MS });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(records.get(`felt-impulse:would_message:${nowMs}`)).toEqual({
      correlationId: `felt-impulse:would_message:${nowMs}`,
      firstCrossingMs: nowMs,
      firedAtMs: nowMs,
      recordedAtMs: nowMs,
      outcome: 'throttled',
      nextEligibleAtMs: T0 + FELT_IMPULSE_MIN_INTERVAL_MS,
    });

    nowMs = T0 + FELT_IMPULSE_MIN_INTERVAL_MS;
    const third = await adapter.onImpulse(signal(nowMs));
    expect(third.kind).toBe('submitted');
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('deduplicates a replayed correlation even after the local flood floor', async () => {
    let nowMs = T0;
    const submit = vi.fn(async () => submittedResult());
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: submit },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      funnelStore: volatileFunnelStore(),
      now: () => nowMs,
    });

    const first = await adapter.onImpulse(signal(T0));
    nowMs = T0 + FELT_IMPULSE_MIN_INTERVAL_MS;
    const replay = await adapter.onImpulse(signal(
      T0 + 5_000,
      `felt-impulse:would_message:${T0}`,
    ));

    expect(first.kind).toBe('submitted');
    expect(replay).toEqual({ kind: 'deduped', candidateId: submittedResult().candidateId });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it('emits content-free correlated transition telemetry through final disposition', async () => {
    const eventBus = new EventBus();
    const transitions: Array<Record<string, unknown>> = [];
    eventBus.on('emotion.proactive.transition', event => transitions.push(event));
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { accept: vi.fn(async () => submittedResult()) },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      funnelStore: volatileFunnelStore(),
      eventBus,
      now: () => T0,
    });

    await adapter.onImpulse(signal());

    expect(transitions.map(event => event.stage)).toEqual([
      'felt_impulse',
      'candidate_submission',
      'final_disposition',
    ]);
    expect(transitions.every(event => (
      event.correlationId === `felt-impulse:would_message:${T0}`
    ))).toBe(true);
    expect(JSON.stringify(transitions)).not.toContain('wanting to reach out');
  });
});
