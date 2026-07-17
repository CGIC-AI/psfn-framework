import {
  deriveApprovalPanelState,
  submitApprovalDecision,
  type ApprovalDecisionTransport,
  type ApprovalPanelState,
} from './approvals.js';
import type { FleetApprovalEntry } from './fleet-roster.js';
import type { HubStreamState } from './stream/hub-stream.js';

interface ApprovalStore extends ApprovalDecisionTransport {
  snapshot(): HubStreamState;
}

export function hasPendingApprovalExpiry(
  stream: HubStreamState,
  fleet: readonly FleetApprovalEntry[],
): boolean {
  return stream.approvals.some(entry => entry.status === 'pending' && Boolean(entry.expiresAt))
    || fleet.some(entry => Boolean(entry.expiresAt) && !stream.approvalResolutions[entry.id]);
}

export async function routeFleetApprovalDecision(input: {
  id: string;
  decision: 'approve' | 'deny';
  fleetApproval?: FleetApprovalEntry;
  activeCompanionId: string | null;
  switchCompanion: (companionId: string) => Promise<boolean>;
  currentStore: () => ApprovalStore | null;
}): Promise<boolean> {
  if (input.fleetApproval
    && input.fleetApproval.companionId !== input.activeCompanionId
    && !await input.switchCompanion(input.fleetApproval.companionId)) {
    return false;
  }
  const store = input.currentStore();
  if (!store) return false;
  submitApprovalDecision(store, store.snapshot(), input.id, input.decision);
  return true;
}

export function mergeFleetApprovals(
  stream: HubStreamState,
  fleet: readonly FleetApprovalEntry[],
  now: number,
): ApprovalPanelState {
  const panel = deriveApprovalPanelState(stream, now);
  if (panel.capability !== 'available' || fleet.length === 0) return panel;
  const requests = new Map(panel.requests.map(request => [request.id, request]));
  for (const entry of fleet) {
    const expiresAtMs = entry.expiresAt ? Date.parse(entry.expiresAt) : Number.NaN;
    const remainingMs = Number.isFinite(expiresAtMs) ? expiresAtMs - now : Number.NaN;
    const resolution = stream.approvalResolutions[entry.id];
    requests.set(entry.id, {
      id: entry.id,
      title: entry.title,
      status: resolution?.status
        ?? (Number.isFinite(remainingMs) && remainingMs <= 0 ? 'expired' : 'pending'),
      requestedAt: entry.requestedAt,
      ...(entry.expiresAt ? { expiresAt: entry.expiresAt } : {}),
      redactedContext: entry.redactedContext,
      ...(resolution ? { resolvedAt: resolution.resolvedAt } : {}),
      expiresInSeconds: Number.isFinite(remainingMs)
        ? Math.max(0, Math.ceil(remainingMs / 1000))
        : null,
      sourceSystem: entry.sourceSystem,
      attribution: { ...entry.attribution },
      action: entry.action,
      scope: entry.scope,
      reason: entry.reason,
      grantMode: { ...entry.grantMode },
    });
  }
  return {
    capability: panel.capability,
    requests: [...requests.values()].sort((left, right) => (
      left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id)
    )),
    blockedReason: null,
  };
}
