import { apiGet, apiPost } from '../client';
import type { AdminIdentityData } from '$lib/types';

export function getIdentity(): Promise<AdminIdentityData> {
  return apiGet('/api/admin/identity');
}

export function importIdentityCard(card: unknown): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/identity/import', card);
}

export function rollbackIdentityCard(body: { version: number }): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/identity/card/rollback', body);
}
