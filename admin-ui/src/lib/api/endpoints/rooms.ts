import { apiGet } from '$lib/api/client';

export interface RoomSummary {
  channel: string;
  channelId: string;
  memberCount: number;
  firstActivity: string;
  lastActivity: string;
}

export interface RoomListData {
  rooms: RoomSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface RoomRosterMember {
  contactId: string;
  displayName: string;
  trustLevel: string;
  relationshipType: string;
  channel: string;
  channelId: string;
  privacyLevel: string | null;
  firstSeen: string;
  lastSeen: string;
}

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
  const query = params.toString();
  return apiGet<RoomListData>(`/api/admin/rooms${query ? `?${query}` : ''}`);
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
  const query = params.toString();
  return apiGet<RoomRosterData>(
    `/api/admin/rooms/${encodeURIComponent(channelId)}/roster${query ? `?${query}` : ''}`,
  );
}
