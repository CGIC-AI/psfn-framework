import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Contact,
  ContactChannel,
  ContactChannelLink,
  ContactChannelIdentity,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  ChannelPrivacyLevel,
  RelationshipType,
} from './types.js';
import { CHANNEL_PRIVACY_LEVELS } from './types.js';
import type { TrustLevel } from '../trust/types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ContactStore');
const LEGACY_DISCORD_CHANNEL = 'discord';

interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  trust_level: string;
  relationship_type: string;
  emotional_baseline: string;
  first_seen: string;
  last_seen: string;
  notes: string | null;
}

interface ContactIdentityRow {
  contact_id: string;
  channel: string;
  channel_user_id: string;
  privacy_level: string | null;
  first_seen: string;
  last_seen: string;
}

export class ContactStore {
  private db: Database.Database;
  private primaryUserId?: string;

  constructor(db: Database.Database, primaryUserId?: string) {
    this.db = db;
    this.primaryUserId = primaryUserId;
    this.createTables();
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS contacts (
        id TEXT PRIMARY KEY,
        discord_user_id TEXT UNIQUE,
        display_name TEXT NOT NULL,
        trust_level TEXT NOT NULL DEFAULT 'regular',
        relationship_type TEXT NOT NULL DEFAULT 'stranger',
        emotional_baseline TEXT DEFAULT '{}',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        notes TEXT
      );

      CREATE TABLE IF NOT EXISTS contact_channel_ids (
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_user_id TEXT NOT NULL,
        privacy_level TEXT NOT NULL DEFAULT 'semi_private',
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (channel, channel_user_id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);
      CREATE INDEX IF NOT EXISTS idx_contacts_discord ON contacts(discord_user_id);
      CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_contact ON contact_channel_ids(contact_id);
      CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_channel ON contact_channel_ids(channel);
    `);

    this.ensureChannelPrivacyColumn();
    this.migrateLegacyDiscordIdentities();
  }

  private hasColumn(tableName: string, columnName: string): boolean {
    const rows = this.db.prepare(`PRAGMA table_info(${tableName})`)
      .all() as Array<{ name: string }>;
    return rows.some(row => row.name === columnName);
  }

  private ensureChannelPrivacyColumn(): void {
    if (!this.hasColumn('contact_channel_ids', 'privacy_level')) {
      this.db.exec("ALTER TABLE contact_channel_ids ADD COLUMN privacy_level TEXT NOT NULL DEFAULT 'semi_private'");
    }
  }

  private migrateLegacyDiscordIdentities(): void {
    this.db.prepare(`
      INSERT INTO contact_channel_ids (contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen)
      SELECT id, ?, discord_user_id, ?, first_seen, last_seen
      FROM contacts
      WHERE discord_user_id IS NOT NULL
        AND TRIM(discord_user_id) <> ''
      ON CONFLICT(channel, channel_user_id) DO NOTHING
    `).run(LEGACY_DISCORD_CHANNEL, this.defaultPrivacyForChannel(LEGACY_DISCORD_CHANNEL));
  }

  private normalizeIdentity(channel: ContactChannel, userId: string): ContactChannelIdentity {
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const normalizedUserId = userId.trim();
    if (!normalizedUserId) {
      throw new Error('Contact identity userId cannot be empty');
    }
    return {
      channel: normalizedChannel,
      userId: normalizedUserId,
    };
  }

  private defaultPrivacyForChannel(channel: ContactChannel): ChannelPrivacyLevel {
    const normalized = channel.trim().toLowerCase();
    if (normalized === 'api' || normalized === 'internal' || normalized === 'shard') {
      return 'private';
    }
    if (normalized === 'twitter' || normalized === 'rss' || normalized === 'broadcast') {
      return 'broadcast';
    }
    return 'semi_private';
  }

  private normalizePrivacyLevel(
    privacyLevel: ChannelPrivacyLevel | undefined,
    channel: ContactChannel,
  ): ChannelPrivacyLevel {
    if (!privacyLevel) return this.defaultPrivacyForChannel(channel);
    return CHANNEL_PRIVACY_LEVELS.includes(privacyLevel)
      ? privacyLevel
      : this.defaultPrivacyForChannel(channel);
  }

  private isValidChannelPrivacyLevel(level: string): level is ChannelPrivacyLevel {
    return CHANNEL_PRIVACY_LEVELS.includes(level as ChannelPrivacyLevel);
  }

  private normalizeChannelLinkInput(
    identity: ContactChannelIdentity,
    options?: ContactIdentityLinkOptions,
  ): ContactChannelLink {
    const privacyLevel = this.normalizePrivacyLevel(options?.privacyLevel, identity.channel);
    return {
      channel: identity.channel,
      userId: identity.userId,
      privacyLevel,
      firstSeen: '',
      lastSeen: '',
    };
  }

  private identityKey(identity: ContactChannelIdentity): string {
    return `${identity.channel}:${identity.userId}`;
  }

  private collectUpsertIdentities(partial: Partial<Contact>): ContactChannelLink[] {
    const identities: ContactChannelLink[] = [];
    const seen = new Set<string>();

    const addIdentity = (identity: ContactChannelLink): void => {
      const key = this.identityKey(identity);
      if (seen.has(key)) return;
      identities.push(identity);
      seen.add(key);
    };

    if (Array.isArray(partial.channels)) {
      for (const channel of partial.channels) {
        if (!channel?.channel || !channel?.userId) continue;
        const normalized = this.normalizeIdentity(channel.channel, channel.userId);
        addIdentity(this.normalizeChannelLinkInput(normalized, { privacyLevel: channel.privacyLevel }));
      }
    }

    if (Array.isArray(partial.channelIdentities)) {
      for (const identity of partial.channelIdentities) {
        if (!identity?.channel || !identity?.userId) continue;
        const normalized = this.normalizeIdentity(identity.channel, identity.userId);
        addIdentity(this.normalizeChannelLinkInput(normalized));
      }
    }

    if (partial.discordUserId) {
      const normalized = this.normalizeIdentity(LEGACY_DISCORD_CHANNEL, partial.discordUserId);
      addIdentity(this.normalizeChannelLinkInput(normalized));
    }

    return identities;
  }

  private rowToContact(row: ContactRow): Contact {
    let emotionalBaseline: Record<string, number>;
    try {
      emotionalBaseline = row.emotional_baseline
        ? JSON.parse(row.emotional_baseline) as Record<string, number>
        : {};
    } catch {
      emotionalBaseline = {};
    }

    return {
      id: row.id,
      discordUserId: row.discord_user_id ?? undefined,
      displayName: row.display_name,
      trustLevel: row.trust_level as TrustLevel,
      relationshipType: row.relationship_type as RelationshipType,
      emotionalBaseline,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
      notes: row.notes ?? undefined,
    };
  }

  private getChannelLinks(contactId: string, legacyDiscordUserId?: string): ContactChannelLink[] {
    const rows = this.db.prepare(`
      SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
      FROM contact_channel_ids
      WHERE contact_id = ?
      ORDER BY channel ASC, channel_user_id ASC
    `).all(contactId) as ContactIdentityRow[];

    const identities = rows.map((row): ContactChannelLink => ({
      channel: row.channel,
      userId: row.channel_user_id,
      privacyLevel: this.normalizePrivacyLevel(
        row.privacy_level as ChannelPrivacyLevel | undefined,
        row.channel,
      ),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    }));

    if (legacyDiscordUserId) {
      const hasLegacyIdentity = identities.some(identity => (
        identity.channel === LEGACY_DISCORD_CHANNEL && identity.userId === legacyDiscordUserId
      ));
      if (!hasLegacyIdentity) {
        identities.unshift({
          channel: LEGACY_DISCORD_CHANNEL,
          userId: legacyDiscordUserId,
          privacyLevel: this.defaultPrivacyForChannel(LEGACY_DISCORD_CHANNEL),
          firstSeen: '',
          lastSeen: '',
        });
      }
    }

    return identities;
  }

  private hydrateContact(row: ContactRow): Contact {
    const contact = this.rowToContact(row);
    const identities = this.getChannelLinks(contact.id, contact.discordUserId);
    if (identities.length > 0) {
      contact.channelIdentities = identities.map(identity => ({
        channel: identity.channel,
        userId: identity.userId,
      }));
      contact.channels = identities;
    }
    return contact;
  }

  private getLegacyDiscordUserId(
    existingDiscordUserId: string | undefined,
    partialDiscordUserId: string | undefined,
    identities: ContactChannelIdentity[],
  ): string | undefined {
    if (existingDiscordUserId) return existingDiscordUserId;
    if (partialDiscordUserId) return partialDiscordUserId;

    const discordIdentity = identities.find(identity => identity.channel === LEGACY_DISCORD_CHANNEL);
    return discordIdentity?.userId;
  }

  private findUpsertTarget(partial: Partial<Contact>, identities: ContactChannelIdentity[]): Contact | undefined {
    if (partial.id) {
      const byId = this.getById(partial.id);
      if (byId) return byId;
    }

    if (partial.discordUserId) {
      const byDiscordId = this.getByDiscordUserId(partial.discordUserId);
      if (byDiscordId) return byDiscordId;
    }

    for (const identity of identities) {
      const byIdentity = this.getByChannelIdentity(identity.channel, identity.userId);
      if (byIdentity) return byIdentity;
    }

    return undefined;
  }

  private upsertIdentityLink(
    contactId: string,
    identity: ContactChannelIdentity,
    firstSeen: string,
    lastSeen: string,
    options?: ContactIdentityLinkOptions,
  ): ContactIdentityLinkResult {
    const privacyLevel = this.normalizePrivacyLevel(options?.privacyLevel, identity.channel);
    const existing = this.db.prepare(`
      SELECT contact_id
      FROM contact_channel_ids
      WHERE channel = ? AND channel_user_id = ?
    `).get(identity.channel, identity.userId) as { contact_id: string } | undefined;

    if (existing && existing.contact_id !== contactId) {
      return 'identity_conflict';
    }

    if (existing) {
      this.db.prepare(`
        UPDATE contact_channel_ids
        SET last_seen = ?, privacy_level = COALESCE(?, privacy_level)
        WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
      `).run(lastSeen, privacyLevel, contactId, identity.channel, identity.userId);
      return 'already_linked';
    }

    this.db.prepare(`
      INSERT INTO contact_channel_ids (
        contact_id,
        channel,
        channel_user_id,
        privacy_level,
        first_seen,
        last_seen
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(contactId, identity.channel, identity.userId, privacyLevel, firstSeen, lastSeen);

    return 'linked';
  }

  private ensureLegacyDiscordUserId(contactId: string, discordUserId: string): void {
    this.db.prepare(`
      UPDATE contacts
      SET discord_user_id = COALESCE(discord_user_id, ?)
      WHERE id = ?
    `).run(discordUserId, contactId);
  }

  private applyIdentityLinks(
    contactId: string,
    identities: ContactChannelLink[],
    firstSeen: string,
    lastSeen: string,
  ): void {
    for (const identity of identities) {
      const result = this.upsertIdentityLink(
        contactId,
        identity,
        firstSeen,
        lastSeen,
        { privacyLevel: identity.privacyLevel },
      );
      if (result === 'identity_conflict') {
        log.warn('Identity conflict while linking contact identity', {
          contactId,
          channel: identity.channel,
          userId: identity.userId,
        });
        continue;
      }

      if (identity.channel === LEGACY_DISCORD_CHANNEL) {
        this.ensureLegacyDiscordUserId(contactId, identity.userId);
      }
    }
  }

  private isPrimaryIdentity(identity: ContactChannelIdentity): boolean {
    return identity.channel === LEGACY_DISCORD_CHANNEL && this.isPrimaryUser(identity.userId);
  }

  private isPrimaryContact(contact: Contact, identities: ContactChannelIdentity[]): boolean {
    if (contact.trustLevel === 'primary') return true;
    if (contact.discordUserId && this.isPrimaryUser(contact.discordUserId)) return true;
    return identities.some(identity => this.isPrimaryIdentity(identity));
  }

  /**
   * Insert or update a contact.
   * Backward compatible: discordUserId still works and is mirrored into channel identity mappings.
   */
  upsert(partial: Partial<Contact> & { displayName: string }): Contact {
    const now = new Date().toISOString();
    const identities = this.collectUpsertIdentities(partial);
    const existing = this.findUpsertTarget(partial, identities);

    if (existing) {
      const shouldForcePrimary = this.isPrimaryContact(existing, identities);
      const trustLevel = shouldForcePrimary
        ? 'primary' as TrustLevel
        : (partial.trustLevel ?? existing.trustLevel);
      const relationshipType = shouldForcePrimary
        ? 'partner' as RelationshipType
        : (partial.relationshipType ?? existing.relationshipType);
      const emotionalBaseline = partial.emotionalBaseline ?? existing.emotionalBaseline ?? {};
      const legacyDiscordUserId = this.getLegacyDiscordUserId(
        existing.discordUserId,
        partial.discordUserId,
        identities,
      );

      this.db.prepare(`
        UPDATE contacts SET
          discord_user_id = COALESCE(discord_user_id, ?),
          display_name = ?,
          trust_level = ?,
          relationship_type = ?,
          emotional_baseline = ?,
          last_seen = ?,
          notes = ?
        WHERE id = ?
      `).run(
        legacyDiscordUserId ?? null,
        partial.displayName,
        trustLevel,
        relationshipType,
        JSON.stringify(emotionalBaseline),
        now,
        partial.notes ?? existing.notes ?? null,
        existing.id,
      );

      this.applyIdentityLinks(existing.id, identities, existing.firstSeen, now);
      log.debug('Updated contact', {
        id: existing.id,
        displayName: partial.displayName,
      });

      return this.getById(existing.id)!;
    }

    const legacyDiscordUserId = this.getLegacyDiscordUserId(undefined, partial.discordUserId, identities);
    const shouldForcePrimary = identities.some(identity => this.isPrimaryIdentity(identity))
      || (legacyDiscordUserId ? this.isPrimaryUser(legacyDiscordUserId) : false);

    const contact: Contact = {
      id: partial.id ?? uuidv4(),
      discordUserId: legacyDiscordUserId,
      displayName: partial.displayName,
      trustLevel: shouldForcePrimary ? 'primary' : (partial.trustLevel ?? 'regular'),
      relationshipType: shouldForcePrimary ? 'partner' : (partial.relationshipType ?? 'stranger'),
      emotionalBaseline: partial.emotionalBaseline ?? {},
      firstSeen: partial.firstSeen ?? now,
      lastSeen: partial.lastSeen ?? now,
      notes: partial.notes,
    };

    this.db.prepare(`
      INSERT INTO contacts (id, discord_user_id, display_name, trust_level, relationship_type,
        emotional_baseline, first_seen, last_seen, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contact.id,
      contact.discordUserId ?? null,
      contact.displayName,
      contact.trustLevel,
      contact.relationshipType,
      JSON.stringify(contact.emotionalBaseline ?? {}),
      contact.firstSeen,
      contact.lastSeen,
      contact.notes ?? null,
    );

    this.applyIdentityLinks(contact.id, identities, contact.firstSeen, contact.lastSeen);

    log.debug('Created contact', { id: contact.id, displayName: contact.displayName });
    return this.getById(contact.id)!;
  }

  /** Get a contact by its internal UUID. */
  getById(id: string): Contact | undefined {
    const row = this.db.prepare('SELECT * FROM contacts WHERE id = ?').get(id) as ContactRow | undefined;
    return row ? this.hydrateContact(row) : undefined;
  }

  /** Get a contact by Discord user ID (legacy + mapped aliases). */
  getByDiscordUserId(discordUserId: string): Contact | undefined {
    const trimmedDiscordId = discordUserId.trim();
    if (!trimmedDiscordId) return undefined;

    const row = this.db.prepare('SELECT * FROM contacts WHERE discord_user_id = ?')
      .get(trimmedDiscordId) as ContactRow | undefined;

    if (row) return this.hydrateContact(row);
    return this.getByChannelIdentity(LEGACY_DISCORD_CHANNEL, trimmedDiscordId);
  }

  /** Get a contact by channel identity (channel + channel-specific user id). */
  getByChannelIdentity(channel: ContactChannel, channelUserId: string): Contact | undefined {
    const identity = this.normalizeIdentity(channel, channelUserId);

    const row = this.db.prepare(`
      SELECT c.*
      FROM contacts c
      INNER JOIN contact_channel_ids i ON i.contact_id = c.id
      WHERE i.channel = ? AND i.channel_user_id = ?
      LIMIT 1
    `).get(identity.channel, identity.userId) as ContactRow | undefined;

    if (row) return this.hydrateContact(row);

    if (identity.channel === LEGACY_DISCORD_CHANNEL) {
      const legacyRow = this.db.prepare('SELECT * FROM contacts WHERE discord_user_id = ?')
        .get(identity.userId) as ContactRow | undefined;
      if (legacyRow) {
        this.upsertIdentityLink(legacyRow.id, identity, legacyRow.first_seen, legacyRow.last_seen);
        return this.hydrateContact(legacyRow);
      }
    }

    return undefined;
  }

  /** Get all contacts at a given trust level. */
  getByTrustLevel(trustLevel: TrustLevel): Contact[] {
    const rows = this.db.prepare('SELECT * FROM contacts WHERE trust_level = ?')
      .all(trustLevel) as ContactRow[];
    return rows.map(row => this.hydrateContact(row));
  }

  /**
   * Update a contact's trust level.
   * Returns false if not found or if attempting to change primary user.
   */
  setTrustLevel(id: string, trustLevel: TrustLevel): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    if (contact.trustLevel === 'primary') {
      log.warn('Attempted to change primary user trust level', { id });
      return false;
    }

    this.db.prepare('UPDATE contacts SET trust_level = ? WHERE id = ?').run(trustLevel, id);
    log.debug('Updated trust level', { id, trustLevel });
    return true;
  }

  /** Update a contact's last_seen timestamp to now. */
  updateLastSeen(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE contacts SET last_seen = ? WHERE id = ?').run(now, id);
    this.db.prepare('UPDATE contact_channel_ids SET last_seen = ? WHERE contact_id = ?').run(now, id);
  }

  /** Update a contact's notes. Returns false if not found. */
  updateNotes(id: string, notes: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    this.db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').run(notes, id);
    return true;
  }

  /** Update a contact's relationship type. Returns false if not found. */
  updateRelationshipType(id: string, relationshipType: RelationshipType): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    if (contact.trustLevel === 'primary' && relationshipType !== 'partner') {
      log.warn('Attempted to change primary user relationship type', { id, relationshipType });
      return false;
    }

    this.db.prepare('UPDATE contacts SET relationship_type = ? WHERE id = ?').run(relationshipType, id);
    return true;
  }

  /** Update privacy level for a linked channel identity. */
  setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
  ): boolean {
    if (!this.isValidChannelPrivacyLevel(privacyLevel)) return false;

    const identity = this.normalizeIdentity(channel, channelUserId);
    const result = this.db.prepare(`
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

  /** Link an additional channel identity to an existing contact. */
  linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
  ): ContactIdentityLinkResult {
    const contact = this.getById(contactId);
    if (!contact) return 'contact_not_found';

    const now = new Date().toISOString();
    const identity = this.normalizeIdentity(channel, channelUserId);
    const result = this.upsertIdentityLink(contactId, identity, contact.firstSeen, now, options);

    if (result !== 'identity_conflict' && identity.channel === LEGACY_DISCORD_CHANNEL) {
      this.ensureLegacyDiscordUserId(contactId, identity.userId);
    }

    return result;
  }

  /** List all contacts. */
  listAll(): Contact[] {
    const rows = this.db.prepare('SELECT * FROM contacts ORDER BY last_seen DESC').all() as ContactRow[];
    return rows.map(row => this.hydrateContact(row));
  }

  /**
   * Resolve channel-aware identity to a contact.
   * Creates a new contact when no mapping exists.
   */
  resolveChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
    displayName?: string,
  ): Contact {
    const identity = this.normalizeIdentity(channel, channelUserId);
    const existing = this.getByChannelIdentity(identity.channel, identity.userId);

    if (existing) {
      this.updateLastSeen(existing.id);
      this.upsertIdentityLink(existing.id, identity, existing.firstSeen, new Date().toISOString());
      return this.getById(existing.id)!;
    }

    const isPrimary = this.isPrimaryIdentity(identity);
    return this.upsert({
      displayName: displayName?.trim() || identity.userId,
      channels: [{
        channel: identity.channel,
        userId: identity.userId,
        privacyLevel: this.defaultPrivacyForChannel(identity.channel),
        firstSeen: '',
        lastSeen: '',
      }],
      channelIdentities: [identity],
      discordUserId: identity.channel === LEGACY_DISCORD_CHANNEL ? identity.userId : undefined,
      trustLevel: isPrimary ? 'primary' : 'regular',
      relationshipType: isPrimary ? 'partner' : 'stranger',
    });
  }

  /**
   * Resolve a legacy Discord user ID to a contact.
   * Backward compatible wrapper over channel-aware identity resolution.
   */
  resolveUserId(discordUserId: string): Contact {
    return this.resolveChannelIdentity(LEGACY_DISCORD_CHANNEL, discordUserId, discordUserId);
  }

  /** Resolve channel identity to canonical contact key without creating new contacts. */
  getCanonicalContactKey(channel: ContactChannel, channelUserId: string): string | undefined {
    const contact = this.getByChannelIdentity(channel, channelUserId);
    return contact?.id;
  }

  private isPrimaryUser(discordUserId: string): boolean {
    return !!this.primaryUserId && discordUserId === this.primaryUserId;
  }
}
