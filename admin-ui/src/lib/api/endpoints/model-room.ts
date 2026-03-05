import { apiGet } from '$lib/api/client';
import {
  normalizeModelRoomBootstrap,
  type AdminModelRoomBootstrapWireResponse,
} from '$lib/companion-name';
import type { AdminModelRoomBootstrapResponse } from '$lib/types';

export async function getModelRoomBootstrap(): Promise<AdminModelRoomBootstrapResponse> {
  const payload = await apiGet<AdminModelRoomBootstrapWireResponse>('/api/chat/model-room/bootstrap');
  return normalizeModelRoomBootstrap(payload);
}
