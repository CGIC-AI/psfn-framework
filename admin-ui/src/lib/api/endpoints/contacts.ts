import { apiGet, apiPatch } from '../client';
import type { AdminContactListData, AdminContactDetailData } from '$lib/types';

export function listContacts(params?: { limit?: number; offset?: number }): Promise<AdminContactListData> {
  const p: Record<string, string> = {};
  if (params?.limit) p.limit = String(params.limit);
  if (params?.offset) p.offset = String(params.offset);
  return apiGet('/api/admin/contacts', p);
}

export function getContact(id: string): Promise<AdminContactDetailData> {
  return apiGet(`/api/admin/contacts/${encodeURIComponent(id)}`);
}

export function updateContact(id: string, patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }> {
  return apiPatch(`/api/admin/contacts/${encodeURIComponent(id)}`, patch);
}
