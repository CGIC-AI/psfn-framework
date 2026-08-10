// waw5q — cluster-owned, content-free fleet CogSec overview aggregation tests.
// Covers the sole-admin (one rostered human) and multi-admin (subject boundary)
// authorization scopes, content-free guarantees, and group-fanout correlation.

import { describe, expect, it } from 'vitest';
import {
  aggregateFleetCogSecOverview,
  countIntakeOutcomes,
  type FleetCogSecCompanionProjection,
} from './fleet-cogsec-overview.js';

const FIXED_NOW = new Date('2030-01-01T00:00:00.000Z');

function companion(overrides: Partial<FleetCogSecCompanionProjection> = {}): FleetCogSecCompanionProjection {
  return {
    companionId: '11111111-1111-4111-8111-111111111111',
    displayName: 'Companion A',
    policy: {
      mode: 'strict',
      quarantineItemTtlHours: 168,
      quarantineMaxHeldItems: 500,
      ownership: 'shared-gateway',
    },
    outcomeCounts: {
      held: 1,
      releasedSanitized: 0,
      releasedRaw: 0,
      discarded: 0,
      expired: 0,
      cleared: 0,
      blockedEgress: 0,
    },
    severityCounts: { low: 0, medium: 1, high: 0, critical: 0 },
    decisionLatencyMs: [],
    correlationKeys: [],
    ...overrides,
  };
}

describe('aggregateFleetCogSecOverview — sole-admin scope', () => {
  it('aggregates a single authorized companion and records the sole-admin scope', () => {
    const overview = aggregateFleetCogSecOverview([companion()], {
      accessMode: 'sole_admin',
      now: () => FIXED_NOW,
    });
    expect(overview.companionScope).toEqual({
      count: 1,
      displayNames: ['Companion A'],
      accessMode: 'sole_admin',
    });
    expect(overview.policyStatus?.mode).toBe('strict');
    expect(overview.policyStatus?.ownership).toBe('shared-gateway');
    expect(overview.outcomeCounts.held).toBe(1);
  });

  it('reports no cluster access (never "firewall off") when no companion is authorized', () => {
    const overview = aggregateFleetCogSecOverview([], {
      accessMode: 'sole_admin',
      now: () => FIXED_NOW,
    });
    expect(overview.companionScope.count).toBe(0);
    // An empty authorized scope is framed as no access, not as the firewall being off.
    expect(overview.outcomeCounts.held).toBe(0);
    expect(overview.policyStatus).toBeNull();
  });
});

describe('aggregateFleetCogSecOverview — multi-admin scope', () => {
  it('unions content-free outcomes across authorized companions without mixing private data', () => {
    const a = companion({
      companionId: '11111111-1111-4111-8111-111111111111',
      displayName: 'Companion A',
      outcomeCounts: { held: 2, releasedSanitized: 1, releasedRaw: 0, discarded: 0, expired: 0, cleared: 3, blockedEgress: 1 },
      severityCounts: { low: 1, medium: 2, high: 1, critical: 0 },
      decisionLatencyMs: [1_000, 2_000, 3_000],
      correlationKeys: ['fanout-1', 'fanout-1', 'fanout-2'],
    });
    const b = companion({
      companionId: '22222222-2222-4222-8222-222222222222',
      displayName: 'Companion B',
      outcomeCounts: { held: 1, releasedSanitized: 0, releasedRaw: 1, discarded: 2, expired: 1, cleared: 0, blockedEgress: 0 },
      severityCounts: { low: 0, medium: 1, high: 0, critical: 1 },
      decisionLatencyMs: [4_000],
      correlationKeys: ['fanout-1', 'fanout-3'],
    });
    const overview = aggregateFleetCogSecOverview([a, b], {
      accessMode: 'multi_admin',
      now: () => FIXED_NOW,
    });
    expect(overview.companionScope).toEqual({
      count: 2,
      displayNames: ['Companion A', 'Companion B'],
      accessMode: 'multi_admin',
    });
    expect(overview.outcomeCounts).toEqual({
      held: 3, releasedSanitized: 1, releasedRaw: 1, discarded: 2, expired: 1, cleared: 3, blockedEgress: 1,
    });
    expect(overview.severityCounts).toEqual({ low: 1, medium: 3, high: 1, critical: 1 });
    // Latency is computed over all authorized companions' decided items.
    expect(overview.latency.decidedCount).toBe(4);
    expect(overview.latency.maxDecisionMs).toBe(4_000);
    // No companion-specific private data appears on the aggregate: only counts.
    const serialized = JSON.stringify(overview);
    for (const displayName of ['Companion A', 'Companion B']) {
      // Display names of the authorized scope are legitimately on companionScope;
      // they must NOT appear anywhere else (no per-companion breakdown leaks).
      const occurrences = serialized.split(`"${displayName}"`).length - 1;
      expect(occurrences).toBe(1);
    }
  });

  it('correlates a group fanout across companions without duplicating content', () => {
    // 'fanout-1' reaches both companions (4 members total across the union);
    // the aggregate counts one group with the correct member count and no body.
    const a = companion({
      companionId: '11111111-1111-4111-8111-111111111111',
      correlationKeys: ['fanout-1', 'fanout-1'],
    });
    const b = companion({
      companionId: '22222222-2222-4222-8222-222222222222',
      correlationKeys: ['fanout-1', 'fanout-1'],
    });
    const overview = aggregateFleetCogSecOverview([a, b], { accessMode: 'multi_admin' });
    expect(overview.correlation).toEqual({ groupCount: 1, totalMembers: 4, largestGroup: 4 });
  });

  it('rejects companions that disagree on the shared gateway policy (drift is never averaged)', () => {
    const a = companion({ policy: { mode: 'strict', quarantineItemTtlHours: 168, quarantineMaxHeldItems: 500, ownership: 'shared-gateway' } });
    const b = companion({
      companionId: '22222222-2222-4222-8222-222222222222',
      policy: { mode: 'shadow', quarantineItemTtlHours: 168, quarantineMaxHeldItems: 500, ownership: 'shared-gateway' },
    });
    expect(() => aggregateFleetCogSecOverview([a, b], { accessMode: 'multi_admin' })).toThrow(/shared gateway policy/u);
  });

  it('rejects a duplicate companion so a multi-admin scope cannot double-count', () => {
    const a = companion();
    expect(() => aggregateFleetCogSecOverview([a, a], { accessMode: 'multi_admin' })).toThrow(/duplicate companion/u);
  });
});

describe('countIntakeOutcomes', () => {
  it('buckets inbound lifecycle rows and outbound egress blocks separately', () => {
    const counts = countIntakeOutcomes([
      { status: 'held', direction: 'inbound' },
      { status: 'released_sanitized', direction: 'inbound' },
      { status: 'released_raw', direction: 'inbound' },
      { status: 'discarded', direction: 'inbound' },
      { status: 'expired', direction: 'inbound' },
      { status: 'cleared', direction: 'inbound' },
      { status: 'applied', direction: 'outbound' },
    ]);
    expect(counts).toEqual({
      held: 1, releasedSanitized: 1, releasedRaw: 1, discarded: 1, expired: 1, cleared: 1, blockedEgress: 1,
    });
  });
});
