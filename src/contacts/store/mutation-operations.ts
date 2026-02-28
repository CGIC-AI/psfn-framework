import type Database from 'better-sqlite3';
import type {
  ContactChannel,
  ChannelPrivacyLevel,
  RelationshipType,
} from '../types.js';
import type { TrustLevel } from '../../trust/types.js';
import {
  normalizeIdentity,
  normalizeNicknameValue,
} from './identity-utils.js';
import { maybeHasContactLinkedTable } from './schema.js';

export function setContactTrustLevel(
  db: Database.Database,
  id: string,
  trustLevel: TrustLevel,
): void {
  db.prepare('UPDATE contacts SET trust_level = ? WHERE id = ?').run(trustLevel, id);
}

export function updateContactLastSeen(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  db.prepare('UPDATE contacts SET last_seen = ? WHERE id = ?').run(now, id);
  db.prepare('UPDATE contact_channel_ids SET last_seen = ? WHERE contact_id = ?').run(now, id);
  db.prepare('UPDATE contact_channel_activity SET last_seen = ? WHERE contact_id = ?').run(now, id);
}

export function updateContactIdentityProfile(
  db: Database.Database,
  contactId: string,
  fallbackDisplayName: string,
  fallbackNickname: string | undefined,
  displayName: string,
  nickname?: string,
): boolean {
  const requestedNickname = normalizeNicknameValue(nickname);
  const normalizedNickname = requestedNickname === undefined
    ? (fallbackNickname ?? null)
    : requestedNickname;

  const result = db.prepare(`
    UPDATE contacts
    SET display_name = ?, nickname = ?
    WHERE id = ?
  `).run(displayName.trim() || fallbackDisplayName, normalizedNickname, contactId);

  return result.changes > 0;
}

export function recordContactChannelActivity(
  db: Database.Database,
  contactId: string,
  channel: ContactChannel,
  channelId: string,
): void {
  const trimmedChannelId = channelId.trim();
  if (!trimmedChannelId) return;

  const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO contact_channel_activity (
      contact_id,
      channel,
      channel_id,
      first_seen,
      last_seen
    )
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(contact_id, channel, channel_id)
    DO UPDATE SET last_seen = excluded.last_seen
  `).run(contactId, normalizedChannel, trimmedChannelId, now, now);
}

export function updateContactNotes(db: Database.Database, id: string, notes: string): void {
  db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').run(notes, id);
}

export function updateContactEmotionalBaseline(
  db: Database.Database,
  id: string,
  baseline: Record<string, number>,
): void {
  db.prepare(`
    UPDATE contacts
    SET emotional_baseline = ?, last_seen = ?
    WHERE id = ?
  `).run(
    JSON.stringify(baseline),
    new Date().toISOString(),
    id,
  );
}

export function updateContactRelationshipType(
  db: Database.Database,
  id: string,
  relationshipType: RelationshipType,
): void {
  db.prepare('UPDATE contacts SET relationship_type = ? WHERE id = ?').run(relationshipType, id);
}

export function updateContactChannelPrivacy(
  db: Database.Database,
  contactId: string,
  channel: ContactChannel,
  channelUserId: string,
  privacyLevel: ChannelPrivacyLevel,
): boolean {
  const identity = normalizeIdentity(channel, channelUserId);
  const result = db.prepare(`
    UPDATE contact_channel_ids
    SET privacy_level = ?, last_seen = ?
    WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
  `).run(
    privacyLevel,
    new Date().toISOString(),
    contactId,
    identity.channel,
    identity.userId,
  );
  return result.changes > 0;
}

export function deleteContact(db: Database.Database, id: string): boolean {
  const deleteTx = db.transaction((contactId: string): boolean => {
    // Orphan L2 memories (keep facts, unlink contact)
    if (maybeHasContactLinkedTable(db, 'l2_memories', 'contact_id')) {
      db.prepare('UPDATE l2_memories SET contact_id = NULL WHERE contact_id = ?').run(contactId);
    }
    // Remove contact profiles
    if (maybeHasContactLinkedTable(db, 'contact_profiles', 'contact_id')) {
      db.prepare('DELETE FROM contact_profiles WHERE contact_id = ?').run(contactId);
    }
    // Remove channel identities and activity (child tables)
    db.prepare('DELETE FROM contact_channel_ids WHERE contact_id = ?').run(contactId);
    db.prepare('DELETE FROM contact_channel_activity WHERE contact_id = ?').run(contactId);
    // Remove the contact itself
    const result = db.prepare('DELETE FROM contacts WHERE id = ?').run(contactId);
    return result.changes > 0;
  });
  return deleteTx(id);
}

export function unlinkChannelIdentity(
  db: Database.Database,
  contactId: string,
  channel: string,
  channelUserId: string,
): boolean {
  const identity = normalizeIdentity(channel, channelUserId);
  const result = db.prepare(
    'DELETE FROM contact_channel_ids WHERE contact_id = ? AND channel = ? AND channel_user_id = ?',
  ).run(contactId, identity.channel, identity.userId);
  return result.changes > 0;
}
