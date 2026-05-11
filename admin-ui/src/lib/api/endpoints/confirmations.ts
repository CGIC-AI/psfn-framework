import { apiGet, apiPost } from '$lib/api/client';
import type {
  AdminConfirmationsData,
  ConfirmationDecision,
  ConfirmationResolveResult,
} from '$lib/types';

export type AdminConfirmationResolveResult = Omit<ConfirmationResolveResult, 'id'> & {
  ok: boolean;
};

/**
 * Fetch pending confirmations from the admin API.
 * Endpoint: GET /api/admin/confirmations
 *
 * When the gateway is not connected, the backend returns { available: false }.
 */
export function getConfirmations(): Promise<AdminConfirmationsData> {
  return apiGet<AdminConfirmationsData>('/api/admin/confirmations');
}

/**
 * Resolve (approve/deny/modify) a pending confirmation.
 * Endpoint: POST /api/admin/confirmations/resolve
 */
export function resolveConfirmation(
  id: string,
  decision: ConfirmationDecision,
  modifiedParams?: Record<string, unknown>,
): Promise<AdminConfirmationResolveResult> {
  return apiPost<AdminConfirmationResolveResult>('/api/admin/confirmations/resolve', {
    id,
    decision,
    modifiedParams,
  });
}
