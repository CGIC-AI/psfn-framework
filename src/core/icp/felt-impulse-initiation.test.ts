import { describe, expect, it, vi } from 'vitest';
import { EventBus } from '../../shared/event-bus.js';
import type { IcpAvailabilityState } from '../../shared/contracts/icp-autonomy.js';
import type { KnownCompanionPeerAvailability } from './agent-facing-autonomy.js';
import type { IcpInitiationSourceResult } from './initiation-source-runtime.js';
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

function submittedResult(): IcpInitiationSourceResult {
  return {
    outcome: 'sent',
    candidateId: '33333333-3333-4333-8333-333333333333',
    status: 'consumed',
  };
}

function signal(firedAtMs = T0) {
  return { lever: 'would_message' as const, firedAtMs, timestamp: firedAtMs };
}

describe('felt-impulse ICP initiation (psfn-framework-hrmrq.34, operator ruling D4)', () => {
  it('submits an ICP candidate with source felt_impulse when the lever fires', async () => {
    const submit = vi.fn(async () => submittedResult());
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { submit },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      now: () => T0,
    });

    const outcome = await adapter.onLeverSignal(signal());
    expect(outcome.kind).toBe('submitted');
    expect(submit).toHaveBeenCalledWith({
      source: 'felt_impulse',
      peerContactId: 'peer-a',
      preferredChannel: 'dm',
      sourceRecordId: `felt-impulse:would_message:${T0}`,
      reasonSummary: 'Felt social impulse: the affect model sustained wanting to reach out.',
      cause: { kind: 'independent' },
    });
  });

  it('prefers an eligible peer over an ineligible one, deterministically', async () => {
    const submit = vi.fn(async () => submittedResult());
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { submit },
      peers: {
        listKnownPeerAvailability: async () => [
          peerOf('peer-a', { eligible: false }),
          peerOf('peer-b', { eligible: true }),
        ],
      },
      isAuthorized: () => true,
      now: () => T0,
    });

    await adapter.onLeverSignal(signal());
    expect(submit.mock.calls[0]?.[0]).toMatchObject({ peerContactId: 'peer-b' });
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
      sourceRuntime: { submit },
      peers: { listKnownPeerAvailability: async () => [] },
      isAuthorized: () => true,
      eventBus,
      now: () => T0,
    });

    const outcome = await adapter.onLeverSignal(signal());
    expect(outcome).toEqual({ kind: 'no_eligible_peer' });
    expect(submit).not.toHaveBeenCalled();
    expect(outcomes).toEqual([
      { outcome: 'no_eligible_peer', reason: 'missing_companion_channel_contacts' },
    ]);
  });

  it('does nothing when the runtime fence or capability tier denies autonomy', async () => {
    const submit = vi.fn();
    const list = vi.fn();
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { submit },
      peers: { listKnownPeerAvailability: list },
      isAuthorized: () => false,
      now: () => T0,
    });

    const outcome = await adapter.onLeverSignal(signal());
    expect(outcome).toEqual({ kind: 'not_authorized' });
    expect(submit).not.toHaveBeenCalled();
    expect(list).not.toHaveBeenCalled();
  });

  it('throttles repeat submissions inside the local flood floor', async () => {
    let nowMs = T0;
    const submit = vi.fn(async () => submittedResult());
    const adapter = createIcpFeltImpulseInitiationAdapter({
      sourceRuntime: { submit },
      peers: { listKnownPeerAvailability: async () => [peerOf('peer-a')] },
      isAuthorized: () => true,
      now: () => nowMs,
    });

    await adapter.onLeverSignal(signal(T0));
    nowMs = T0 + 60_000;
    const second = await adapter.onLeverSignal(signal(nowMs));
    expect(second).toEqual({ kind: 'throttled', nextEligibleAtMs: T0 + FELT_IMPULSE_MIN_INTERVAL_MS });
    expect(submit).toHaveBeenCalledTimes(1);

    nowMs = T0 + FELT_IMPULSE_MIN_INTERVAL_MS;
    const third = await adapter.onLeverSignal(signal(nowMs));
    expect(third.kind).toBe('submitted');
    expect(submit).toHaveBeenCalledTimes(2);
  });
});
