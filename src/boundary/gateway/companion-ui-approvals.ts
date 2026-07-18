import { redactApprovalRequested } from '../../channels/backplane/companion-relay/redaction.js';
import type {
  ConfirmationQueueEntry,
  ConfirmationResolveResult,
} from '../../system/capabilities/confirmation-queue.js';
import type { CompiledCompanionUiAction } from '../fleet-auth/companion-ui-action.js';

export interface CompanionUiApprovalGatewayPort {
  listCompanionUiConfirmations(companionId: string): readonly ConfirmationQueueEntry[];
  resolveCompanionUiApproval(
    companionId: string,
    params: Readonly<{ id: string; decision: 'approve' | 'deny' }>,
  ): Promise<ConfirmationResolveResult>;
}

function projectPendingApproval(
  entry: ConfirmationQueueEntry,
  companionId: string,
): ReturnType<typeof redactApprovalRequested> | undefined {
  if (!entry.attribution
    || entry.attribution.parentId !== companionId
    || entry.approvalOwner?.companionId !== companionId
    || entry.attribution.shardId !== entry.approvalOwner.shardId) {
    return undefined;
  }
  return redactApprovalRequested(entry, {
    sourceSystem: entry.sourceSystem ?? 'tool-access',
    attribution: entry.attribution,
    grantMode: { kind: 'once' },
  });
}

/**
 * Dispatches the confirmation subset of the Companion UI action protocol.
 * Owner scoping is applied again at the gateway port even though the browser
 * broker already checked resolution ownership, keeping this boundary safe for
 * callers that do not pass through that broker.
 */
export async function dispatchCompanionUiApproval(input: {
  readonly compiled: CompiledCompanionUiAction;
  readonly gateway: CompanionUiApprovalGatewayPort;
}): Promise<Readonly<{ handled: false }> | Readonly<{ handled: true; result: unknown }>> {
  const resource = input.compiled.frame.resource;
  if (resource !== 'confirmations.list' && resource !== 'confirmations.resolve') {
    return Object.freeze({ handled: false });
  }

  const companionId = input.compiled.target.companionId;
  if (resource === 'confirmations.list') {
    const approvals = input.gateway.listCompanionUiConfirmations(companionId)
      .flatMap((entry) => {
        const projected = projectPendingApproval(entry, companionId);
        return projected ? [projected] : [];
      });
    return Object.freeze({
      handled: true,
      result: Object.freeze({
        schemaVersion: 1,
        approvals: Object.freeze(approvals),
      }),
    });
  }

  const body = input.compiled.frame.body as Readonly<{
    id: string;
    decision: 'approve' | 'deny';
  }>;
  return Object.freeze({
    handled: true,
    result: await input.gateway.resolveCompanionUiApproval(companionId, {
      id: body.id,
      decision: body.decision,
    }),
  });
}
