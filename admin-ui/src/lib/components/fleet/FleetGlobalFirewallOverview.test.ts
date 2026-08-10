import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import FleetGlobalFirewallOverview from './FleetGlobalFirewallOverview.svelte';
import type { FleetCogSecOverview } from '$lib/types';

function overview(overrides: Partial<FleetCogSecOverview> = {}): FleetCogSecOverview {
  return {
    generatedAt: '2030-01-01T00:00:00.000Z',
    companionScope: {
      count: 2,
      displayNames: ['Companion A', 'Companion B'],
      accessMode: 'multi_admin',
    },
    policyStatus: {
      mode: 'enforce',
      quarantineItemTtlHours: 168,
      quarantineMaxHeldItems: 500,
      ownership: 'shared-gateway',
    },
    outcomeCounts: {
      held: 3,
      releasedSanitized: 1,
      releasedRaw: 1,
      discarded: 2,
      expired: 0,
      cleared: 4,
      blockedEgress: 1,
    },
    severityCounts: { low: 1, medium: 3, high: 1, critical: 0 },
    latency: { decidedCount: 4, medianDecisionMs: 120_000, p95DecisionMs: 300_000, maxDecisionMs: 300_000 },
    correlation: { groupCount: 1, totalMembers: 4, largestGroup: 4 },
    ...overrides,
  };
}

describe('FleetGlobalFirewallOverview (waw5q)', () => {
  it('frames the surface as the cluster-owned shared gateway posture, not a companion', () => {
    const body = render(FleetGlobalFirewallOverview, {
      props: { overview: overview(), reachableCount: 2 },
    }).body;
    expect(body).toContain('Shared mode');
    expect(body).toContain('enforce');
    expect(body).toContain('Authorized scope: 2 companions');
    expect(body).toContain('Companion A, Companion B');
  });

  it('states the empty-queue guarantee so an empty aggregate never reads as firewall off', () => {
    const body = render(FleetGlobalFirewallOverview, {
      props: { overview: overview(), reachableCount: 0 },
    }).body;
    expect(body).toContain('never');
    expect(body).toContain('firewall is off');
  });

  it('reports policy as unavailable instead of off when no companion is reachable', () => {
    const body = render(FleetGlobalFirewallOverview, {
      props: { overview: overview({ policyStatus: null }), reachableCount: 0 },
    }).body;
    expect(body).toContain('posture is unavailable');
    expect(body).not.toContain('No intake screening is enforced anywhere');
  });

  it('renders content-free outcome counts and correlation without any message bodies', () => {
    const body = render(FleetGlobalFirewallOverview, {
      props: { overview: overview(), reachableCount: 2 },
    }).body;
    expect(body).toContain('Aggregate outcomes (content-free)');
    expect(body).toContain('Held');
    expect(body).toContain('Group fanout correlation');
    expect(body).toContain('Decision latency');
    // No private per-companion data beyond the authorized scope display names.
    expect(body).not.toContain('contact-other');
    expect(body).not.toContain('sha256');
  });

  it('frames an off-mode shared policy truthfully (empty queue still never means off)', () => {
    const body = render(FleetGlobalFirewallOverview, {
      props: {
        overview: overview({
          policyStatus: { mode: 'off', quarantineItemTtlHours: 0, quarantineMaxHeldItems: 0, ownership: 'shared-gateway' },
        }),
        reachableCount: 0,
      },
    }).body;
    expect(body).toContain('No intake screening is enforced anywhere');
    expect(body).toContain('firewall is off');
  });
});
