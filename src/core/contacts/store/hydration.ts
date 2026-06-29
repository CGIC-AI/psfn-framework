import type Database from 'better-sqlite3';
import type {
  Contact,
  ContactChannelLink,
  ContactConversationChannel,
  RelationshipType,
  ChannelPrivacyLevel,
} from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import {
  LEGACY_DISCORD_CHANNEL,
  defaultPrivacyForChannel,
  normalizePrivacyLevel,
} from './identity-utils.js';
import type {
  ContactChannelActivityRow,
  ContactIdentityRow,
  ContactRow,
} from './domain-types.js';

export function rowToContact(row: ContactRow): Contact {
  let emotionalBaseline: Record<string, number>;
  try {
    emotionalBaseline = row.emotional_baseline
      ? JSON.parse(row.emotional_baseline) as Record<string, number>
      : {};
  } catch {
    emotionalBaseline = {};
  }

  return {
    id: row.id,
    discordUserId: row.discord_user_id ?? undefined,
    displayName: row.display_name,
    nickname: row.nickname ?? undefined,
    timezone: row.timezone ?? undefined,
    trustLevel: row.trust_level as TrustLevel,
    relationshipType: row.relationship_type as RelationshipType,
    ...(row.is_machine_intelligence ? { isMachineIntelligence: true } : {}),
    emotionalBaseline,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    notes: row.notes ?? undefined,
  };
}

export function getChannelLinks(
  db: Database.Database,
  contactId: string,
  legacyDiscordUserId?: string,
): ContactChannelLink[] {
  const rows = db.prepare(`
    SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
    FROM contact_channel_ids
    WHERE contact_id = ?
    ORDER BY channel ASC, channel_user_id ASC
  `).all(contactId) as ContactIdentityRow[];

  const identities = rows.map((row): ContactChannelLink => ({
    channel: row.channel,
    userId: row.channel_user_id,
    privacyLevel: normalizePrivacyLevel(
      row.privacy_level as ChannelPrivacyLevel | undefined,
      row.channel,
    ),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));

  if (legacyDiscordUserId) {
    const hasLegacyIdentity = identities.some(identity => (
      identity.channel === LEGACY_DISCORD_CHANNEL && identity.userId === legacyDiscordUserId
    ));
    if (!hasLegacyIdentity) {
      identities.unshift({
        channel: LEGACY_DISCORD_CHANNEL,
        userId: legacyDiscordUserId,
        privacyLevel: defaultPrivacyForChannel(LEGACY_DISCORD_CHANNEL),
        firstSeen: '',
        lastSeen: '',
      });
    }
  }

  return identities;
}

export function getConversationChannels(
  db: Database.Database,
  contactId: string,
): ContactConversationChannel[] {
  const rows = db.prepare(`
    SELECT contact_id, channel, channel_id, privacy_level, first_seen, last_seen
    FROM contact_channel_activity
    WHERE contact_id = ?
    ORDER BY last_seen DESC, channel ASC, channel_id ASC
  `).all(contactId) as ContactChannelActivityRow[];

  return rows.map((row): ContactConversationChannel => ({
    channel: row.channel,
    channelId: row.channel_id,
    ...(row.privacy_level
      ? {
        privacyLevel: normalizePrivacyLevel(
          row.privacy_level as ChannelPrivacyLevel,
          row.channel,
        ),
      }
      : {}),
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
  }));
}

export function hydrateContact(db: Database.Database, row: ContactRow): Contact {
  const contact = rowToContact(row);
  const identities = getChannelLinks(db, contact.id, contact.discordUserId);
  const conversationChannels = getConversationChannels(db, contact.id);

  if (identities.length > 0) {
    contact.channelIdentities = identities.map(identity => ({
      channel: identity.channel,
      userId: identity.userId,
    }));
    contact.channels = identities;
  }

  if (conversationChannels.length > 0) {
    contact.conversationChannels = conversationChannels;
  }

  return contact;
}
