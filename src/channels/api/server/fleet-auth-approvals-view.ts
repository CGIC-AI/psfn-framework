import type { FleetPortalRoster } from '../../../boundary/gateway/fleet-portal-projection.js';
import type { ConfirmationQueueEntry } from '../../../system/capabilities/confirmation-queue.js';
import type { CompanionApprovalRequestedV2Payload } from '../../../shared/contracts/companion-relay.js';
import { redactApprovalRequested } from '../../backplane/companion-relay/redaction.js';

/** Gateway-owned pending approvals and their authenticated companion owners. */
export interface FleetAuthApprovalsSource {
  listPending(): readonly ConfirmationQueueEntry[];
  ownerOfConfirmation(id: string): string | undefined;
}

export interface FleetApprovalView extends CompanionApprovalRequestedV2Payload {
  readonly companionId: string;
  readonly companionDisplayName: string;
}

/**
 * Builds the authenticated fleet snapshot from one roster authorization result.
 * Ownerless, unauthorized, and attribution-mismatched entries are omitted.
 */
export function buildFleetApprovalsView(
  roster: FleetPortalRoster,
  source: FleetAuthApprovalsSource,
): readonly FleetApprovalView[] {
  const displayNameByCompanionId = new Map(
    roster.companions.map(companion => [companion.companionId, companion.displayName]),
  );
  const approvals: FleetApprovalView[] = [];
  for (const entry of source.listPending()) {
    const owner = source.ownerOfConfirmation(entry.id);
    if (owner === undefined) continue;
    const companionDisplayName = displayNameByCompanionId.get(owner);
    if (companionDisplayName === undefined) continue;
    if (entry.attribution && entry.attribution.parentId !== owner) continue;
    const redacted = redactApprovalRequested(entry, {
      sourceSystem: entry.sourceSystem ?? 'tool-access',
      attribution: {
        parentId: owner,
        parentLabel: companionDisplayName,
        ...(entry.attribution?.shardId ? { shardId: entry.attribution.shardId } : {}),
        ...(entry.attribution?.shardLabel ? { shardLabel: entry.attribution.shardLabel } : {}),
      },
      grantMode: { kind: 'once' },
    });
    approvals.push({
      companionId: owner,
      companionDisplayName,
      ...redacted,
    });
  }
  approvals.sort((left, right) => (
    left.requestedAt.localeCompare(right.requestedAt) || left.id.localeCompare(right.id)
  ));
  return approvals;
}
