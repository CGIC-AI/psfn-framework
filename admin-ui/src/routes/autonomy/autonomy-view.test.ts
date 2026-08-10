import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import type {
  AdminIcpCandidateView,
  AdminIcpCostView,
  AdminIcpRecentDeliveryEvent,
} from '../../../../src/operator/garden/services/types.js';
import {
  autonomySnapshotDigest,
  canCancelIcpCandidate,
  costProjectionUnavailableMessage,
  costState,
  deliveryOutcomeLabel,
  formatUsd,
  recentDeliveryLabel,
} from './autonomy-view.js';

function candidate(status: AdminIcpCandidateView['status']): AdminIcpCandidateView {
  return { status } as AdminIcpCandidateView;
}

function cost(overrides: Partial<AdminIcpCostView> = {}): AdminIcpCostView {
  return {
    conversationId: 'conversation',
    rootInitiationId: 'root',
    recordedAtMs: 1,
    actualCostUsd: 0.1,
    pendingProjectedCostUsd: 0,
    projectedTotalCostUsd: 0.1,
    warningThresholdUsd: 1,
    hardLimitUsd: 2,
    unknownCostAttemptCount: 0,
    allowed: true,
    reason: 'below_warning',
    ...overrides,
  };
}

describe('autonomy Garden view helpers', () => {
  it('only offers cancellation for nonterminal candidate states', () => {
    expect(canCancelIcpCandidate(candidate('pending'))).toBe(true);
    expect(canCancelIcpCandidate(candidate('deferred'))).toBe(true);
    expect(canCancelIcpCandidate(candidate('permitted'))).toBe(true);
    expect(canCancelIcpCandidate(candidate('consumed'))).toBe(false);
    expect(canCancelIcpCandidate(candidate('cancelled'))).toBe(false);
  });

  it('presents cost breaker state with unknown and hard stops taking precedence', () => {
    expect(costState(cost())).toBe('normal');
    expect(costState(cost({ projectedTotalCostUsd: 1.5 }))).toBe('warning');
    expect(costState(cost({ allowed: false }))).toBe('hard_stop');
    expect(costState(cost({ unknownCostAttemptCount: 1, allowed: false }))).toBe('unknown_cost');
    expect(formatUsd(1.2)).toBe('$1.2000');
  });

  it('renders optional cost unavailability separately from the control plane', () => {
    const page = readFileSync(new URL('./LazyPageContent.svelte', import.meta.url), 'utf8');
    expect(page).toContain('{#if !data.costProjection.available}');
    expect(page).toContain('Cost projection unavailable');
    expect(page).toContain('costProjectionUnavailableMessage(data.costProjection.unavailableReason)');
    expect(costProjectionUnavailableMessage('row_contract_invalid'))
      .toContain('returned malformed rows');
    expect(costProjectionUnavailableMessage('row_contract_invalid'))
      .toContain('core autonomy control plane remains available');
    expect(page).toContain('No cost-breaker decisions recorded.');
  });

  it('labels content-free delivery outcomes without leaking payload detail', () => {
    expect(deliveryOutcomeLabel('delivered')).toBe('Delivered');
    expect(deliveryOutcomeLabel('suppressed')).toBe('Resolved without sending');
    expect(deliveryOutcomeLabel('failed')).toBe('Failed');
    expect(recentDeliveryLabel(null)).toBe('No delivery events recorded');
    const initiation: AdminIcpRecentDeliveryEvent = {
      kind: 'initiation',
      outcome: 'delivered',
      timestampMs: 3_000,
    };
    expect(recentDeliveryLabel(initiation)).toBe('Initiation: delivered');
    const message: AdminIcpRecentDeliveryEvent = {
      kind: 'message',
      outcome: 'failed',
      timestampMs: 9_000,
    };
    expect(recentDeliveryLabel(message)).toBe('Message turn: failed');
  });

  it('produces a stable digest that deduplicates repeated identical snapshots', () => {
    const snapshot = {
      availability: [{ companionId: 'a' }],
      candidates: [{ candidateId: 'b', status: 'consumed' }],
      episodes: [],
      permits: [],
      fatigue: [],
      costs: [],
      quietState: 'active',
      runtimeEnabled: true,
      delivery: {
        currentAvailability: null,
        initiation: { invited: 0, delivered: 1 },
        messages: { delivered: 1, pending: 0, failed: 0, observed: 1 },
        recentOutcome: { kind: 'initiation', outcome: 'delivered', timestampMs: 3_000 },
      },
    };
    const digest = autonomySnapshotDigest(snapshot);
    expect(autonomySnapshotDigest({ ...snapshot })).toBe(digest);
    const changed = autonomySnapshotDigest({
      ...snapshot,
      delivery: { ...snapshot.delivery, initiation: { invited: 0, delivered: 2 } },
    });
    expect(changed).not.toBe(digest);
  });
});
