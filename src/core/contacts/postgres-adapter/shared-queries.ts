import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactIdentityLinkResult,
  ContactMutationAuditEntry,
} from '../types.js';
import type { EmotionalTimeSeriesPoint } from '../store/emotional-baseline.js';
import { normalizeEmotionalTimeSeries } from '../store/emotional-baseline.js';
import { defaultPrivacyForChannel, normalizeIdentity, normalizePrivacyLevel } from '../store/identity-utils.js';
import type { ContactChannelActivityRow, ContactIdentityRow, ContactRow } from './rows.js';
import { normalizeAuditActor, rowToContact } from './mapping.js';
import { queryOne, queryRows } from './connection.js';
import type { PostgresContactOperationMap } from './operation-map.js';
import type { PostgresContactStore } from './store.js';

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
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type,
               emotional_baseline, first_seen, last_seen, notes
        FROM contacts
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
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
        SELECT c.id, c.discord_user_id, c.display_name, c.nickname, c.trust_level, c.relationship_type,
               c.emotional_baseline, c.first_seen, c.last_seen, c.notes
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

export function installPostgresContactSharedOperations(store: typeof PostgresContactStore): void {
  Object.assign(store.prototype, postgresContactSharedOperations);
}
