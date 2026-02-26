import type Database from 'better-sqlite3';
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

export function mergeChannelIdentityRows(
  db: Database.Database,
  sourceContactId: string,
  targetContactId: string,
): void {
  const sourceRows = db.prepare(`
    SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
    FROM contact_channel_ids
    WHERE contact_id = ?
    ORDER BY channel ASC, channel_user_id ASC
  `).all(sourceContactId) as ContactIdentityRow[];
  if (sourceRows.length === 0) return;

  const getTargetRow = db.prepare(`
    SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
    FROM contact_channel_ids
    WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
    LIMIT 1
  `);
  const updateTargetRow = db.prepare(`
    UPDATE contact_channel_ids
    SET privacy_level = ?, first_seen = ?, last_seen = ?
    WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
  `);
  const moveIdentity = db.prepare(`
    UPDATE contact_channel_ids
    SET contact_id = ?
    WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
  `);
  const deleteSourceIdentity = db.prepare(`
    DELETE FROM contact_channel_ids
    WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
  `);

  for (const sourceRow of sourceRows) {
    const targetRow = getTargetRow.get(
      targetContactId,
      sourceRow.channel,
      sourceRow.channel_user_id,
    ) as ContactIdentityRow | undefined;

    if (!targetRow) {
      moveIdentity.run(
        targetContactId,
        sourceContactId,
        sourceRow.channel,
        sourceRow.channel_user_id,
      );
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

    updateTargetRow.run(
      mergedPrivacy,
      mergedFirstSeen,
      mergedLastSeen,
      targetContactId,
      sourceRow.channel,
      sourceRow.channel_user_id,
    );

    deleteSourceIdentity.run(sourceContactId, sourceRow.channel, sourceRow.channel_user_id);
  }
}

export function mergeChannelActivityRows(
  db: Database.Database,
  sourceContactId: string,
  targetContactId: string,
): void {
  const sourceRows = db.prepare(`
    SELECT contact_id, channel, channel_id, first_seen, last_seen
    FROM contact_channel_activity
    WHERE contact_id = ?
    ORDER BY channel ASC, channel_id ASC
  `).all(sourceContactId) as ContactChannelActivityRow[];
  if (sourceRows.length === 0) return;

  const getTargetRow = db.prepare(`
    SELECT contact_id, channel, channel_id, first_seen, last_seen
    FROM contact_channel_activity
    WHERE contact_id = ? AND channel = ? AND channel_id = ?
    LIMIT 1
  `);
  const updateTargetRow = db.prepare(`
    UPDATE contact_channel_activity
    SET first_seen = ?, last_seen = ?
    WHERE contact_id = ? AND channel = ? AND channel_id = ?
  `);
  const moveActivity = db.prepare(`
    UPDATE contact_channel_activity
    SET contact_id = ?
    WHERE contact_id = ? AND channel = ? AND channel_id = ?
  `);
  const deleteSourceActivity = db.prepare(`
    DELETE FROM contact_channel_activity
    WHERE contact_id = ? AND channel = ? AND channel_id = ?
  `);

  for (const sourceRow of sourceRows) {
    const targetRow = getTargetRow.get(
      targetContactId,
      sourceRow.channel,
      sourceRow.channel_id,
    ) as ContactChannelActivityRow | undefined;

    if (!targetRow) {
      moveActivity.run(
        targetContactId,
        sourceContactId,
        sourceRow.channel,
        sourceRow.channel_id,
      );
      continue;
    }

    updateTargetRow.run(
      earliestTimestamp(sourceRow.first_seen, targetRow.first_seen),
      latestTimestamp(sourceRow.last_seen, targetRow.last_seen),
      targetContactId,
      sourceRow.channel,
      sourceRow.channel_id,
    );
    deleteSourceActivity.run(sourceContactId, sourceRow.channel, sourceRow.channel_id);
  }
}
