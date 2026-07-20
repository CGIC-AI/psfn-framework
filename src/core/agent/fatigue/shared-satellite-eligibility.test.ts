import { describe, expect, it, vi } from 'vitest';
import type { FatigueLedger } from '../../../shared/telemetry/fatigue-ledger.js';
import { resolveSharedSatelliteFatigueEligibility } from './shared-satellite-eligibility.js';

function ledgerWithHardState(hardState?: 'available' | 'exhausted') {
  return {
    getData: vi.fn(() => ({
      aggregates: {
        amount: 0,
        eventCount: 0,
        byChannel: [],
        byPeer: [],
        byDay: [],
        byDecision: [],
        scopes: [],
      },
      events: hardState
        ? [{ event: { hardState } }]
        : [],
    })),
  };
}

describe('resolveSharedSatelliteFatigueEligibility', () => {
  it('fails the pre-model gate for an exhausted exact partner/channel scope', () => {
    const fatigueLedger = ledgerWithHardState('exhausted');

    expect(resolveSharedSatelliteFatigueEligibility({
      fatigueLedger: fatigueLedger as unknown as Pick<FatigueLedger, 'getData'>,
      localCompanionId: 'companion-a',
      canonicalContactId: 'contact-partner',
      channelId: 'satellite:voice:session-1',
    })).toEqual({ fatigueAllows: false });
    expect(fatigueLedger.getData).toHaveBeenCalledWith({
      localCompanionId: 'companion-a',
      peerContactId: 'contact-partner',
      channelId: 'satellite:voice:session-1',
      limit: 1,
    });
  });

  it('allows a scope with no recorded fatigue and rejects missing identity', () => {
    expect(resolveSharedSatelliteFatigueEligibility({
      fatigueLedger: ledgerWithHardState() as unknown as Pick<FatigueLedger, 'getData'>,
      localCompanionId: 'companion-a',
      canonicalContactId: 'contact-partner',
      channelId: 'satellite:voice:session-1',
    })).toEqual({ fatigueAllows: true });

    expect(() => resolveSharedSatelliteFatigueEligibility({
      fatigueLedger: ledgerWithHardState() as unknown as Pick<FatigueLedger, 'getData'>,
      localCompanionId: 'companion-a',
      canonicalContactId: ' ',
      channelId: 'satellite:voice:session-1',
    })).toThrow(/exact companion, contact, and channel identity/);
  });
});
