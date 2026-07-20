import { apiGet } from '$lib/api/client';
import type { AdminRoomArbiterData } from '../../../../../src/operator/garden/services/types.js';

export type RoomArbiterData = AdminRoomArbiterData;

const PATH = '/api/admin/room-arbiter';

export function getRoomArbiterData(): Promise<RoomArbiterData> {
  return apiGet<RoomArbiterData>(PATH);
}
