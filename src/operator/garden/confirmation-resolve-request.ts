import { isRecord } from '../../shared/utils/types.js';
import type { ConfirmationResolveParams } from '../../boundary/gateway/protocol.js';

/**
 * Parsed operator confirmation-resolution request.
 *
 * Shared by the agent-hosted admin route (agent-local resolution) and the
 * Garden operator surface (operator → gateway resolution) so both boundaries
 * apply identical, fail-closed validation before a confirmation is resolved
 * (x5rt.10).
 */
export type ParsedConfirmationResolveRequest =
  | { ok: true; params: ConfirmationResolveParams }
  | { ok: false; error: string };

export function parseConfirmationResolveRequest(
  payload: unknown,
): ParsedConfirmationResolveRequest {
  if (!isRecord(payload)) {
    return { ok: false, error: 'Confirmation resolution payload must be a JSON object.' };
  }

  const id = typeof payload.id === 'string' ? payload.id.trim() : '';
  if (!id) {
    return { ok: false, error: 'Confirmation ID is required' };
  }

  const decision = typeof payload.decision === 'string' ? payload.decision.trim() : '';
  if (decision !== 'approve' && decision !== 'deny' && decision !== 'modify') {
    return { ok: false, error: 'Invalid decision (must be approve, deny, or modify)' };
  }

  const params: ConfirmationResolveParams = {
    id,
    decision,
  };

  if (decision === 'modify') {
    if (!isRecord(payload.modifiedParams)) {
      return { ok: false, error: 'Modified params are required and must be a JSON object.' };
    }
    params.modifiedParams = payload.modifiedParams;
  }

  return { ok: true, params };
}
