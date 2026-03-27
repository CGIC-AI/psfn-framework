import { v4 as uuidv4 } from 'uuid';
import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
import type {
  Contact,
  ContactChannel,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  RelationshipType,
} from '../types.js';
import type { TrustLevel } from '../../trust/types.js';
import {
  LEGACY_DISCORD_CHANNEL,
  defaultPrivacyForChannel,
  getLegacyDiscordUserId,
  isPrimaryContact,
  isPrimaryIdentity,
  looksLikeOpaqueIdentifier,
  normalizeIdentity,
  normalizeNicknameValue,
} from './identity-utils.js';
import {
  applyIdentityLinks,
  collectUpsertIdentities,
  ensureLegacyDiscordUserId,
  findUpsertTarget,
  upsertIdentityLink,
} from './upsert.js';

async function touchContactLastSeen(adapter: DatabaseAdapter, id: string): Promise<void> {
  const now = new Date().toISOString();
  await adapter.run('UPDATE contacts SET last_seen = ? WHERE id = ?', [now, id]);
  await adapter.run('UPDATE contact_channel_ids SET last_seen = ? WHERE contact_id = ?', [now, id]);
  await adapter.run('UPDATE contact_channel_activity SET last_seen = ? WHERE contact_id = ?', [now, id]);
}

export interface UpsertResolveContext {
  adapter: DatabaseAdapter;
  primaryUserId?: string;
  getById: (id: string) => Contact | undefined;
  getByDiscordUserId: (discordUserId: string) => Contact | undefined;
  getByChannelIdentity: (channel: ContactChannel, channelUserId: string) => Contact | undefined;
  mergeContacts: (sourceContactId: string, targetContactId: string) => boolean;
  onIdentityConflict: (details: {
    contactId: string;
    channel: string;
    userId: string;
  }) => void;
}

export async function promoteContactToPrimary(adapter: DatabaseAdapter, contactId: string): Promise<void> {
  await adapter.run(`
    UPDATE contacts
    SET trust_level = 'primary',
        relationship_type = 'partner'
    WHERE id = ?
  `, [contactId]);
}

export async function reconcilePrimaryContactDuplicates(
  context: UpsertResolveContext,
  canonicalContactId: string,
): Promise<string> {
  const duplicates = await context.adapter.query<{ id: string }>(`
    SELECT id
    FROM contacts
    WHERE id <> ? AND trust_level = 'primary'
    ORDER BY first_seen ASC
  `, [canonicalContactId]);

  for (const duplicate of duplicates) {
    context.mergeContacts(duplicate.id, canonicalContactId);
  }

  return canonicalContactId;
}

export async function upsertContact(
  context: UpsertResolveContext,
  partial: Partial<Contact> & { displayName: string },
): Promise<Contact> {
  const now = new Date().toISOString();
  const identities = collectUpsertIdentities(partial);
  const existing = findUpsertTarget(partial, identities, {
    getById: id => context.getById(id),
    getByDiscordUserId: discordUserId => context.getByDiscordUserId(discordUserId),
    getByChannelIdentity: (channel, userId) => context.getByChannelIdentity(channel, userId),
  });

  if (existing) {
    const shouldForcePrimary = isPrimaryContact(existing, identities, context.primaryUserId);
    const trustLevel = shouldForcePrimary
      ? 'primary' as TrustLevel
      : (partial.trustLevel ?? existing.trustLevel);
    const relationshipType = shouldForcePrimary
      ? 'partner' as RelationshipType
      : (partial.relationshipType ?? existing.relationshipType);
    const emotionalBaseline = partial.emotionalBaseline ?? existing.emotionalBaseline ?? {};
    const legacyDiscordUserId = getLegacyDiscordUserId(
      existing.discordUserId,
      partial.discordUserId,
      identities,
    );
    const requestedNickname = normalizeNicknameValue(partial.nickname);
    const nickname = requestedNickname === undefined
      ? (existing.nickname ?? null)
      : requestedNickname;

    await context.adapter.run(`
      UPDATE contacts SET
        discord_user_id = COALESCE(discord_user_id, ?),
        display_name = ?,
        nickname = ?,
        trust_level = ?,
        relationship_type = ?,
        emotional_baseline = ?,
        last_seen = ?,
        notes = ?
      WHERE id = ?
    `, [
      legacyDiscordUserId ?? null,
      partial.displayName,
      nickname,
      trustLevel,
      relationshipType,
      JSON.stringify(emotionalBaseline),
      now,
      partial.notes ?? existing.notes ?? null,
      existing.id,
    ]);

    await applyIdentityLinks(
      context.adapter,
      existing.id,
      identities,
      existing.firstSeen,
      now,
      {
        onIdentityConflict: (identity) => {
          context.onIdentityConflict({
            contactId: existing.id,
            channel: identity.channel,
            userId: identity.userId,
          });
        },
      },
    );

    return context.getById(existing.id)!;
  }

  const legacyDiscordUserId = getLegacyDiscordUserId(undefined, partial.discordUserId, identities);
  const shouldForcePrimary = identities.some(identity => isPrimaryIdentity(identity, context.primaryUserId))
    || (legacyDiscordUserId ? isPrimaryIdentity({ channel: LEGACY_DISCORD_CHANNEL, userId: legacyDiscordUserId }, context.primaryUserId) : false);

  const contact: Contact = {
    id: partial.id ?? uuidv4(),
    discordUserId: legacyDiscordUserId,
    displayName: partial.displayName,
    nickname: normalizeNicknameValue(partial.nickname) ?? undefined,
    trustLevel: shouldForcePrimary ? 'primary' : (partial.trustLevel ?? 'regular'),
    relationshipType: shouldForcePrimary ? 'partner' : (partial.relationshipType ?? 'stranger'),
    emotionalBaseline: partial.emotionalBaseline ?? {},
    firstSeen: partial.firstSeen ?? now,
    lastSeen: partial.lastSeen ?? now,
    notes: partial.notes,
  };

  await context.adapter.run(`
    INSERT INTO contacts (id, discord_user_id, display_name, trust_level, relationship_type,
      nickname, emotional_baseline, first_seen, last_seen, notes)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, [
    contact.id,
    contact.discordUserId ?? null,
    contact.displayName,
    contact.trustLevel,
    contact.relationshipType,
    contact.nickname ?? null,
    JSON.stringify(contact.emotionalBaseline ?? {}),
    contact.firstSeen,
    contact.lastSeen,
    contact.notes ?? null,
  ]);

  await applyIdentityLinks(context.adapter, contact.id, identities, contact.firstSeen, contact.lastSeen);

  return context.getById(contact.id)!;
}

export async function linkChannelIdentity(
  context: UpsertResolveContext,
  contactId: string,
  channel: ContactChannel,
  channelUserId: string,
  options?: ContactIdentityLinkOptions,
): Promise<ContactIdentityLinkResult> {
  const contact = context.getById(contactId);
  if (!contact) return 'contact_not_found';

  const now = new Date().toISOString();
  const identity = normalizeIdentity(channel, channelUserId);
  const result = await upsertIdentityLink(context.adapter, contactId, identity, contact.firstSeen, now, options);

  if (result !== 'identity_conflict' && identity.channel === LEGACY_DISCORD_CHANNEL) {
    await ensureLegacyDiscordUserId(context.adapter, contactId, identity.userId);
  }

  if (result !== 'identity_conflict' && isPrimaryIdentity(identity, context.primaryUserId)) {
    await promoteContactToPrimary(context.adapter, contactId);
    await reconcilePrimaryContactDuplicates(context, contactId);
  }

  return result;
}

export async function resolveChannelIdentity(
  context: UpsertResolveContext,
  channel: ContactChannel,
  channelUserId: string,
  displayName?: string,
): Promise<Contact> {
  const identity = normalizeIdentity(channel, channelUserId);
  const existing = context.getByChannelIdentity(identity.channel, identity.userId);

  if (existing) {
    const now = new Date().toISOString();
    await touchContactLastSeen(context.adapter, existing.id);
    await upsertIdentityLink(context.adapter, existing.id, identity, existing.firstSeen, now);
    if (identity.channel === LEGACY_DISCORD_CHANNEL) {
      await ensureLegacyDiscordUserId(context.adapter, existing.id, identity.userId);
    }

    let canonicalContactId = existing.id;
    if (isPrimaryIdentity(identity, context.primaryUserId)) {
      await promoteContactToPrimary(context.adapter, canonicalContactId);
      canonicalContactId = await reconcilePrimaryContactDuplicates(context, canonicalContactId);
    }

    const candidateDisplayName = displayName?.trim();
    if (
      candidateDisplayName
      && candidateDisplayName !== existing.displayName
      && looksLikeOpaqueIdentifier(existing.displayName)
    ) {
      await context.adapter.run('UPDATE contacts SET display_name = ? WHERE id = ?', [candidateDisplayName, canonicalContactId]);
    }

    return context.getById(canonicalContactId)!;
  }

  const isPrimary = isPrimaryIdentity(identity, context.primaryUserId);
  return upsertContact(context, {
    displayName: displayName?.trim() || identity.userId,
    channels: [{
      channel: identity.channel,
      userId: identity.userId,
      privacyLevel: defaultPrivacyForChannel(identity.channel),
      firstSeen: '',
      lastSeen: '',
    }],
    channelIdentities: [identity],
    discordUserId: identity.channel === LEGACY_DISCORD_CHANNEL ? identity.userId : undefined,
    trustLevel: isPrimary ? 'primary' : 'regular',
    relationshipType: isPrimary ? 'partner' : 'stranger',
  });
}

export async function resolveUserId(context: UpsertResolveContext, discordUserId: string): Promise<Contact> {
  return resolveChannelIdentity(context, LEGACY_DISCORD_CHANNEL, discordUserId, discordUserId);
}