import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
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
  adapter: DatabaseAdapter;
}

export async function mergeContacts(
  context: MergeContext,
  sourceContactId: string,
  targetContactId: string,
): Promise<boolean> {
  if (sourceContactId === targetContactId) return true;

  return await context.adapter.transaction(async (tx) => {
    const sourceRow = await tx.queryOne<ContactRow>('SELECT * FROM contacts WHERE id = ?', [sourceContactId]);
    const targetRow = await tx.queryOne<ContactRow>('SELECT * FROM contacts WHERE id = ?', [targetContactId]);
    if (!sourceRow || !targetRow) return false;

    await mergeChannelIdentityRows(tx, sourceContactId, targetContactId);
    await mergeChannelActivityRows(tx, sourceContactId, targetContactId);
    await mergeSocialGraphForContacts(tx, sourceContactId, targetContactId);

    if (await maybeHasContactLinkedTable(tx, 'l2_memories', 'contact_id')) {
      await tx.run('UPDATE l2_memories SET contact_id = ? WHERE contact_id = ?', [targetContactId, sourceContactId]);
    }

    if (await maybeHasContactLinkedTable(tx, 'contact_profiles', 'contact_id')) {
      const targetProfileExists = await tx.queryOne<{ exists_flag: number }>(`
        SELECT 1 AS exists_flag
        FROM contact_profiles
        WHERE contact_id = ?
        LIMIT 1
      `, [targetContactId]);

      if (targetProfileExists) {
        await tx.run('DELETE FROM contact_profiles WHERE contact_id = ?', [sourceContactId]);
      } else {
        await tx.run('UPDATE contact_profiles SET contact_id = ? WHERE contact_id = ?', [targetContactId, sourceContactId]);
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

    await tx.run('DELETE FROM contacts WHERE id = ?', [sourceContactId]);
    await tx.run(`
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
    `, [
      mergedDiscordUserId,
      mergedDisplayName,
      mergedNickname,
      mergedTrustLevel,
      mergedRelationshipType,
      mergedBaseline || '{}',
      mergedFirstSeen,
      mergedLastSeen,
      mergedNotes,
      targetContactId,
    ]);

    return true;
  });
}