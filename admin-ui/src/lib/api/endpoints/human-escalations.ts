import { apiGet, apiPost } from '$lib/api/client';
import type {
  HumanEscalationRecord,
  HumanEscalationResolutionReason,
  HumanEscalationResolutionState,
  HumanEscalationSnapshot,
} from '$lib/types';

/**
 * Fetch everything this runtime is waiting on a human for. Defaults to the open
 * queue; pass `'all'` for history.
 * Endpoint: GET /api/admin/escalations
 */
export function getHumanEscalations(
  state: 'open' | 'all' = 'open',
): Promise<HumanEscalationSnapshot> {
  return apiGet<HumanEscalationSnapshot>(`/api/admin/escalations?state=${state}`);
}

/**
 * Record what a human decided about one escalation. This never executes a
 * domain decision — a specialised workflow is still answered on its own page.
 * Endpoint: POST /api/admin/escalations/:id/resolve
 */
export function resolveHumanEscalation(
  escalationId: string,
  body: {
    state: HumanEscalationResolutionState;
    reason: HumanEscalationResolutionReason;
  },
): Promise<{ ok: true; escalation: HumanEscalationRecord }> {
  return apiPost<{ ok: true; escalation: HumanEscalationRecord }>(
    `/api/admin/escalations/${encodeURIComponent(escalationId)}/resolve`,
    body,
  );
}
