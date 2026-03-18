import type Database from 'better-sqlite3';
import type {
  Contact,
  ContactChannel,
  ChannelPrivacyLevel,
  ContactIdentityLinkVerification,
} from '../types.js';
import type { TrustLevel } from '../../trust/types.js';
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
