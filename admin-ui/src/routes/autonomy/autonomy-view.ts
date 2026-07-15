import type { AdminIcpCandidateView, AdminIcpCostView } from '../../../../src/operator/garden/services/types.js';

export function canCancelIcpCandidate(candidate: AdminIcpCandidateView): boolean {
  return candidate.status === 'pending'
    || candidate.status === 'deferred'
    || candidate.status === 'permitted';
}

export function costState(cost: AdminIcpCostView): 'normal' | 'warning' | 'hard_stop' | 'unknown_cost' {
  if (cost.unknownCostAttemptCount > 0) return 'unknown_cost';
  if (!cost.allowed || cost.projectedTotalCostUsd > cost.hardLimitUsd) return 'hard_stop';
  if (cost.projectedTotalCostUsd > cost.warningThresholdUsd) return 'warning';
  return 'normal';
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(4)}`;
}
