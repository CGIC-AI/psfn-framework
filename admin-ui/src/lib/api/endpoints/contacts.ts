import { apiGet, apiPut, apiPatch, apiPost, apiDelete } from '$lib/api/client';
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
  return apiPut<ContactUpdateResult>(
    `/api/admin/contacts/${encodeURIComponent(id)}`,
    patch
  );
}

export function updateContactLegacyPatch(
  id: string,
  patch: ContactUpdatePayload
): Promise<ContactUpdateResult> {
  return apiPatch<ContactUpdateResult>(
    `/api/admin/contacts/${encodeURIComponent(id)}`,
    patch,
  );
}

export interface ContactCreatePayload {
  displayName: string;
  trustLevel?: string;
  relationshipType?: string;
  notes?: string;
}

export function createContact(payload: ContactCreatePayload): Promise<ContactUpdateResult> {
  return apiPost<ContactUpdateResult>('/api/admin/contacts', payload);
}

export function deleteContact(id: string): Promise<ContactUpdateResult> {
  return apiDelete<ContactUpdateResult>(`/api/admin/contacts/${encodeURIComponent(id)}`);
}

export function mergeContacts(targetId: string, sourceId: string): Promise<ContactUpdateResult> {
  return apiPost<ContactUpdateResult>(
    `/api/admin/contacts/${encodeURIComponent(targetId)}/merge`,
    { sourceId },
  );
}

export function unlinkChannelIdentity(
  contactId: string,
  channel: string,
  userId: string,
): Promise<ContactUpdateResult> {
  return apiPost<ContactUpdateResult>(
    `/api/admin/contacts/${encodeURIComponent(contactId)}/unlink`,
    { channel, userId },
  );
}
