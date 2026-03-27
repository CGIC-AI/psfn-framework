import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
import type {
  Contact,
  ContactChannelIdentity,
  ContactChannelLink,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
} from '../types.js';
import {
  LEGACY_DISCORD_CHANNEL,
  identityKey,
  normalizeChannelLinkInput,
  normalizeIdentity,
} from './identity-utils.js';

export interface ContactLookupFns {
  getById: (id: string) => Contact | undefined;
  getByDiscordUserId: (discordUserId: string) => Contact | undefined;
  getByChannelIdentity: (channel: string, userId: string) => Contact | undefined;
}

export function collectUpsertIdentities(partial: Partial<Contact>): ContactChannelLink[] {
  const identities: ContactChannelLink[] = [];
  const seen = new Set<string>();

  const addIdentity = (identity: ContactChannelLink): void => {
    const key = identityKey(identity);
    if (seen.has(key)) return;
    identities.push(identity);
    seen.add(key);
  };

  if (Array.isArray(partial.channels)) {
    for (const channel of partial.channels) {
      if (!channel.channel || !channel.userId) continue;
      const normalized = normalizeIdentity(channel.channel, channel.userId);
      addIdentity(normalizeChannelLinkInput(normalized, { privacyLevel: channel.privacyLevel }));
    }
  }

  if (Array.isArray(partial.channelIdentities)) {
    for (const identity of partial.channelIdentities) {
      if (!identity.channel || !identity.userId) continue;
      const normalized = normalizeIdentity(identity.channel, identity.userId);
      addIdentity(normalizeChannelLinkInput(normalized));
    }
  }

  if (partial.discordUserId) {
    const normalized = normalizeIdentity(LEGACY_DISCORD_CHANNEL, partial.discordUserId);
    addIdentity(normalizeChannelLinkInput(normalized));
  }

  return identities;
}

export function findUpsertTarget(
  partial: Partial<Contact>,
  identities: ContactChannelIdentity[],
  lookups: ContactLookupFns,
): Contact | undefined {
  if (partial.id) {
    const byId = lookups.getById(partial.id);
    if (byId) return byId;
  }

  if (partial.discordUserId) {
    const byDiscordId = lookups.getByDiscordUserId(partial.discordUserId);
    if (byDiscordId) return byDiscordId;
  }

  for (const identity of identities) {
    const byIdentity = lookups.getByChannelIdentity(identity.channel, identity.userId);
    if (byIdentity) return byIdentity;
  }

  return undefined;
}

export async function upsertIdentityLink(
  adapter: DatabaseAdapter,
  contactId: string,
  identity: ContactChannelIdentity,
  firstSeen: string,
  lastSeen: string,
  options?: ContactIdentityLinkOptions,
): Promise<ContactIdentityLinkResult> {
  const normalized = normalizeChannelLinkInput(identity, options);
  const existing = await adapter.queryOne<{ contact_id: string }>(`
    SELECT contact_id
    FROM contact_channel_ids
    WHERE channel = ? AND channel_user_id = ?
  `, [normalized.channel, normalized.userId]);

  if (existing && existing.contact_id !== contactId) {
    return 'identity_conflict';
  }

  if (existing) {
    await adapter.run(`
      UPDATE contact_channel_ids
      SET last_seen = ?, privacy_level = COALESCE(?, privacy_level)
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
    `, [
      lastSeen,
      normalized.privacyLevel,
      contactId,
      normalized.channel,
      normalized.userId,
    ]);
    return 'already_linked';
  }

  await adapter.run(`
    INSERT INTO contact_channel_ids (
      contact_id,
      channel,
      channel_user_id,
      privacy_level,
      first_seen,
      last_seen
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `, [
    contactId,
    normalized.channel,
    normalized.userId,
    normalized.privacyLevel,
    firstSeen,
    lastSeen,
  ]);

  return 'linked';
}

export async function ensureLegacyDiscordUserId(
  adapter: DatabaseAdapter,
  contactId: string,
  discordUserId: string,
): Promise<void> {
  await adapter.run(`
    UPDATE contacts
    SET discord_user_id = COALESCE(discord_user_id, ?)
    WHERE id = ?
  `, [discordUserId, contactId]);
}

export interface ApplyIdentityLinksOptions {
  onIdentityConflict?: (identity: ContactChannelIdentity) => void;
}

export async function applyIdentityLinks(
  adapter: DatabaseAdapter,
  contactId: string,
  identities: ContactChannelLink[],
  firstSeen: string,
  lastSeen: string,
  options: ApplyIdentityLinksOptions = {},
): Promise<void> {
  for (const identity of identities) {
    const result = await upsertIdentityLink(
      adapter,
      contactId,
      identity,
      firstSeen,
      lastSeen,
      { privacyLevel: identity.privacyLevel },
    );
    if (result === 'identity_conflict') {
      options.onIdentityConflict?.(identity);
      continue;
    }

    if (identity.channel === LEGACY_DISCORD_CHANNEL) {
      await ensureLegacyDiscordUserId(adapter, contactId, identity.userId);
    }
  }
}