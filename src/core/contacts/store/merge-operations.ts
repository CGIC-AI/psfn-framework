import type Database from 'better-sqlite3';
import type { RelationshipType } from '../types.js';
import type { ContactRow } from './domain-types.js';
import {
  earliestTimestamp,
  latestTimestamp,
  pickMostTrustedLevel,
  pickPreferredDisplayName,
} from './identity-utils.js';
import { mergeChannelActivityRows, mergeChannelIdentityRows } from './merge.js';
import { maybeHasContactLinkedTable } from './schema.js';
import { mergeSocialGraphForContacts } from './social-graph.js';

export interface MergeContext {
  db: Database.Database;
}

export function mergeContacts(
  context: MergeContext,
  sourceContactId: string,
  targetContactId: string,
): boolean {
  if (sourceContactId === targetContactId) return true;

  const mergeTx = context.db.transaction((sourceId: string, targetId: string): boolean => {
    const sourceRow = context.db.prepare('SELECT * FROM contacts WHERE id = ?')
      .get(sourceId) as ContactRow | undefined;
    const targetRow = context.db.prepare('SELECT * FROM contacts WHERE id = ?')
      .get(targetId) as ContactRow | undefined;
    if (!sourceRow || !targetRow) return false;

    mergeChannelIdentityRows(context.db, sourceId, targetId);
    mergeChannelActivityRows(context.db, sourceId, targetId);
    mergeSocialGraphForContacts(context.db, sourceId, targetId);

    if (maybeHasContactLinkedTable(context.db, 'l2_memories', 'contact_id')) {
      context.db.prepare('UPDATE l2_memories SET contact_id = ? WHERE contact_id = ?')
        .run(targetId, sourceId);
    }

    if (maybeHasContactLinkedTable(context.db, 'contact_profiles', 'contact_id')) {
      const targetProfileExists = context.db.prepare(`
        SELECT 1 AS exists_flag
        FROM contact_profiles
        WHERE contact_id = ?
        LIMIT 1
      `).get(targetId) as { exists_flag: number } | undefined;

      if (targetProfileExists) {
        context.db.prepare('DELETE FROM contact_profiles WHERE contact_id = ?').run(sourceId);
      } else {
        context.db.prepare('UPDATE contact_profiles SET contact_id = ? WHERE contact_id = ?')
          .run(targetId, sourceId);
      }
    }

    const mergedTrustLevel = pickMostTrustedLevel(sourceRow.trust_level, targetRow.trust_level);
    const mergedRelationshipType = mergedTrustLevel === 'primary'
      ? 'partner'
      : (targetRow.relationship_type as RelationshipType);
    const mergedDisplayName = pickPreferredDisplayName(
      targetRow.display_name,
      sourceRow.display_name,
      targetRow.discord_user_id,
      sourceRow.discord_user_id,
    );
    const mergedNickname = targetRow.nickname ?? sourceRow.nickname;
    const mergedDiscordUserId = targetRow.discord_user_id ?? sourceRow.discord_user_id;
    const mergedBaseline = (targetRow.emotional_baseline && targetRow.emotional_baseline !== '{}')
      ? targetRow.emotional_baseline
      : sourceRow.emotional_baseline;
    const mergedFirstSeen = earliestTimestamp(sourceRow.first_seen, targetRow.first_seen);
    const mergedLastSeen = latestTimestamp(sourceRow.last_seen, targetRow.last_seen);
    const mergedNotes = targetRow.notes ?? sourceRow.notes;

    context.db.prepare('DELETE FROM contacts WHERE id = ?').run(sourceId);
    context.db.prepare(`
      UPDATE contacts
      SET discord_user_id = ?,
          display_name = ?,
          nickname = ?,
          trust_level = ?,
          relationship_type = ?,
          emotional_baseline = ?,
          first_seen = ?,
          last_seen = ?,
          notes = ?
      WHERE id = ?
    `).run(
      mergedDiscordUserId,
      mergedDisplayName,
      mergedNickname,
      mergedTrustLevel,
      mergedRelationshipType,
      mergedBaseline || '{}',
      mergedFirstSeen,
      mergedLastSeen,
      mergedNotes,
      targetId,
    );

    return true;
  });

  return mergeTx(sourceContactId, targetContactId);
}
