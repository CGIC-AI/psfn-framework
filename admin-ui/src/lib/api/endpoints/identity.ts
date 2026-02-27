import { apiGet, apiPost } from '$lib/api/client';
import type { AdminIdentityData } from '$lib/types';

export function getIdentity(): Promise<AdminIdentityData> {
  return apiGet<AdminIdentityData>('/api/admin/identity');
}

export function importIdentity(
  body: Record<string, unknown>
): Promise<{ ok: boolean; message: string }> {
  return apiPost<{ ok: boolean; message: string }>(
    '/api/admin/identity/import',
    body
  );
}

export function rollbackIdentity(
  body: Record<string, unknown>
): Promise<{ ok: boolean; message: string }> {
  return apiPost<{ ok: boolean; message: string }>(
    '/api/admin/identity/rollback',
    body
  );
}

export function previewDiff(
  body: Record<string, unknown>
): Promise<{ diff: string }> {
  return apiPost<{ diff: string }>('/api/admin/identity/diff', body);
}
