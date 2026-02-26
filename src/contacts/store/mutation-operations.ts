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
