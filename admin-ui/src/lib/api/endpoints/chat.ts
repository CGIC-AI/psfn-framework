import { apiGet } from '../client';
import type { AdminChatBootstrapResponse } from '$lib/types';

export function getChatBootstrap(): Promise<AdminChatBootstrapResponse> {
  return apiGet('/api/chat/bootstrap');
}
