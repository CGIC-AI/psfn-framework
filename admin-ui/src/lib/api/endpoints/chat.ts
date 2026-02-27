import { apiGet, apiPost } from '$lib/api/client';
import type { AdminChatBootstrapResponse } from '$lib/types';

export function getChatBootstrap(): Promise<AdminChatBootstrapResponse> {
  return apiGet<AdminChatBootstrapResponse>('/api/chat/bootstrap');
}

export function updateChatBootstrap(
  body: Record<string, unknown>
): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>('/api/chat/bootstrap', body);
}
