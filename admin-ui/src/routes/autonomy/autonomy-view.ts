import type {
  AdminIcpCandidateView,
  AdminIcpCostProjectionStatus,
  AdminIcpCostView,
} from '../../../../src/operator/garden/services/types.js';

type CostProjectionUnavailableReason = Extract<
  AdminIcpCostProjectionStatus,
  { available: false }
>['unavailableReason'];

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

export function costProjectionUnavailableMessage(
  reason: CostProjectionUnavailableReason,
): string {
  if (reason === 'relation_contract_unavailable') {
    return 'The optional fleet cost-decision relation is missing, malformed, or unreadable. The core autonomy control plane remains available.';
  }
  if (reason === 'row_contract_invalid') {
    return 'The optional fleet cost-decision query returned malformed rows. The core autonomy control plane remains available.';
  }
  if (reason === 'read_failed') {
    return 'The optional fleet cost-decision read failed. The core autonomy control plane remains available.';
  }
  return 'The cost projection is unavailable because the ICP control plane is not provisioned.';
}
