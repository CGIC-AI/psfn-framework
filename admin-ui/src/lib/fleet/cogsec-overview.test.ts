// waw5q — client-side fleet CogSec overview projection + aggregation tests.

import { describe, expect, it } from 'vitest';
import {
  buildFleetCogSecOverview,
  projectCompanionCogSec,
  type CompanionCogSecSnapshot,
} from './cogsec-overview';
import type { AdminIntakeQuarantineItemView } from '$lib/types';

function item(overrides: Partial<AdminIntakeQuarantineItemView> = {}): AdminIntakeQuarantineItemView {
  return {
    id: 'env-1',
    status: 'held',
    holdReason: 'detection',
    mode: 'enforce',
    sourceClass: 'web_fetch',
    sourceRiskTier: 'untrusted',
    originRef: 'redacted',
    riskLabels: [],
    scores: {},
    ruleMatches: [],
    ruleMatchTotalCount: 0,
    ruleMatchesTruncated: false,
    ruleMatchProvenanceUnavailable: false,
    heldAt: '2030-01-01T00:00:00.000Z',
    expiresAt: '2030-01-08T00:00:00.000Z',
    ttlRemainingMs: 60_000,
    rawTextTruncated: false,
    safeRepresentationAvailable: false,
    flywheelTarget: null,
    ...overrides,
  };
}

function snapshot(overrides: Partial<CompanionCogSecSnapshot> = {}): CompanionCogSecSnapshot {
  return {
    companionId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Companion A',
    reachable: true,
    policy: null,
    firewallStatus: {
      mode: 'enforce',
      queueEmptyDoesNotMeanFirewallOff: true,
      note: 'enforce',
      heldCount: 1,
      quarantineItemTtlHours: 168,
      quarantineMaxHeldItems: 500,
    },
    items: [item()],
    ...overrides,
  };
}

describe('projectCompanionCogSec', () => {
  it('counts current queue outcomes and reads the shared policy from the firewall status', () => {
    const projection = projectCompanionCogSec(snapshot({
      items: [
        item({ id: 'a', status: 'held' }),
        item({ id: 'b', status: 'released_sanitized' }),
        item({ id: 'c', status: 'released_raw' }),
        item({ id: 'd', status: 'discarded' }),
      ],
    }));
    expect(projection.outcomeCounts).toMatchObject({
      held: 1, releasedSanitized: 1, releasedRaw: 1, discarded: 1,
    });
    expect(projection.policy).toMatchObject({ mode: 'enforce', ownership: 'shared-gateway' });
  });

  it('computes decision latency from held→decided timestamps (content-free)', () => {
    const projection = projectCompanionCogSec(snapshot({
      items: [
        item({
          id: 'a',
          status: 'released_raw',
          heldAt: '2030-01-01T00:00:00.000Z',
          operatorDecision: {
            action: 'release_raw', actor: 'op', reason: 'ok',
            at: '2030-01-01T00:05:00.000Z',
          },
        }),
      ],
    }));
    expect(projection.decisionLatencyMs).toEqual([300_000]);
  });
});

describe('buildFleetCogSecOverview', () => {
  it('aggregates reachable companions and skips unreachable ones without inventing zeros', () => {
    const fixedNow = () => new Date('2030-01-01T00:00:00.000Z');
    const overview = buildFleetCogSecOverview([
      snapshot({
        companionId: '11111111-1111-4111-8111-111111111111',
        displayName: 'Companion A',
        items: [item({ id: 'a', status: 'held' })],
      }),
      snapshot({
        companionId: '22222222-2222-4222-8222-222222222222',
        displayName: 'Companion B',
        reachable: false,
        items: [],
      }),
    ], 'multi_admin', fixedNow);
    expect(overview.companionScope.count).toBe(1);
    expect(overview.companionScope.displayNames).toEqual(['Companion A']);
    expect(overview.outcomeCounts.held).toBe(1);
  });

  it('frames an all-unreachable fleet as the shared policy surface, not "firewall off"', () => {
    const overview = buildFleetCogSecOverview([
      snapshot({ reachable: false, items: [] }),
    ], 'sole_admin');
    expect(overview.companionScope.count).toBe(0);
    expect(overview.policyStatus).toBeNull();
    expect(overview.outcomeCounts.held).toBe(0);
  });
});
