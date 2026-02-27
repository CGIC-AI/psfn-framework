import { apiGet } from '$lib/api/client';
import type { AdminSessionListData, AdminSessionMessagesData } from '$lib/types';

export function listSessions(): Promise<AdminSessionListData> {
  return apiGet<AdminSessionListData>('/api/admin/sessions');
}

export function getSessionMessages(
  channelId: string
): Promise<AdminSessionMessagesData> {
  return apiGet<AdminSessionMessagesData>(
    `/api/admin/sessions/${encodeURIComponent(channelId)}`
  );
}
