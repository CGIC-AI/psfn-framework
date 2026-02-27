import { apiGet, apiPost } from '../client';
import type { AdminIdentityData, CharacterCardV2 } from '$lib/types';

export function getIdentity(): Promise<AdminIdentityData> {
  return apiGet('/api/admin/identity');
}

export function importIdentityCard(sourcePath: string): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/identity/import', { path: sourcePath });
}

export function rollbackIdentityCard(version: number): Promise<{ ok: boolean; message: string }> {
  return apiPost('/api/admin/identity/rollback', { version });
}

export interface DiffPreviewResult {
  ok: boolean;
  current: CharacterCardV2;
  target: CharacterCardV2;
}

export function previewIdentityCardDiff(version: number): Promise<DiffPreviewResult> {
  return apiPost('/api/admin/identity/diff', { version });
}
