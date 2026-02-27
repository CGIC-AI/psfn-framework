import { apiGet, apiPatch } from '$lib/api/client';
import type { AdminContactListData, ContactUpdateResult, ChannelPrivacyLevel } from '$lib/types';

export function listContacts(): Promise<AdminContactListData> {
  return apiGet<AdminContactListData>('/api/admin/contacts');
}

export interface ContactUpdatePayload {
  displayName?: string;
  nickname?: string;
  trustLevel?: string;
  relationshipType?: string;
  notes?: string;
  channelPrivacy?: Array<{ channel: string; userId: string; privacyLevel: ChannelPrivacyLevel }>;
  addChannel?: { channel: string; userId: string; privacyLevel: ChannelPrivacyLevel };
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
