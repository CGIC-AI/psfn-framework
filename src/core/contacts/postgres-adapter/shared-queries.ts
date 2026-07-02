import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactIdentityLinkResult,
  ContactMutationAuditEntry,
  RelationshipType,
  RoomQueryOptions,
  RoomRosterMember,
  RoomSummary,
} from '../types.js';
import {
  DEFAULT_KNOWN_ROOMS_LIMIT,
  DEFAULT_ROOM_ROSTER_LIMIT,
  MAX_KNOWN_ROOMS_LIMIT,
  MAX_ROOM_ROSTER_LIMIT,
} from '../types.js';
import type { TrustLevel } from '../../../system/trust/types.js';
import type { EmotionalTimeSeriesPoint } from '../store/emotional-baseline.js';
import { normalizeEmotionalTimeSeries } from '../store/emotional-baseline.js';
import { defaultPrivacyForChannel, normalizeIdentity, normalizePrivacyLevel } from '../store/identity-utils.js';
import type { ContactChannelActivityRow, ContactIdentityRow, ContactRow } from './rows.js';
import { normalizeAuditActor, rowToContact } from './mapping.js';
import { queryOne, queryRows } from './connection.js';
import type { PostgresContactOperationMap, PostgresContactStoreClass } from './operation-map.js';

// ── Room roster (E4.1) ── bound helpers, mirrored with the SQLite adapter.
function clampRoomLimit(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const floored = Math.floor(limit);
  if (floored <= 0) return fallback;
  return Math.min(floored, max);
}

function clampRoomOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  const floored = Math.floor(offset);
  return floored > 0 ? floored : 0;
}

const postgresContactSharedOperations: PostgresContactOperationMap = {
  async tableExists(tableName: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      this.pool,
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [tableName],
    );
    return Boolean(row?.exists);
  },

  async loadContactRow(id: string): Promise<ContactRow | undefined> {
    return await queryOne<ContactRow>(
      this.pool,
      `
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type, is_machine_intelligence,
               emotional_baseline, first_seen, last_seen, notes, timezone
        FROM contacts
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
  },

  async loadContactById(id: string): Promise<Contact | undefined> {
    const row = await this.loadContactRow(id);
    return row ? await this.loadContactByRow(row) : undefined;
  },

  async loadContactEmotionalTimeSeries(
    id: string,
    limit?: number,
  ): Promise<EmotionalTimeSeriesPoint[]> {
    const row = await queryOne<{ emotional_time_series?: unknown }>(
      this.pool,
      `
        SELECT emotional_time_series
        FROM contacts
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
    return normalizeEmotionalTimeSeries(row?.emotional_time_series, limit);
  },

  async loadContactByChannelIdentity(channel: ContactChannel, channelUserId: string): Promise<Contact | undefined> {
    const identity = normalizeIdentity(channel, channelUserId);
    const row = await queryOne<ContactRow>(
      this.pool,
      `
        SELECT c.id, c.discord_user_id, c.display_name, c.nickname, c.trust_level, c.relationship_type, c.is_machine_intelligence,
               c.emotional_baseline, c.first_seen, c.last_seen, c.notes, c.timezone
        FROM contacts c
        INNER JOIN contact_channel_ids i ON i.contact_id = c.id
        WHERE i.channel = $1 AND i.channel_user_id = $2
        LIMIT 1
      `,
      [identity.channel, identity.userId],
    );
    if (row) {
      return await this.loadContactByRow(row);
    }

    if (identity.channel === 'discord') {
      const legacyRow = await this.loadContactRow(identity.userId);
      if (legacyRow) {
        await this.upsertIdentityLinkRecord(
          legacyRow.id,
          identity.channel,
          identity.userId,
          legacyRow.first_seen,
          legacyRow.last_seen,
          defaultPrivacyForChannel(identity.channel),
        );
        return await this.loadContactByRow(legacyRow);
      }
    }

    return undefined;
  },

  async loadContactByRow(row: ContactRow): Promise<Contact> {
    const identities = await queryRows<ContactIdentityRow>(
      this.pool,
      `
        SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
        FROM contact_channel_ids
        WHERE contact_id = $1
        ORDER BY channel ASC, channel_user_id ASC
      `,
      [row.id],
    );
    const conversationChannels = await queryRows<ContactChannelActivityRow>(
      this.pool,
      `
        SELECT contact_id, channel, channel_id, privacy_level, first_seen, last_seen
        FROM contact_channel_activity
        WHERE contact_id = $1
        ORDER BY last_seen DESC, channel ASC, channel_id ASC
      `,
      [row.id],
    );
    return rowToContact(row, identities, conversationChannels);
  },

  async touchContactLastSeen(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query('UPDATE contacts SET last_seen = $1 WHERE id = $2', [now, id]);
    await this.pool.query('UPDATE contact_channel_ids SET last_seen = $1 WHERE contact_id = $2', [now, id]);
    await this.pool.query('UPDATE contact_channel_activity SET last_seen = $1 WHERE contact_id = $2', [now, id]);
  },

  // ── Room roster (E4.1) ──
  // Bounded read-only queries over contact_channel_activity joined to the owning
  // contact row (only the columns the room surface needs — no full-contact
  // hydration). E3.3 (audienceScope) and E4.4 are the later consumers.
  async listKnownRooms(options?: Pick<RoomQueryOptions, 'limit' | 'offset'>): Promise<RoomSummary[]> {
    const limit = clampRoomLimit(options?.limit, DEFAULT_KNOWN_ROOMS_LIMIT, MAX_KNOWN_ROOMS_LIMIT);
    const offset = clampRoomOffset(options?.offset);
    const rows = await queryRows<{
      channel: string;
      channel_id: string;
      member_count: string | number;
      first_activity: string;
      last_activity: string;
    }>(
      this.pool,
      `
        SELECT channel,
               channel_id,
               COUNT(*) AS member_count,
               MIN(first_seen) AS first_activity,
               MAX(last_seen) AS last_activity
        FROM contact_channel_activity
        GROUP BY channel, channel_id
        ORDER BY last_activity DESC, channel ASC, channel_id ASC
        LIMIT $1 OFFSET $2
      `,
      [limit, offset],
    );
    return rows.map(row => ({
      channel: row.channel,
      channelId: row.channel_id,
      memberCount: Number(row.member_count),
      firstActivity: row.first_activity,
      lastActivity: row.last_activity,
    }));
  },

  async countKnownRooms(): Promise<number> {
    const row = await queryOne<{ total: string | number }>(
      this.pool,
      `
        SELECT COUNT(*) AS total FROM (
          SELECT 1 FROM contact_channel_activity GROUP BY channel, channel_id
        ) AS rooms
      `,
      [],
    );
    return Number(row?.total ?? 0);
  },

  async listRoomRoster(channelId: string, options?: RoomQueryOptions): Promise<RoomRosterMember[]> {
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return [];
    const limit = clampRoomLimit(options?.limit, DEFAULT_ROOM_ROSTER_LIMIT, MAX_ROOM_ROSTER_LIMIT);
    const offset = clampRoomOffset(options?.offset);
    const normalizedChannel = options?.channel?.trim().toLowerCase() || undefined;

    const params: Array<string | number> = [trimmedChannelId];
    let channelFilter = '';
    if (normalizedChannel) {
      params.push(normalizedChannel);
      channelFilter = `AND a.channel = $${params.length}`;
    }
    params.push(limit);
    const limitPlaceholder = `$${params.length}`;
    params.push(offset);
    const offsetPlaceholder = `$${params.length}`;

    const rows = await queryRows<{
      contact_id: string;
      display_name: string;
      trust_level: string;
      relationship_type: string;
      channel: string;
      channel_id: string;
      privacy_level: string | null;
      first_seen: string;
      last_seen: string;
    }>(
      this.pool,
      `
        SELECT c.id AS contact_id,
               c.display_name,
               c.trust_level,
               c.relationship_type,
               a.channel,
               a.channel_id,
               a.privacy_level,
               a.first_seen,
               a.last_seen
        FROM contact_channel_activity a
        INNER JOIN contacts c ON c.id = a.contact_id
        WHERE a.channel_id = $1
          ${channelFilter}
        ORDER BY a.last_seen DESC, c.display_name ASC, c.id ASC
        LIMIT ${limitPlaceholder} OFFSET ${offsetPlaceholder}
      `,
      params,
    );
    return rows.map(row => ({
      contactId: row.contact_id,
      displayName: row.display_name,
      trustLevel: row.trust_level as TrustLevel,
      relationshipType: row.relationship_type as RelationshipType,
      channel: row.channel,
      channelId: row.channel_id,
      privacyLevel: row.privacy_level
        ? normalizePrivacyLevel(row.privacy_level as ChannelPrivacyLevel, row.channel)
        : null,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    }));
  },

  async countRoomRoster(channelId: string, options?: Pick<RoomQueryOptions, 'channel'>): Promise<number> {
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return 0;
    const normalizedChannel = options?.channel?.trim().toLowerCase() || undefined;
    const params: string[] = [trimmedChannelId];
    let channelFilter = '';
    if (normalizedChannel) {
      params.push(normalizedChannel);
      channelFilter = `AND channel = $${params.length}`;
    }
    const row = await queryOne<{ total: string | number }>(
      this.pool,
      `
        SELECT COUNT(*) AS total
        FROM contact_channel_activity
        WHERE channel_id = $1
          ${channelFilter}
      `,
      params,
    );
    return Number(row?.total ?? 0);
  },

  async appendMutationAuditEntry(
    contactId: string,
    field: ContactMutationAuditEntry['field'],
    oldValue: string | null,
    newValue: string | null,
    actor?: string,
  ): Promise<void> {
    await this.pool.query(
      `
        INSERT INTO contact_mutation_audit (
          contact_id,
          actor,
          field,
          old_value,
          new_value,
          timestamp
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [contactId, normalizeAuditActor(actor), field, oldValue, newValue, new Date().toISOString()],
    );
  },

  async upsertIdentityLinkRecord(
    contactId: string,
    channel: string,
    channelUserId: string,
    firstSeen: string,
    lastSeen: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): Promise<ContactIdentityLinkResult> {
    const normalized = normalizeIdentity(channel, channelUserId);
    const existing = await queryOne<{ contact_id: string }>(
      this.pool,
      `
        SELECT contact_id
        FROM contact_channel_ids
        WHERE channel = $1 AND channel_user_id = $2
        LIMIT 1
      `,
      [normalized.channel, normalized.userId],
    );

    if (existing && existing.contact_id !== contactId) {
      return 'identity_conflict';
    }

    const privacy = normalizePrivacyLevel(privacyLevel, normalized.channel);
    if (existing) {
      await this.pool.query(
        `
          UPDATE contact_channel_ids
          SET last_seen = $1,
              privacy_level = COALESCE($2, privacy_level)
          WHERE contact_id = $3 AND channel = $4 AND channel_user_id = $5
        `,
        [lastSeen, privacy, contactId, normalized.channel, normalized.userId],
      );
      return 'already_linked';
    }

    await this.pool.query(
      `
        INSERT INTO contact_channel_ids (
          contact_id,
          channel,
          channel_user_id,
          privacy_level,
          first_seen,
          last_seen
        )
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [contactId, normalized.channel, normalized.userId, privacy, firstSeen, lastSeen],
    );

    if (normalized.channel === 'discord') {
      await this.pool.query(
        `
          UPDATE contacts
          SET discord_user_id = COALESCE(discord_user_id, $1)
          WHERE id = $2
        `,
        [normalized.userId, contactId],
      );
    }

    return 'linked';
  },

  async syncContactExports(): Promise<void> {
    if (!this.exportDir) return;

    try {
      mkdirSync(this.exportDir, { recursive: true });
      const contacts = await this.listAll();
      const indexPath = join(this.exportDir, 'index.json');

      writeJsonAtomic(indexPath, {
        updatedAt: new Date().toISOString(),
        count: contacts.length,
        contacts: contacts.map(contact => ({
          id: contact.id,
          displayName: contact.displayName,
          nickname: contact.nickname,
          trustLevel: contact.trustLevel,
          relationshipType: contact.relationshipType,
          lastSeen: contact.lastSeen,
        })),
      });

      const expectedFiles = new Set<string>(['index.json']);
      for (const contact of contacts) {
        const fileName = `contact-${contact.id.replace(/[^a-zA-Z0-9._-]/g, '_')}.json`;
        expectedFiles.add(fileName);
        writeJsonAtomic(join(this.exportDir, fileName), contact);
      }

      for (const fileName of readdirSync(this.exportDir)) {
        if (!fileName.endsWith('.json')) continue;
        if (expectedFiles.has(fileName)) continue;
        unlinkSync(join(this.exportDir, fileName));
      }
    } catch (error) {
      // Export mirrors are best-effort only.
      console.error('Failed to sync contact file exports', {
        exportDir: this.exportDir,
        error: String(error),
      });
    }
  },
};

export function installPostgresContactSharedOperations(store: PostgresContactStoreClass): void {
  Object.assign(store.prototype, postgresContactSharedOperations);
}
