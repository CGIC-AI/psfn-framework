// ── Garden room roster service (E4.1) ──
// Operator-facing surface over the bounded room-roster queries on the contact
// store. A "room" is a conversation channel keyed by channelId; membership is
// derived ENTIRELY from existing contact_channel_activity rows (who has been
// seen in a channel) joined to the owning contact. No new modeling, no schema
// change, and — per the operator constraint — this roster is DATA only: it is
// never routed into prompt content. E3.3 (audienceScope derivation) and E4.4
// are the later consumers of the underlying query; this surface is additive and
// isolated, mirroring the contact-approvals module.

import type { ContactStorePort } from '../../../core/contacts/contact-store-port.js';
import type { RoomRosterMember, RoomSummary } from '../../../core/contacts/types.js';
import {
  DEFAULT_KNOWN_ROOMS_LIMIT,
  DEFAULT_ROOM_ROSTER_LIMIT,
  MAX_KNOWN_ROOMS_LIMIT,
  MAX_ROOM_ROSTER_LIMIT,
} from '../../../core/contacts/types.js';

export interface AdminRoomListData {
  rooms: RoomSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminRoomRosterData {
  channelId: string;
  channel?: string;
  members: RoomRosterMember[];
  total: number;
  limit: number;
  offset: number;
}

export interface AdminRoomsService {
  listRooms(params?: URLSearchParams): Promise<AdminRoomListData>;
  getRoomRoster(channelId: string, params?: URLSearchParams): Promise<AdminRoomRosterData>;
}

function parseBoundedInt(
  raw: string | null | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function parseOffset(raw: string | null | undefined): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return parsed;
}

export function createAdminRoomsService(options: {
  contactStore: ContactStorePort | null;
}): AdminRoomsService {
  const { contactStore } = options;

  return {
    async listRooms(params?: URLSearchParams): Promise<AdminRoomListData> {
      const limit = parseBoundedInt(
        params?.get('limit'),
        DEFAULT_KNOWN_ROOMS_LIMIT,
        1,
        MAX_KNOWN_ROOMS_LIMIT,
      );
      const offset = parseOffset(params?.get('offset'));
      if (!contactStore) {
        return { rooms: [], total: 0, limit, offset };
      }
      const [rooms, total] = await Promise.all([
        contactStore.listKnownRooms({ limit, offset }),
        contactStore.countKnownRooms(),
      ]);
      return { rooms, total, limit, offset };
    },

    async getRoomRoster(channelId: string, params?: URLSearchParams): Promise<AdminRoomRosterData> {
      const limit = parseBoundedInt(
        params?.get('limit'),
        DEFAULT_ROOM_ROSTER_LIMIT,
        1,
        MAX_ROOM_ROSTER_LIMIT,
      );
      const offset = parseOffset(params?.get('offset'));
      const channel = params?.get('channel')?.trim() || undefined;
      const base: AdminRoomRosterData = {
        channelId,
        ...(channel ? { channel } : {}),
        members: [],
        total: 0,
        limit,
        offset,
      };
      if (!contactStore || !channelId.trim()) {
        return base;
      }
      const [members, total] = await Promise.all([
        contactStore.listRoomRoster(channelId, { ...(channel ? { channel } : {}), limit, offset }),
        contactStore.countRoomRoster(channelId, channel ? { channel } : undefined),
      ]);
      return { ...base, members, total };
    },
  };
}
