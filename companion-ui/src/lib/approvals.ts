import type { ApprovalStreamEntry, HubStreamState } from './stream/hub-stream.js';

export type ApprovalCapabilityState = 'available' | 'unsupported';

export type ApprovalRequestStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'blocked';

export interface ApprovalRequestView {
  id: string;
  title: string;
  status: ApprovalRequestStatus;
  requestedAt: string;
  expiresAt?: string;
  redactedContext: string;
  resolvedAt?: string;
  /** Whole seconds until expiry for pending requests; null when not applicable. */
  expiresInSeconds: number | null;
}

export interface ApprovalPanelState {
  capability: ApprovalCapabilityState;
  requests: ApprovalRequestView[];
  blockedReason: string | null;
}

/** Transport able to relay an approval decision to the hub (fails closed). */
export interface ApprovalDecisionTransport {
  submitApprovalDecision(id: string, decision: 'approve' | 'deny'): void;
}

export const APPROVALS_UNSUPPORTED_REASON =
  'Satellite Hub session has not acknowledged the approvals control capability';

/**
 * The approval surface is only "available" once the hub has acked our
 * `approvals` control capability on this session. The hub relays approval
 * families only to satellites that advertise them, so an absent ack means the
 * surface stays fail-closed regardless of any events that may have arrived.
 */
export function approvalsCapabilityAcked(stream: HubStreamState): boolean {
  return stream.session?.capabilities?.control?.includes('approvals') ?? false;
}

export function deriveApprovalPanelState(
  stream: HubStreamState,
  now: number = Date.now(),
): ApprovalPanelState {
  if (!approvalsCapabilityAcked(stream)) {
    return {
      capability: 'unsupported',
      requests: [],
      blockedReason: APPROVALS_UNSUPPORTED_REASON,
    };
  }
  return {
    capability: 'available',
    requests: stream.approvals.map((entry) => toRequestView(entry, now)),
    blockedReason: null,
  };
}

/**
 * Relay an approve/deny decision. Fails closed if the approvals capability is
 * not acknowledged on the current session.
 */
export function submitApprovalDecision(
  transport: ApprovalDecisionTransport,
  stream: HubStreamState,
  id: string,
  decision: 'approve' | 'deny',
): void {
  if (!approvalsCapabilityAcked(stream)) {
    throw new Error(APPROVALS_UNSUPPORTED_REASON);
  }
  transport.submitApprovalDecision(id, decision);
}

function toRequestView(entry: ApprovalStreamEntry, now: number): ApprovalRequestView {
  const view: ApprovalRequestView = {
    id: entry.id,
    title: entry.title,
    status: entry.status,
    requestedAt: entry.requestedAt,
    expiresAt: entry.expiresAt,
    redactedContext: entry.redactedContext,
    resolvedAt: entry.resolvedAt,
    expiresInSeconds: null,
  };

  if (entry.status !== 'pending' || !entry.expiresAt) {
    return view;
  }

  const expiresAtMs = Date.parse(entry.expiresAt);
  if (Number.isNaN(expiresAtMs)) {
    return view;
  }

  const remainingMs = expiresAtMs - now;
  if (remainingMs <= 0) {
    // Client-side aging: the request lapsed before the hub sent a resolution.
    return { ...view, status: 'expired', expiresInSeconds: 0 };
  }
  return { ...view, expiresInSeconds: Math.ceil(remainingMs / 1000) };
}
