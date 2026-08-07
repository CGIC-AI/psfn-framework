import { apiPost } from '$lib/api/client';
import {
  createQueuePageCache,
  isAdminConfirmationsData,
} from '$lib/cache/queue-cache';
import type { LocalFirstDataSource, LocalFirstResult } from '$lib/cache/local-first';
import type {
  AdminConfirmationsData,
  ConfirmationDecision,
  ConfirmationResolveResult,
} from '$lib/types';

export type AdminConfirmationResolveResult = Omit<ConfirmationResolveResult, 'id'> & {
  ok: boolean;
};

const confirmationQueueCache = createQueuePageCache({
  key: 'confirmations',
  path: '/api/admin/confirmations',
  validate: isAdminConfirmationsData,
});

export function loadConfirmationsLocalFirst(
  onData: (data: AdminConfirmationsData, source: LocalFirstDataSource) => void,
): Promise<LocalFirstResult<AdminConfirmationsData>> {
  return confirmationQueueCache.load(onData);
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
