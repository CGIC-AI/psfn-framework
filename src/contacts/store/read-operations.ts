import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
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

export async function getContactById(adapter: DatabaseAdapter, id: string): Promise<Contact | undefined> {
  const row = await adapter.queryOne<ContactRow>('SELECT * FROM contacts WHERE id = ?', [id]);
  return row ? await hydrateContact(adapter, row) : undefined;
}

export async function getContactByChannelIdentity(
  adapter: DatabaseAdapter,
  channel: ContactChannel,
  channelUserId: string,
): Promise<Contact | undefined> {
  const identity = normalizeIdentity(channel, channelUserId);

  const row = await adapter.queryOne<ContactRow>(`
    SELECT c.*
    FROM contacts c
    INNER JOIN contact_channel_ids i ON i.contact_id = c.id
    WHERE i.channel = ? AND i.channel_user_id = ?
    LIMIT 1
  `, [identity.channel, identity.userId]);

  if (row) return await hydrateContact(adapter, row);

  if (identity.channel === LEGACY_DISCORD_CHANNEL) {
    const legacyRow = await adapter.queryOne<ContactRow>('SELECT * FROM contacts WHERE discord_user_id = ?', [identity.userId]);
    if (legacyRow) {
      await upsertIdentityLink(
        adapter,
        legacyRow.id,
        identity,
        legacyRow.first_seen,
        legacyRow.last_seen,
      );
      return await hydrateContact(adapter, legacyRow);
    }
  }

  return undefined;
}

export async function getContactByDiscordUserId(
  adapter: DatabaseAdapter,
  discordUserId: string,
): Promise<Contact | undefined> {
  const trimmedDiscordId = discordUserId.trim();
  if (!trimmedDiscordId) return undefined;

  const row = await adapter.queryOne<ContactRow>('SELECT * FROM contacts WHERE discord_user_id = ?', [trimmedDiscordId]);

  if (row) return await hydrateContact(adapter, row);
  return getContactByChannelIdentity(adapter, LEGACY_DISCORD_CHANNEL, trimmedDiscordId);
}

export async function getContactsByTrustLevel(
  adapter: DatabaseAdapter,
  trustLevel: TrustLevel,
): Promise<Contact[]> {
  const rows = await adapter.query<ContactRow>('SELECT * FROM contacts WHERE trust_level = ?', [trustLevel]);
  const contacts: Contact[] = [];
  for (const row of rows) {
    const contact = await hydrateContact(adapter, row);
    contacts.push(contact);
  }
  return contacts;
}

export async function listAllContacts(adapter: DatabaseAdapter): Promise<Contact[]> {
  const rows = await adapter.query<ContactRow>('SELECT * FROM contacts ORDER BY last_seen DESC');
  const contacts: Contact[] = [];
  for (const row of rows) {
    const contact = await hydrateContact(adapter, row);
    contacts.push(contact);
  }
  return contacts;
}

export async function listIdentityLinkVerifications(
  adapter: DatabaseAdapter,
  limit = 25,
): Promise<ContactIdentityLinkVerification[]> {
  const normalizedLimit = Number.isFinite(limit)
    ? Math.max(1, Math.min(Math.floor(limit), 200))
    : 25;

  const rows = await adapter.query<ContactIdentityVerificationRow>(`
    SELECT *
    FROM contact_identity_link_verifications
    ORDER BY created_at DESC
    LIMIT ?
  `, [normalizedLimit]);

  return rows.map(row => toIdentityLinkVerification(row));
}

export async function getCanonicalContactKey(
  adapter: DatabaseAdapter,
  channel: ContactChannel,
  channelUserId: string,
): Promise<string | undefined> {
  const contact = await getContactByChannelIdentity(adapter, channel, channelUserId);
  return contact?.id;
}

export async function getConversationChannelPrivacy(
  adapter: DatabaseAdapter,
  contactId: string,
  channel: ContactChannel,
  channelId: string,
): Promise<ChannelPrivacyLevel | undefined> {
  const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return undefined;

  const row = await adapter.queryOne<{ privacy_level?: string | null }>(`
    SELECT privacy_level
    FROM contact_channel_activity
    WHERE contact_id = ? AND channel = ? AND channel_id = ?
    LIMIT 1
  `, [contactId, normalizedChannel, trimmedChannelId]);

  if (!row?.privacy_level) return undefined;
  return normalizePrivacyLevel(row.privacy_level as ChannelPrivacyLevel, normalizedChannel);
}