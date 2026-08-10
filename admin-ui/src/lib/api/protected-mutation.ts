import { apiPost } from '$lib/api/client';
import {
  FLEET_ESCALATION_GRANT_HEADER,
  withFleetEscalationGrant,
} from '$lib/api/fleet-escalation';
import { currentCompanionGardenScope } from '$lib/fleet/companion-scope';

/**
 * Canonical POST seam for routes whose Garden authorization requires an
 * audited escalation. Standalone Garden requests remain direct; fleet Garden
 * requests atomically mint and spend one exact-target, reason-bound grant.
 */
export async function apiPostProtected<T>(
  target: string,
  body: unknown,
  reason: string,
): Promise<T> {
  if (!currentCompanionGardenScope()) {
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
