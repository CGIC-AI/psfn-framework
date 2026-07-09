import { v7 as uuidv7 } from 'uuid';
import type Database from 'better-sqlite3';
import type {
  Contact,
  ContactChannel,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  RelationshipType,
} from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
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

function hasOwnTimezone(partial: Partial<Contact>): boolean {
  return Object.prototype.hasOwnProperty.call(partial, 'timezone');
}

function normalizeTimezoneValue(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function touchContactLastSeen(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE contacts SET last_seen = ? WHERE id = ?').run(now, id);
  db.prepare('UPDATE contact_channel_ids SET last_seen = ? WHERE contact_id = ?').run(now, id);
  db.prepare('UPDATE contact_channel_activity SET last_seen = ? WHERE contact_id = ?').run(now, id);
}

export interface UpsertResolveContext {
  db: Database.Database;
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

export function promoteContactToPrimary(db: Database.Database, contactId: string): void {
  db.prepare(`
    UPDATE contacts
    SET trust_level = 'primary',
        relationship_type = 'partner'
    WHERE id = ?
  `).run(contactId);
}

export function reconcilePrimaryContactDuplicates(
  context: UpsertResolveContext,
  canonicalContactId: string,
): string {
  const duplicates = context.db.prepare(`
    SELECT id
    FROM contacts
    WHERE id <> ? AND trust_level = 'primary'
    ORDER BY first_seen ASC
  `).all(canonicalContactId) as Array<{ id: string }>;

  for (const duplicate of duplicates) {
    context.mergeContacts(duplicate.id, canonicalContactId);
  }

  return canonicalContactId;
}

export function upsertContact(
  context: UpsertResolveContext,
  partial: Partial<Contact> & { displayName: string },
): Contact {
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
    const timezone = hasOwnTimezone(partial)
      ? normalizeTimezoneValue(partial.timezone)
      : (existing.timezone ?? null);

    context.db.prepare(`
      UPDATE contacts SET
        discord_user_id = COALESCE(discord_user_id, ?),
        display_name = ?,
        nickname = ?,
        trust_level = ?,
        relationship_type = ?,
        emotional_baseline = ?,
        last_seen = ?,
        notes = ?,
        timezone = ?
      WHERE id = ?
    `).run(
      legacyDiscordUserId ?? null,
      partial.displayName,
      nickname,
      trustLevel,
      relationshipType,
      JSON.stringify(emotionalBaseline),
      now,
      partial.notes ?? existing.notes ?? null,
      timezone,
      existing.id,
    );

    applyIdentityLinks(
      context.db,
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
    id: partial.id ?? uuidv7(),
    discordUserId: legacyDiscordUserId,
    displayName: partial.displayName,
    nickname: normalizeNicknameValue(partial.nickname) ?? undefined,
    trustLevel: shouldForcePrimary ? 'primary' : (partial.trustLevel ?? 'regular'),
    relationshipType: shouldForcePrimary ? 'partner' : (partial.relationshipType ?? 'stranger'),
    emotionalBaseline: partial.emotionalBaseline ?? {},
    firstSeen: partial.firstSeen ?? now,
    lastSeen: partial.lastSeen ?? now,
    notes: partial.notes,
    timezone: normalizeTimezoneValue(partial.timezone) ?? undefined,
  };

  context.db.prepare(`
    INSERT INTO contacts (id, discord_user_id, display_name, trust_level, relationship_type,
      nickname, emotional_baseline, first_seen, last_seen, notes, timezone)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
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
    contact.timezone ?? null,
  );

  applyIdentityLinks(context.db, contact.id, identities, contact.firstSeen, contact.lastSeen);

  return context.getById(contact.id)!;
}

export function linkChannelIdentity(
  context: UpsertResolveContext,
  contactId: string,
  channel: ContactChannel,
  channelUserId: string,
  options?: ContactIdentityLinkOptions,
): ContactIdentityLinkResult {
  const contact = context.getById(contactId);
  if (!contact) return 'contact_not_found';

  const now = new Date().toISOString();
  const identity = normalizeIdentity(channel, channelUserId);
  const result = upsertIdentityLink(context.db, contactId, identity, contact.firstSeen, now, options);

  if (result !== 'identity_conflict' && identity.channel === LEGACY_DISCORD_CHANNEL) {
    ensureLegacyDiscordUserId(context.db, contactId, identity.userId);
  }

  if (result !== 'identity_conflict' && isPrimaryIdentity(identity, context.primaryUserId)) {
    promoteContactToPrimary(context.db, contactId);
    reconcilePrimaryContactDuplicates(context, contactId);
  }

  return result;
}

export function resolveChannelIdentity(
  context: UpsertResolveContext,
  channel: ContactChannel,
  channelUserId: string,
  displayName?: string,
): Contact {
  const identity = normalizeIdentity(channel, channelUserId);
  const existing = context.getByChannelIdentity(identity.channel, identity.userId);

  if (existing) {
    const now = new Date().toISOString();
    touchContactLastSeen(context.db, existing.id);
    upsertIdentityLink(context.db, existing.id, identity, existing.firstSeen, now);
    if (identity.channel === LEGACY_DISCORD_CHANNEL) {
      ensureLegacyDiscordUserId(context.db, existing.id, identity.userId);
    }

    let canonicalContactId = existing.id;
    if (isPrimaryIdentity(identity, context.primaryUserId)) {
      promoteContactToPrimary(context.db, canonicalContactId);
      canonicalContactId = reconcilePrimaryContactDuplicates(context, canonicalContactId);
    }

    const candidateDisplayName = displayName?.trim();
    if (
      candidateDisplayName
      && candidateDisplayName !== existing.displayName
      && looksLikeOpaqueIdentifier(existing.displayName)
    ) {
      context.db.prepare('UPDATE contacts SET display_name = ? WHERE id = ?')
        .run(candidateDisplayName, canonicalContactId);
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
    // Sprint-10 privacy regression H7: a never-seen, non-primary speaker is minted
    // at the PUBLIC trust floor, never 'regular'. Under the runtime trust ceiling
    // 'regular' clears the 'personal'-sensitivity disclosure gate, so auto-minting a
    // stranger as 'regular' let an unknown/unauthenticated author read personal-tier
    // content on first contact. Minting at 'public' fails closed: a stranger only
    // clears the 'public' ceiling. Promotion to 'regular'+ now requires an explicit
    // operator/tool action. Primary auto-detect is preserved (isPrimary → 'primary').
    trustLevel: isPrimary ? 'primary' : 'public',
    relationshipType: isPrimary ? 'partner' : 'stranger',
  });
}

export function resolveUserId(context: UpsertResolveContext, discordUserId: string): Contact {
  return resolveChannelIdentity(context, LEGACY_DISCORD_CHANNEL, discordUserId, discordUserId);
}
