import type Database from 'better-sqlite3';
import type {
  Contact,
  ContactChannel,
  ChannelPrivacyLevel,
  ContactIdentityLinkVerification,
  RelationshipType,
  RoomQueryOptions,
  RoomRosterMember,
  RoomSummary,
} from '../types.js';
import {
  DEFAULT_KNOWN_ROOMS_LIMIT,
  DEFAULT_ROOM_ROSTER_LIMIT,
  MAX_KNOWN_ROOMS_LIMIT,
  MAX_ROOM_ROSTER_LIMIT,
} from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type {
  ContactIdentityVerificationRow,
  ContactRow,
} from './domain-types.js';
import { hydrateContact } from './hydration.js';
import {
  LEGACY_DISCORD_CHANNEL,
  normalizeIdentity,
  normalizePrivacyLevel,
  toIdentityLinkVerification,
} from './identity-utils.js';
import { upsertIdentityLink } from './upsert.js';

export function getContactById(db: Database.Database, id: string): Contact | undefined {
  const row = db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
  return row ? hydrateContact(db, row) : undefined;
}

export function getContactByChannelIdentity(
  db: Database.Database,
  channel: ContactChannel,
  channelUserId: string,
): Contact | undefined {
  const identity = normalizeIdentity(channel, channelUserId);

  const row = db.prepare(`
    SELECT c.*
    FROM contacts c
    INNER JOIN contact_channel_ids i ON i.contact_id = c.id
    WHERE i.channel = ? AND i.channel_user_id = ?
    LIMIT 1
  `).get(identity.channel, identity.userId) as ContactRow | undefined;

  if (row) return hydrateContact(db, row);

  if (identity.channel === LEGACY_DISCORD_CHANNEL) {
    const legacyRow = db.prepare('SELECT * FROM contacts WHERE discord_user_id = ?')
      .get(identity.userId) as ContactRow | undefined;
    if (legacyRow) {
      upsertIdentityLink(
        db,
        legacyRow.id,
        identity,
        legacyRow.first_seen,
        legacyRow.last_seen,
      );
      return hydrateContact(db, legacyRow);
    }
  }

  return undefined;
}

export function getContactByDiscordUserId(
  db: Database.Database,
  discordUserId: string,
): Contact | undefined {
  const trimmedDiscordId = discordUserId.trim();
  if (!trimmedDiscordId) return undefined;

  const row = db.prepare('SELECT * FROM contacts WHERE discord_user_id = ?')
    .get(trimmedDiscordId) as ContactRow | undefined;

  if (row) return hydrateContact(db, row);
  return getContactByChannelIdentity(db, LEGACY_DISCORD_CHANNEL, trimmedDiscordId);
}

export function getContactsByTrustLevel(
  db: Database.Database,
  trustLevel: TrustLevel,
): Contact[] {
  const rows = db.prepare('SELECT * FROM contacts WHERE trust_level = ?')
    .all(trustLevel) as ContactRow[];
  return rows.map(row => hydrateContact(db, row));
}

export function listAllContacts(db: Database.Database): Contact[] {
  const rows = db.prepare('SELECT * FROM contacts ORDER BY last_seen DESC').all() as ContactRow[];
  return rows.map(row => hydrateContact(db, row));
}

export function listIdentityLinkVerifications(
  db: Database.Database,
  limit = 25,
): ContactIdentityLinkVerification[] {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), 200))
    : 25;

  const rows = db.prepare(`
    SELECT *
    FROM contact_identity_link_verifications
    ORDER BY created_at DESC
    LIMIT ?
  `).all(normalizedLimit) as ContactIdentityVerificationRow[];

  return rows.map(row => toIdentityLinkVerification(row));
}

export function getCanonicalContactKey(
  db: Database.Database,
  channel: ContactChannel,
  channelUserId: string,
): string | undefined {
  const contact = getContactByChannelIdentity(db, channel, channelUserId);
  return contact?.id;
}

export function getConversationChannelPrivacy(
  db: Database.Database,
  contactId: string,
  channel: ContactChannel,
  channelId: string,
): ChannelPrivacyLevel | undefined {
  const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return undefined;

  const row = db.prepare(`
    SELECT privacy_level
    FROM contact_channel_activity
    WHERE contact_id = ? AND channel = ? AND channel_id = ?
    LIMIT 1
  `).get(contactId, normalizedChannel, trimmedChannelId) as { privacy_level?: string | null } | undefined;

  if (!row?.privacy_level) return undefined;
  return normalizePrivacyLevel(row.privacy_level as ChannelPrivacyLevel, normalizedChannel);
}

// ── Room roster (E4.1) ──
// Bounded, read-only queries over contact_channel_activity joined to the owning
// contact row. Deliberately NO full-contact hydration (no hydrateContact / no
// listAllContacts): only the columns the operator room surface needs are
// selected, so a large contact table never inflates a roster page. E3.3
// (audienceScope) and E4.4 are the later consumers of this data.

function clampLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const floored = Math.floor(limit);
  if (floored <= 0) return fallback;
  return Math.min(floored, max);
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const floored = Math.floor(offset);
  return floored > 0 ? floored : 0;
}

interface KnownRoomRow {
  channel: string;
  channel_id: string;
  member_count: number;
  first_activity: string;
  last_activity: string;
}

export function listKnownRooms(
  db: Database.Database,
  options?: Pick<RoomQueryOptions, 'limit' | 'offset'>,
): RoomSummary[] {
  const limit = clampLimit(options?.limit, DEFAULT_KNOWN_ROOMS_LIMIT, MAX_KNOWN_ROOMS_LIMIT);
  const offset = clampOffset(options?.offset);
  const rows = db.prepare(`
    SELECT channel,
           channel_id,
           COUNT(*) AS member_count,
           MIN(first_seen) AS first_activity,
           MAX(last_seen) AS last_activity
    FROM contact_channel_activity
    GROUP BY channel, channel_id
    ORDER BY last_activity DESC, channel ASC, channel_id ASC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as KnownRoomRow[];

  return rows.map(row => ({
    channel: row.channel,
    channelId: row.channel_id,
    memberCount: Number(row.member_count),
    firstActivity: row.first_activity,
    lastActivity: row.last_activity,
  }));
}

export function countKnownRooms(db: Database.Database): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS total FROM (
      SELECT 1 FROM contact_channel_activity GROUP BY channel, channel_id
    )
  `).get() as { total: number } | undefined;
  return Number(row?.total ?? 0);
}

interface RoomRosterRow {
  contact_id: string;
  display_name: string;
  trust_level: string;
  relationship_type: string;
  channel: string;
  channel_id: string;
  privacy_level: string | null;
  first_seen: string;
  last_seen: string;
}

export function listRoomRoster(
  db: Database.Database,
  channelId: string,
  options?: RoomQueryOptions,
): RoomRosterMember[] {
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return [];

  const limit = clampLimit(options?.limit, DEFAULT_ROOM_ROSTER_LIMIT, MAX_ROOM_ROSTER_LIMIT);
  const offset = clampOffset(options?.offset);
  const normalizedChannel = options?.channel?.trim().toLowerCase() || undefined;

  const rows = db.prepare(`
    SELECT c.id AS contact_id,
           c.display_name,
           c.trust_level,
           c.relationship_type,
           a.channel,
           a.channel_id,
           a.privacy_level,
           a.first_seen,
           a.last_seen
    FROM contact_channel_activity a
    INNER JOIN contacts c ON c.id = a.contact_id
    WHERE a.channel_id = ?
      ${normalizedChannel ? 'AND a.channel = ?' : ''}
    ORDER BY a.last_seen DESC, c.display_name ASC, c.id ASC
    LIMIT ? OFFSET ?
  `).all(
    ...(normalizedChannel
      ? [trimmedChannelId, normalizedChannel, limit, offset]
      : [trimmedChannelId, limit, offset]),
  ) as RoomRosterRow[];

  return rows.map(row => ({
    contactId: row.contact_id,
    displayName: row.display_name,
    trustLevel: row.trust_level as TrustLevel,
    relationshipType: row.relationship_type as RelationshipType,
    channel: row.channel,
    channelId: row.channel_id,
    privacyLevel: row.privacy_level
      ? normalizePrivacyLevel(row.privacy_level as ChannelPrivacyLevel, row.channel)
      : null,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));
}

export function countRoomRoster(
  db: Database.Database,
  channelId: string,
  options?: Pick<RoomQueryOptions, 'channel'>,
): number {
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return 0;
  const normalizedChannel = options?.channel?.trim().toLowerCase() || undefined;

  const row = db.prepare(`
    SELECT COUNT(*) AS total
    FROM contact_channel_activity
    WHERE channel_id = ?
      ${normalizedChannel ? 'AND channel = ?' : ''}
  `).get(
    ...(normalizedChannel ? [trimmedChannelId, normalizedChannel] : [trimmedChannelId]),
  ) as { total: number } | undefined;
  return Number(row?.total ?? 0);
}
