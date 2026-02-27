import { apiGet } from '$lib/api/client';
import type { AdminModelRoomBootstrapResponse } from '$lib/types';

export function getModelRoomBootstrap(): Promise<AdminModelRoomBootstrapResponse> {
  return apiGet<AdminModelRoomBootstrapResponse>('/api/chat/model-room/bootstrap');
}
