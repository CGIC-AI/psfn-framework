import { apiGet, apiPatch, apiPost, apiPostMultipart } from '$lib/api/client';
import type { AdminIdentityData, CharacterCardV2 } from '$lib/types';

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

export interface UploadIdentityResponse {
  ok: boolean;
  message: string;
  filename?: string;
  version?: number;
  name?: string;
  containerFormat?: string;
  sourceFormat?: string;
  spec?: string;
  warnings?: string[];
}

export function uploadIdentity(file: File): Promise<UploadIdentityResponse> {
  const form = new FormData();
  form.append('file', file);
  return apiPostMultipart<UploadIdentityResponse>(
    '/api/admin/identity/upload',
    form
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

export interface DiffPreviewResponse {
  ok: boolean;
  current: CharacterCardV2;
  target: CharacterCardV2;
}

export function previewDiff(
  body: Record<string, unknown>
): Promise<DiffPreviewResponse> {
  return apiPost<DiffPreviewResponse>('/api/admin/identity/diff', body);
}

export function updateIdentityField(
  field: string,
  value: string
): Promise<{ ok: boolean; message: string }> {
  return apiPatch<{ ok: boolean; message: string }>(
    '/api/admin/identity/fields',
    { field, value }
  );
}

export interface IdentityOnboardingResponse {
  ok: boolean;
  message: string;
  onboardingRequired: boolean;
  action?: 'keep_starter' | 'edit_identity';
  updatedFields?: string[];
}

export function applyIdentityOnboardingAction(
  body: Record<string, unknown>
): Promise<IdentityOnboardingResponse> {
  return apiPost<IdentityOnboardingResponse>('/api/admin/identity/onboarding', body);
}
