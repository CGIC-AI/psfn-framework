import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
import type {
  ContactChannel,
  ChannelPrivacyLevel,
  RelationshipType,
} from '../types.js';
import type { TrustLevel } from '../../trust/types.js';
import {
  normalizeIdentity,
  normalizePrivacyLevel,
  normalizeNicknameValue,
} from './identity-utils.js';
import { maybeHasContactLinkedTable } from './schema.js';

export async function setContactTrustLevel(
  adapter: DatabaseAdapter,
  id: string,
  trustLevel: TrustLevel,
): Promise<void> {
  await adapter.run('UPDATE contacts SET trust_level = ? WHERE id = ?', [trustLevel, id]);
}

export async function updateContactLastSeen(adapter: DatabaseAdapter, id: string): Promise<void> {
  const now = new Date().toISOString();
  await adapter.run('UPDATE contacts SET last_seen = ? WHERE id = ?', [now, id]);
  await adapter.run('UPDATE contact_channel_ids SET last_seen = ? WHERE contact_id = ?', [now, id]);
  await adapter.run('UPDATE contact_channel_activity SET last_seen = ? WHERE contact_id = ?', [now, id]);
}

export async function updateContactIdentityProfile(
  adapter: DatabaseAdapter,
  contactId: string,
  fallbackDisplayName: string,
  fallbackNickname: string | undefined,
  displayName: string,
  nickname?: string,
): Promise<boolean> {
  const requestedNickname = normalizeNicknameValue(nickname);
  const normalizedNickname = requestedNickname === undefined
    ? (fallbackNickname ?? null)
    : requestedNickname;

  const result = await adapter.run(`
    UPDATE contacts
    SET display_name = ?, nickname = ?
    WHERE id = ?
  `, [displayName.trim() || fallbackDisplayName, normalizedNickname, contactId]);

  return result.changes > 0;
}

export async function recordContactChannelActivity(
  adapter: DatabaseAdapter,
  contactId: string,
  channel: ContactChannel,
  channelId: string,
  privacyLevel?: ChannelPrivacyLevel,
): Promise<void> {
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return;

  const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
  const now = new Date().toISOString();
  if (privacyLevel !== undefined) {
    const normalizedPrivacy = normalizePrivacyLevel(privacyLevel, normalizedChannel);
    await adapter.run(`
      INSERT INTO contact_channel_activity (
        contact_id,
        channel,
        channel_id,
        privacy_level,
        first_seen,
        last_seen
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(contact_id, channel, channel_id)
      DO UPDATE SET
        privacy_level = excluded.privacy_level,
        last_seen = excluded.last_seen
    `, [contactId, normalizedChannel, trimmedChannelId, normalizedPrivacy, now, now]);
    return;
  }

  await adapter.run(`
    INSERT INTO contact_channel_activity (
      contact_id,
      channel,
      channel_id,
      privacy_level,
      first_seen,
      last_seen
    )
    VALUES (?, ?, ?, NULL, ?, ?)
    ON CONFLICT(contact_id, channel, channel_id)
    DO UPDATE SET last_seen = excluded.last_seen
  `, [contactId, normalizedChannel, trimmedChannelId, now, now]);
}

export async function updateContactNotes(adapter: DatabaseAdapter, id: string, notes: string): Promise<void> {
  await adapter.run('UPDATE contacts SET notes = ? WHERE id = ?', [notes, id]);
}

export async function updateContactEmotionalBaseline(
  adapter: DatabaseAdapter,
  id: string,
  baseline: Record<string, number>,
): Promise<void> {
  await adapter.run(`
    UPDATE contacts
    SET emotional_baseline = ?, last_seen = ?
    WHERE id = ?
  `, [
    JSON.stringify(baseline),
    new Date().toISOString(),
    id,
  ]);
}

export async function updateContactRelationshipType(
  adapter: DatabaseAdapter,
  id: string,
  relationshipType: RelationshipType,
): Promise<void> {
  await adapter.run('UPDATE contacts SET relationship_type = ? WHERE id = ?', [relationshipType, id]);
}

export async function updateContactChannelPrivacy(
  adapter: DatabaseAdapter,
  contactId: string,
  channel: ContactChannel,
  channelUserId: string,
  privacyLevel: ChannelPrivacyLevel,
): Promise<boolean> {
  const identity = normalizeIdentity(channel, channelUserId);
  const result = await adapter.run(`
    UPDATE contact_channel_ids
    SET privacy_level = ?, last_seen = ?
    WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
  `, [
    privacyLevel,
    new Date().toISOString(),
    contactId,
    identity.channel,
    identity.userId,
  ]);
  return result.changes > 0;
}

export async function updateConversationChannelPrivacy(
  adapter: DatabaseAdapter,
  contactId: string,
  channel: ContactChannel,
  channelId: string,
  privacyLevel: ChannelPrivacyLevel,
): Promise<boolean> {
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return false;

  const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
  const normalizedPrivacy = normalizePrivacyLevel(privacyLevel, normalizedChannel);
  const now = new Date().toISOString();
  const result = await adapter.run(`
    INSERT INTO contact_channel_activity (
      contact_id,
      channel,
      channel_id,
      privacy_level,
      first_seen,
      last_seen
    )
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(contact_id, channel, channel_id)
    DO UPDATE SET
      privacy_level = excluded.privacy_level,
      last_seen = excluded.last_seen
  `, [
    contactId,
    normalizedChannel,
    trimmedChannelId,
    normalizedPrivacy,
    now,
    now,
  ]);
  return result.changes > 0;
}

export async function deleteContact(adapter: DatabaseAdapter, id: string): Promise<boolean> {
  return await adapter.transaction(async (tx) => {
    // Orphan L2 memories (keep facts, unlink contact)
    if (await maybeHasContactLinkedTable(tx, 'l2_memories', 'contact_id')) {
      await tx.run('UPDATE l2_memories SET contact_id = NULL WHERE contact_id = ?', [id]);
    }
    // Remove contact profiles
    if (await maybeHasContactLinkedTable(tx, 'contact_profiles', 'contact_id')) {
      await tx.run('DELETE FROM contact_profiles WHERE contact_id = ?', [id]);
    }
    // Remove channel identities and activity (child tables)
    await tx.run('DELETE FROM contact_channel_ids WHERE contact_id = ?', [id]);
    await tx.run('DELETE FROM contact_channel_activity WHERE contact_id = ?', [id]);
    // Remove the contact itself
    const result = await tx.run('DELETE FROM contacts WHERE id = ?', [id]);
    return result.changes > 0;
  });
}

export async function unlinkChannelIdentity(
  adapter: DatabaseAdapter,
  contactId: string,
  channel: string,
  channelUserId: string,
): Promise<boolean> {
  const identity = normalizeIdentity(channel, channelUserId);
  const result = await adapter.run(
    'DELETE FROM contact_channel_ids WHERE contact_id = ? AND channel = ? AND channel_user_id = ?',
    [contactId, identity.channel, identity.userId],
  );
  return result.changes > 0;
}

export async function deleteConversationChannel(
  adapter: DatabaseAdapter,
  contactId: string,
  channel: string,
  channelId: string,
): Promise<boolean> {
  const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return false;

  const result = await adapter.run(
    'DELETE FROM contact_channel_activity WHERE contact_id = ? AND channel = ? AND channel_id = ?',
    [contactId, normalizedChannel, trimmedChannelId],
  );
  return result.changes > 0;
}