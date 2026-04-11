import type Database from 'better-sqlite3';
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

export function upsertIdentityLink(
  db: Database.Database,
  contactId: string,
  identity: ContactChannelIdentity,
  firstSeen: string,
  lastSeen: string,
  options?: ContactIdentityLinkOptions,
): ContactIdentityLinkResult {
  const normalized = normalizeChannelLinkInput(identity, options);
  const existing = db.prepare(`
    SELECT contact_id
    FROM contact_channel_ids
    WHERE channel = ? AND channel_user_id = ?
  `).get(normalized.channel, normalized.userId) as { contact_id: string } | undefined;

  if (existing && existing.contact_id !== contactId) {
    return 'identity_conflict';
  }

  if (existing) {
    db.prepare(`
      UPDATE contact_channel_ids
      SET last_seen = ?, privacy_level = COALESCE(?, privacy_level)
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
    `).run(
      lastSeen,
      normalized.privacyLevel,
      contactId,
      normalized.channel,
      normalized.userId,
    );
    return 'already_linked';
  }

  db.prepare(`
    INSERT INTO contact_channel_ids (
      contact_id,
      channel,
      channel_user_id,
      privacy_level,
      first_seen,
      last_seen
    )
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    contactId,
    normalized.channel,
    normalized.userId,
    normalized.privacyLevel,
    firstSeen,
    lastSeen,
  );

  return 'linked';
}

export function ensureLegacyDiscordUserId(
  db: Database.Database,
  contactId: string,
  discordUserId: string,
): void {
  db.prepare(`
    UPDATE contacts
    SET discord_user_id = COALESCE(discord_user_id, ?)
    WHERE id = ?
  `).run(discordUserId, contactId);
}

export interface ApplyIdentityLinksOptions {
  onIdentityConflict?: (identity: ContactChannelIdentity) => void;
}

export function applyIdentityLinks(
  db: Database.Database,
  contactId: string,
  identities: ContactChannelLink[],
  firstSeen: string,
  lastSeen: string,
  options: ApplyIdentityLinksOptions = {},
): void {
  for (const identity of identities) {
    const result = upsertIdentityLink(
      db,
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
      ensureLegacyDiscordUserId(db, contactId, identity.userId);
    }
  }
}
