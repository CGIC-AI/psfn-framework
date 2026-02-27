import { apiGet } from '../client';
import type { AdminSessionListData, AdminSessionMessagesData } from '$lib/types';

export function listSessions(): Promise<AdminSessionListData> {
  return apiGet('/api/admin/sessions');
}

export function getSessionMessages(channelId: string): Promise<AdminSessionMessagesData> {
  return apiGet(`/api/admin/sessions/${encodeURIComponent(channelId)}`);
}
