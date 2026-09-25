import { apiPost } from '$lib/api/client';
import {
  FLEET_ESCALATION_GRANT_HEADER,
  withFleetEscalationGrant,
} from '$lib/api/fleet-escalation';
import { currentCompanionGardenScope } from '$lib/fleet/companion-scope';
import { usesAdminTokenOperatorDoor } from '$lib/stores/auth-storage';

/**
 * Canonical POST seam for routes whose Garden authorization requires an
 * audited escalation. Standalone Garden requests remain direct; fleet Garden
 * requests atomically mint and spend one exact-target, reason-bound grant,
 * except through the audited ADMIN_TOKEN door, which the gateway audits per
 * request and which has no SSO session to mint a grant from.
 */
export async function apiPostProtected<T>(
  target: string,
  body: unknown,
  reason: string,
): Promise<T> {
  if (!currentCompanionGardenScope() || usesAdminTokenOperatorDoor()) {
    return await apiPost<T>(target, body);
  }
  return await withFleetEscalationGrant(
    { method: 'POST', target, reason },
    async (grant, signal) => await apiPost<T>(target, body, {
      headers: { [FLEET_ESCALATION_GRANT_HEADER]: grant.grantId },
      signal,
    }),
  );
}
