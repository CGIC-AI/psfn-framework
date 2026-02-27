import { apiGet, apiPatch } from '$lib/api/client';
import type { AdminContactListData, ContactUpdateResult } from '$lib/types';

export function listContacts(): Promise<AdminContactListData> {
  return apiGet<AdminContactListData>('/api/admin/contacts');
}

export function updateContact(
  id: string,
  patch: Record<string, unknown>
): Promise<ContactUpdateResult> {
  return apiPatch<ContactUpdateResult>(
    `/api/admin/contacts/${encodeURIComponent(id)}`,
    patch
  );
}
