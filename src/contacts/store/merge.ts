import type { DatabaseAdapter } from '../../persistence/db-adapter.js';
import type { ChannelPrivacyLevel } from '../types.js';
import {
  compareIsoTimestamps,
  earliestTimestamp,
  latestTimestamp,
  normalizePrivacyLevel,
} from './identity-utils.js';
import type {
  ContactChannelActivityRow,
  ContactIdentityRow,
} from './domain-types.js';

export async function mergeChannelIdentityRows(
  adapter: DatabaseAdapter,
  sourceContactId: string,
  targetContactId: string,
): Promise<void> {
  const sourceRows = await adapter.query<ContactIdentityRow>(`
    SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
    FROM contact_channel_ids
    WHERE contact_id = ?
    ORDER BY channel ASC, channel_user_id ASC
  `, [sourceContactId]);
  if (sourceRows.length === 0) return;

  for (const sourceRow of sourceRows) {
    const targetRow = await adapter.queryOne<ContactIdentityRow>(`
      SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
      FROM contact_channel_ids
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
      LIMIT 1
    `, [targetContactId, sourceRow.channel, sourceRow.channel_user_id]);

    if (!targetRow) {
      await adapter.run(`
        UPDATE contact_channel_ids
        SET contact_id = ?
        WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
      `, [targetContactId, sourceContactId, sourceRow.channel, sourceRow.channel_user_id]);
      continue;
    }

    const sourceIsNewer = compareIsoTimestamps(sourceRow.last_seen, targetRow.last_seen) > 0;
    const winner = sourceIsNewer ? sourceRow : targetRow;
    const mergedPrivacy = normalizePrivacyLevel(
      winner.privacy_level as ChannelPrivacyLevel | undefined,
      winner.channel,
    );
    const mergedFirstSeen = earliestTimestamp(sourceRow.first_seen, targetRow.first_seen);
    const mergedLastSeen = sourceIsNewer ? sourceRow.last_seen : targetRow.last_seen;

    await adapter.run(`
      UPDATE contact_channel_ids
      SET privacy_level = ?, first_seen = ?, last_seen = ?
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
    `, [
      mergedPrivacy,
      mergedFirstSeen,
      mergedLastSeen,
      targetContactId,
      sourceRow.channel,
      sourceRow.channel_user_id,
    ]);

    await adapter.run(`
      DELETE FROM contact_channel_ids
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
    `, [sourceContactId, sourceRow.channel, sourceRow.channel_user_id]);
  }
}

export async function mergeChannelActivityRows(
  adapter: DatabaseAdapter,
  sourceContactId: string,
  targetContactId: string,
): Promise<void> {
  const sourceRows = await adapter.query<ContactChannelActivityRow>(`
    SELECT contact_id, channel, channel_id, privacy_level, first_seen, last_seen
    FROM contact_channel_activity
    WHERE contact_id = ?
    ORDER BY channel ASC, channel_id ASC
  `, [sourceContactId]);
  if (sourceRows.length === 0) return;

  for (const sourceRow of sourceRows) {
    const targetRow = await adapter.queryOne<ContactChannelActivityRow>(`
      SELECT contact_id, channel, channel_id, privacy_level, first_seen, last_seen
      FROM contact_channel_activity
      WHERE contact_id = ? AND channel = ? AND channel_id = ?
      LIMIT 1
    `, [targetContactId, sourceRow.channel, sourceRow.channel_id]);

    if (!targetRow) {
      await adapter.run(`
        UPDATE contact_channel_activity
        SET contact_id = ?
        WHERE contact_id = ? AND channel = ? AND channel_id = ?
      `, [targetContactId, sourceContactId, sourceRow.channel, sourceRow.channel_id]);
      continue;
    }

    const sourceHasExplicitPrivacy = typeof sourceRow.privacy_level === 'string' && sourceRow.privacy_level.trim().length > 0;
    const targetHasExplicitPrivacy = typeof targetRow.privacy_level === 'string' && targetRow.privacy_level.trim().length > 0;
    const mergedPrivacy = sourceHasExplicitPrivacy && !targetHasExplicitPrivacy
      ? normalizePrivacyLevel(sourceRow.privacy_level as ChannelPrivacyLevel, sourceRow.channel)
      : (!sourceHasExplicitPrivacy && targetHasExplicitPrivacy)
          ? normalizePrivacyLevel(targetRow.privacy_level as ChannelPrivacyLevel, targetRow.channel)
          : (sourceHasExplicitPrivacy && targetHasExplicitPrivacy)
              ? normalizePrivacyLevel(
                (compareIsoTimestamps(sourceRow.last_seen, targetRow.last_seen) >= 0
                  ? sourceRow.privacy_level
                  : targetRow.privacy_level) as ChannelPrivacyLevel,
                compareIsoTimestamps(sourceRow.last_seen, targetRow.last_seen) >= 0
                  ? sourceRow.channel
                  : targetRow.channel,
              )
              : null;

    await adapter.run(`
      UPDATE contact_channel_activity
      SET privacy_level = ?, first_seen = ?, last_seen = ?
      WHERE contact_id = ? AND channel = ? AND channel_id = ?
    `, [
      mergedPrivacy,
      earliestTimestamp(sourceRow.first_seen, targetRow.first_seen),
      latestTimestamp(sourceRow.last_seen, targetRow.last_seen),
      targetContactId,
      sourceRow.channel,
      sourceRow.channel_id,
    ]);
    await adapter.run(`
      DELETE FROM contact_channel_activity
      WHERE contact_id = ? AND channel = ? AND channel_id = ?
    `, [sourceContactId, sourceRow.channel, sourceRow.channel_id]);
  }
}