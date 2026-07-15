import { describe, expect, it } from 'vitest';

import type { AdminIcpCandidateView, AdminIcpCostView } from '../../../../src/operator/garden/services/types.js';
import { canCancelIcpCandidate, costState, formatUsd } from './autonomy-view.js';

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
});
