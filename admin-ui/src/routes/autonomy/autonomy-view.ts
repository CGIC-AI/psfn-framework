import type {
  AdminIcpCandidateView,
  AdminIcpCostProjectionStatus,
  AdminIcpCostView,
  AdminIcpRecentDeliveryEvent,
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

/**
 * Human label for a content-free delivery outcome. The outcome enum is the
 * only delivery detail that leaves the control plane; no message body, channel
 * identity, contact identity, provenance text, or reason summary is rendered.
 */
export function deliveryOutcomeLabel(outcome: AdminIcpRecentDeliveryEvent['outcome']): string {
  switch (outcome) {
    case 'delivered':
      return 'Delivered';
    case 'suppressed':
      return 'Resolved without sending';
    case 'deferred':
      return 'Deferred';
    case 'declined':
      return 'Declined';
    case 'failed':
      return 'Failed';
    case 'expired':
      return 'Expired before resolution';
    default:
      return outcome;
  }
}

/** Most recent resolved delivery event as a single content-free sentence. */
export function recentDeliveryLabel(event: AdminIcpRecentDeliveryEvent | null): string {
  if (!event) return 'No delivery events recorded';
  const kind = event.kind === 'initiation' ? 'Initiation' : 'Message turn';
  return `${kind}: ${deliveryOutcomeLabel(event.outcome).toLowerCase()}`;
}

/**
 * Stable content digest for deduplicating repeated identical Garden snapshots.
 * The projection is already content-free, so a canonical JSON identity of its
 * telemetry-bearing fields bounds UI re-renders without leaking anything new.
 */
export function autonomySnapshotDigest(data: {
  availability: unknown;
  candidates: unknown;
  episodes: unknown;
  permits: unknown;
  fatigue: unknown;
  costs: unknown;
  quietState: unknown;
  runtimeEnabled: unknown;
  delivery: unknown;
}): string {
  return JSON.stringify({
    a: data.availability,
    c: data.candidates,
    e: data.episodes,
    p: data.permits,
    f: data.fatigue,
    co: data.costs,
    q: data.quietState,
    rn: data.runtimeEnabled,
    d: data.delivery,
  });
}
