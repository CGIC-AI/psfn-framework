import { apiGet } from '$lib/api/client';
import { withQuery } from '$lib/api/query';
import type {
  RoomRosterMember as CanonicalRoomRosterMember,
  RoomSummary as CanonicalRoomSummary,
} from '../../../../../src/core/contacts/types.js';

export type RoomSummary = CanonicalRoomSummary;

export interface RoomListData {
  rooms: RoomSummary[];
  total: number;
  limit: number;
  offset: number;
}

export type RoomRosterMember = CanonicalRoomRosterMember;

export interface RoomRosterData {
  channelId: string;
  channel?: string;
  members: RoomRosterMember[];
  total: number;
  limit: number;
  offset: number;
}

/**
 * List known rooms (distinct conversation channels) with member counts and
 * activity bounds. Room roster is DATA only (E4.1) — never prompt content.
 * Endpoint: GET /api/admin/rooms
 */
export function getRooms(options?: { limit?: number; offset?: number }): Promise<RoomListData> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  return apiGet<RoomListData>(withQuery('/api/admin/rooms', params));
}

/**
 * Fetch the paginated known-member roster for one room, ordered by last-seen.
 * Endpoint: GET /api/admin/rooms/:channelId/roster
 */
export function getRoomRoster(
  channelId: string,
  options?: { limit?: number; offset?: number; channel?: string },
): Promise<RoomRosterData> {
  const params = new URLSearchParams();
  if (options?.limit !== undefined) params.set('limit', String(options.limit));
  if (options?.offset !== undefined) params.set('offset', String(options.offset));
  if (options?.channel) params.set('channel', options.channel);
  return apiGet<RoomRosterData>(
    withQuery(`/api/admin/rooms/${encodeURIComponent(channelId)}/roster`, params),
  );
}
