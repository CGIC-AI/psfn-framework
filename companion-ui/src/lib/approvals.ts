import type { HubStreamState } from './stream/hub-stream.js';

export type ApprovalCapabilityState = 'available' | 'unsupported';

export interface ApprovalRequestView {
  id: string;
  title: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'blocked';
  requestedAt: string;
  expiresAt?: string;
  redactedContext: string;
}

export interface ApprovalPanelState {
  capability: ApprovalCapabilityState;
  requests: ApprovalRequestView[];
  blockedReason: string | null;
}

export const APPROVALS_UNSUPPORTED_REASON =
  'Satellite Hub protocol does not expose approval request or decision messages yet';

export function deriveApprovalPanelState(_stream: HubStreamState): ApprovalPanelState {
  return {
    capability: 'unsupported',
    requests: [],
    blockedReason: APPROVALS_UNSUPPORTED_REASON,
  };
}

export function submitApprovalDecision(): never {
  throw new Error(APPROVALS_UNSUPPORTED_REASON);
}
