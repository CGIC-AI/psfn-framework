import { apiGet, apiPatch } from '$lib/api/client';
import type { AdminContactListData, ContactUpdateResult } from '$lib/types';

export function listContacts(): Promise<AdminContactListData> {
  return apiGet<AdminContactListData>('/api/admin/contacts');
}

export interface ContactUpdatePayload {
  displayName?: string;
  nickname?: string;
  trustLevel?: string;
  relationshipType?: string;
  notes?: string;
}

export function updateContact(
  id: string,
  patch: ContactUpdatePayload
): Promise<ContactUpdateResult> {
  return apiPatch<ContactUpdateResult>(
    `/api/admin/contacts/${encodeURIComponent(id)}`,
    patch
  );
}
