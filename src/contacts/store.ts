import type Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import type {
  Contact,
  ContactChannel,
  ContactChannelLink,
  ContactChannelIdentity,
  ContactConversationChannel,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  ContactIdentityLinkChallengeInput,
  ContactIdentityLinkChallengeResult,
  ContactIdentityLinkVerification,
  ContactIdentityLinkVerificationInput,
  ContactIdentityLinkVerificationResult,
  ContactIdentityLinkVerificationState,
  ContactMutationAuditEntry,
  ContactMutationAuditField,
  ContactMutationAuditQuery,
  ChannelPrivacyLevel,
  RelationshipType,
} from './types.js';
import { CHANNEL_PRIVACY_LEVELS } from './types.js';
import type { TrustLevel } from '../trust/types.js';
import { createComponentLogger } from '../logger.js';

const log = createComponentLogger('ContactStore');
const LEGACY_DISCORD_CHANNEL = 'discord';
const DEFAULT_LINK_VERIFICATION_TTL_MS = 5 * 60_000;

interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  nickname: string | null;
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

interface ContactChannelActivityRow {
  contact_id: string;
  channel: string;
  channel_id: string;
  first_seen: string;
  last_seen: string;
}

interface ContactIdentityVerificationRow {
  id: string;
  contact_id: string;
  source_channel: string;
  source_user_id: string;
  target_channel: string;
  target_user_id: string;
  nonce: string;
  expires_at: string;
  signature: string;
  status: string;
  created_at: string;
  updated_at: string;
  verified_at: string | null;
  failure_reason: string | null;
}

interface ContactMutationAuditRow {
  id: number;
  contact_id: string;
  actor: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  timestamp: string;
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
        nickname TEXT,
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

      CREATE TABLE IF NOT EXISTS contact_channel_activity (
        contact_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        first_seen TEXT NOT NULL,
        last_seen TEXT NOT NULL,
        PRIMARY KEY (contact_id, channel, channel_id),
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS contact_identity_link_verifications (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        source_channel TEXT NOT NULL,
        source_user_id TEXT NOT NULL,
        target_channel TEXT NOT NULL,
        target_user_id TEXT NOT NULL,
        nonce TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        signature TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        verified_at TEXT,
        failure_reason TEXT,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS contact_mutation_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        contact_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        field TEXT NOT NULL,
        old_value TEXT,
        new_value TEXT,
        timestamp TEXT NOT NULL,
        FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_contacts_trust ON contacts(trust_level);
      CREATE INDEX IF NOT EXISTS idx_contacts_discord ON contacts(discord_user_id);
      CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_contact ON contact_channel_ids(contact_id);
      CREATE INDEX IF NOT EXISTS idx_contact_channel_ids_channel ON contact_channel_ids(channel);
      CREATE INDEX IF NOT EXISTS idx_contact_channel_activity_contact
        ON contact_channel_activity(contact_id, last_seen);
      CREATE INDEX IF NOT EXISTS idx_contact_channel_activity_channel
        ON contact_channel_activity(channel, channel_id);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_link_verifications_contact
        ON contact_identity_link_verifications(contact_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_identity_link_verifications_lookup
        ON contact_identity_link_verifications(
          contact_id,
          source_channel,
          source_user_id,
          target_channel,
          target_user_id,
          nonce
        );
      CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_contact
        ON contact_mutation_audit(contact_id, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_field
        ON contact_mutation_audit(field, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_contact_mutation_audit_actor
        ON contact_mutation_audit(actor, timestamp DESC);
    `);

    this.ensureNicknameColumn();
    this.ensureChannelPrivacyColumn();
    this.migrateLegacyDiscordIdentities();
  }

  private hasTable(tableName: string): boolean {
    const row = this.db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name = ?
      LIMIT 1
    `).get(tableName) as { name: string } | undefined;
    return row?.name === tableName;
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

  private ensureNicknameColumn(): void {
    if (!this.hasColumn('contacts', 'nickname')) {
      this.db.exec('ALTER TABLE contacts ADD COLUMN nickname TEXT');
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

  private normalizeVerificationTtlMs(ttlMs: number | undefined): number {
    if (!Number.isFinite(ttlMs) || !ttlMs || ttlMs <= 0) {
      return DEFAULT_LINK_VERIFICATION_TTL_MS;
    }
    return Math.min(Math.floor(ttlMs), 60 * 60_000);
  }

  private createVerificationToken(): string {
    return uuidv4().replace(/-/g, '');
  }

  private normalizeVerificationState(value: string): ContactIdentityLinkVerificationState {
    switch (value) {
      case 'verified':
      case 'failed':
      case 'expired':
      case 'pending':
        return value;
      default:
        return 'pending';
    }
  }

  private toIdentityLinkVerification(
    row: ContactIdentityVerificationRow,
  ): ContactIdentityLinkVerification {
    return {
      id: row.id,
      contactId: row.contact_id,
      sourceChannel: row.source_channel,
      sourceUserId: row.source_user_id,
      targetChannel: row.target_channel,
      targetUserId: row.target_user_id,
      nonce: row.nonce,
      expiresAt: row.expires_at,
      signature: row.signature,
      status: this.normalizeVerificationState(row.status),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      verifiedAt: row.verified_at ?? undefined,
      failureReason: row.failure_reason ?? undefined,
    };
  }

  private normalizeMutationAuditField(value: string): ContactMutationAuditField | undefined {
    switch (value) {
      case 'trust_level':
      case 'notes':
        return value;
      default:
        return undefined;
    }
  }

  private toMutationAuditEntry(row: ContactMutationAuditRow): ContactMutationAuditEntry | undefined {
    const field = this.normalizeMutationAuditField(row.field);
    if (!field) return undefined;

    return {
      id: row.id,
      contactId: row.contact_id,
      actor: row.actor,
      field,
      oldValue: row.old_value,
      newValue: row.new_value,
      timestamp: row.timestamp,
    };
  }

  private normalizeAuditActor(actor: string | undefined): string {
    const trimmed = actor?.trim();
    if (!trimmed) return 'system:unknown';
    return trimmed.slice(0, 120);
  }

  private appendMutationAuditEntry(
    contactId: string,
    field: ContactMutationAuditField,
    oldValue: string | null,
    newValue: string | null,
    actor?: string,
  ): void {
    this.db.prepare(`
      INSERT INTO contact_mutation_audit (
        contact_id,
        actor,
        field,
        old_value,
        new_value,
        timestamp
      )
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      contactId,
      this.normalizeAuditActor(actor),
      field,
      oldValue,
      newValue,
      new Date().toISOString(),
    );
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
      nickname: row.nickname ?? undefined,
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

  private getConversationChannels(contactId: string): ContactConversationChannel[] {
    const rows = this.db.prepare(`
      SELECT contact_id, channel, channel_id, first_seen, last_seen
      FROM contact_channel_activity
      WHERE contact_id = ?
      ORDER BY last_seen DESC, channel ASC, channel_id ASC
    `).all(contactId) as ContactChannelActivityRow[];

    return rows.map((row): ContactConversationChannel => ({
      channel: row.channel,
      channelId: row.channel_id,
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    }));
  }

  private hydrateContact(row: ContactRow): Contact {
    const contact = this.rowToContact(row);
    const identities = this.getChannelLinks(contact.id, contact.discordUserId);
    const conversationChannels = this.getConversationChannels(contact.id);
    if (identities.length > 0) {
      contact.channelIdentities = identities.map(identity => ({
        channel: identity.channel,
        userId: identity.userId,
      }));
      contact.channels = identities;
    }
    if (conversationChannels.length > 0) {
      contact.conversationChannels = conversationChannels;
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

  private normalizeNicknameValue(nickname: string | undefined): string | null | undefined {
    if (nickname === undefined) return undefined;
    const trimmed = nickname.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  private looksLikeOpaqueIdentifier(value: string): boolean {
    const trimmed = value.trim();
    if (!trimmed) return true;
    if (/^\d{8,}$/.test(trimmed)) return true;
    if (trimmed.includes(':')) return true;
    if (/^(api|discord|unknown|session|user|id)[-_:.]?[a-z0-9-_.]*$/i.test(trimmed)) return true;
    return false;
  }

  private pickPreferredDisplayName(
    targetDisplayName: string,
    sourceDisplayName: string,
    targetDiscordUserId: string | null,
    sourceDiscordUserId: string | null,
  ): string {
    const normalizedTarget = targetDisplayName.trim();
    const normalizedSource = sourceDisplayName.trim();
    if (!normalizedTarget) return normalizedSource;
    if (!normalizedSource) return normalizedTarget;

    if (
      targetDiscordUserId
      && normalizedTarget === targetDiscordUserId
      && normalizedSource !== (sourceDiscordUserId ?? '')
    ) {
      return normalizedSource;
    }

    if (this.looksLikeOpaqueIdentifier(normalizedTarget) && !this.looksLikeOpaqueIdentifier(normalizedSource)) {
      return normalizedSource;
    }

    return normalizedTarget;
  }

  private normalizeTrustLevel(value: string): TrustLevel {
    switch (value) {
      case 'primary':
      case 'trusted':
      case 'regular':
      case 'public':
        return value;
      default:
        return 'regular';
    }
  }

  private trustRank(level: TrustLevel): number {
    switch (level) {
      case 'primary':
        return 3;
      case 'trusted':
        return 2;
      case 'regular':
        return 1;
      case 'public':
      default:
        return 0;
    }
  }

  private pickMostTrustedLevel(first: string, second: string): TrustLevel {
    const firstTrust = this.normalizeTrustLevel(first);
    const secondTrust = this.normalizeTrustLevel(second);
    return this.trustRank(firstTrust) >= this.trustRank(secondTrust) ? firstTrust : secondTrust;
  }

  private compareIsoTimestamps(left: string, right: string): number {
    if (!left && !right) return 0;
    if (!left) return -1;
    if (!right) return 1;

    const leftEpoch = Date.parse(left);
    const rightEpoch = Date.parse(right);
    if (!Number.isNaN(leftEpoch) && !Number.isNaN(rightEpoch)) {
      if (leftEpoch === rightEpoch) return 0;
      return leftEpoch > rightEpoch ? 1 : -1;
    }

    return left.localeCompare(right);
  }

  private earliestTimestamp(left: string, right: string): string {
    if (!left) return right;
    if (!right) return left;
    return this.compareIsoTimestamps(left, right) <= 0 ? left : right;
  }

  private latestTimestamp(left: string, right: string): string {
    if (!left) return right;
    if (!right) return left;
    return this.compareIsoTimestamps(left, right) >= 0 ? left : right;
  }

  private mergeChannelIdentityRows(sourceContactId: string, targetContactId: string): void {
    const sourceRows = this.db.prepare(`
      SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
      FROM contact_channel_ids
      WHERE contact_id = ?
      ORDER BY channel ASC, channel_user_id ASC
    `).all(sourceContactId) as ContactIdentityRow[];
    if (sourceRows.length === 0) return;

    const getTargetRow = this.db.prepare(`
      SELECT contact_id, channel, channel_user_id, privacy_level, first_seen, last_seen
      FROM contact_channel_ids
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
      LIMIT 1
    `);
    const updateTargetRow = this.db.prepare(`
      UPDATE contact_channel_ids
      SET privacy_level = ?, first_seen = ?, last_seen = ?
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
    `);
    const moveIdentity = this.db.prepare(`
      UPDATE contact_channel_ids
      SET contact_id = ?
      WHERE contact_id = ? AND channel = ? AND channel_user_id = ?
    `);
    const deleteSourceIdentity = this.db.prepare(`
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

      const sourceIsNewer = this.compareIsoTimestamps(sourceRow.last_seen, targetRow.last_seen) > 0;
      const winner = sourceIsNewer ? sourceRow : targetRow;
      const mergedPrivacy = this.normalizePrivacyLevel(
        winner.privacy_level as ChannelPrivacyLevel | undefined,
        winner.channel,
      );
      const mergedFirstSeen = this.earliestTimestamp(sourceRow.first_seen, targetRow.first_seen);
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

  private mergeChannelActivityRows(sourceContactId: string, targetContactId: string): void {
    const sourceRows = this.db.prepare(`
      SELECT contact_id, channel, channel_id, first_seen, last_seen
      FROM contact_channel_activity
      WHERE contact_id = ?
      ORDER BY channel ASC, channel_id ASC
    `).all(sourceContactId) as ContactChannelActivityRow[];
    if (sourceRows.length === 0) return;

    const getTargetRow = this.db.prepare(`
      SELECT contact_id, channel, channel_id, first_seen, last_seen
      FROM contact_channel_activity
      WHERE contact_id = ? AND channel = ? AND channel_id = ?
      LIMIT 1
    `);
    const updateTargetRow = this.db.prepare(`
      UPDATE contact_channel_activity
      SET first_seen = ?, last_seen = ?
      WHERE contact_id = ? AND channel = ? AND channel_id = ?
    `);
    const moveActivity = this.db.prepare(`
      UPDATE contact_channel_activity
      SET contact_id = ?
      WHERE contact_id = ? AND channel = ? AND channel_id = ?
    `);
    const deleteSourceActivity = this.db.prepare(`
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
        this.earliestTimestamp(sourceRow.first_seen, targetRow.first_seen),
        this.latestTimestamp(sourceRow.last_seen, targetRow.last_seen),
        targetContactId,
        sourceRow.channel,
        sourceRow.channel_id,
      );
      deleteSourceActivity.run(sourceContactId, sourceRow.channel, sourceRow.channel_id);
    }
  }

  private promoteContactToPrimary(contactId: string): void {
    this.db.prepare(`
      UPDATE contacts
      SET trust_level = 'primary',
          relationship_type = 'partner'
      WHERE id = ?
    `).run(contactId);
  }

  private reconcilePrimaryContactDuplicates(canonicalContactId: string): string {
    const duplicates = this.db.prepare(`
      SELECT id
      FROM contacts
      WHERE id <> ? AND trust_level = 'primary'
      ORDER BY first_seen ASC
    `).all(canonicalContactId) as Array<{ id: string }>;

    for (const duplicate of duplicates) {
      this.mergeContacts(duplicate.id, canonicalContactId);
    }

    return canonicalContactId;
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
      const requestedNickname = this.normalizeNicknameValue(partial.nickname);
      const nickname = requestedNickname === undefined
        ? (existing.nickname ?? null)
        : requestedNickname;

      this.db.prepare(`
        UPDATE contacts SET
          discord_user_id = COALESCE(discord_user_id, ?),
          display_name = ?,
          nickname = ?,
          trust_level = ?,
          relationship_type = ?,
          emotional_baseline = ?,
          last_seen = ?,
          notes = ?
        WHERE id = ?
      `).run(
        legacyDiscordUserId ?? null,
        partial.displayName,
        nickname,
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
      nickname: this.normalizeNicknameValue(partial.nickname) ?? undefined,
      trustLevel: shouldForcePrimary ? 'primary' : (partial.trustLevel ?? 'regular'),
      relationshipType: shouldForcePrimary ? 'partner' : (partial.relationshipType ?? 'stranger'),
      emotionalBaseline: partial.emotionalBaseline ?? {},
      firstSeen: partial.firstSeen ?? now,
      lastSeen: partial.lastSeen ?? now,
      notes: partial.notes,
    };

    this.db.prepare(`
      INSERT INTO contacts (id, discord_user_id, display_name, trust_level, relationship_type,
        nickname, emotional_baseline, first_seen, last_seen, notes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      contact.id,
      contact.discordUserId ?? null,
      contact.displayName,
      contact.trustLevel,
      contact.relationshipType,
      contact.nickname ?? null,
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
  setTrustLevel(id: string, trustLevel: TrustLevel, actor?: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    if (contact.trustLevel === 'primary') {
      log.warn('Attempted to change primary user trust level', { id });
      return false;
    }

    if (contact.trustLevel === trustLevel) return true;

    this.db.prepare('UPDATE contacts SET trust_level = ? WHERE id = ?').run(trustLevel, id);
    this.appendMutationAuditEntry(id, 'trust_level', contact.trustLevel, trustLevel, actor);
    log.debug('Updated trust level', { id, trustLevel });
    return true;
  }

  /** Update a contact's last_seen timestamp to now. */
  updateLastSeen(id: string): void {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE contacts SET last_seen = ? WHERE id = ?').run(now, id);
    this.db.prepare('UPDATE contact_channel_ids SET last_seen = ? WHERE contact_id = ?').run(now, id);
    this.db.prepare('UPDATE contact_channel_activity SET last_seen = ? WHERE contact_id = ?').run(now, id);
  }

  /** Update contact display identity fields. */
  updateIdentityProfile(contactId: string, displayName: string, nickname?: string): boolean {
    const contact = this.getById(contactId);
    if (!contact) return false;

    const requestedNickname = this.normalizeNicknameValue(nickname);
    const normalizedNickname = requestedNickname === undefined
      ? (contact.nickname ?? null)
      : requestedNickname;

    const result = this.db.prepare(`
      UPDATE contacts
      SET display_name = ?, nickname = ?
      WHERE id = ?
    `).run(displayName.trim() || contact.displayName, normalizedNickname, contactId);

    return result.changes > 0;
  }

  /** Record that a contact was active in a conversation channel. */
  recordChannelActivity(contactId: string, channel: ContactChannel, channelId: string): void {
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return;

    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const now = new Date().toISOString();
    this.db.prepare(`
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

  mergeContacts(sourceContactId: string, targetContactId: string): boolean {
    if (sourceContactId === targetContactId) return true;

    const mergeTx = this.db.transaction((sourceId: string, targetId: string): boolean => {
      const sourceRow = this.db.prepare('SELECT * FROM contacts WHERE id = ?')
        .get(sourceId) as ContactRow | undefined;
      const targetRow = this.db.prepare('SELECT * FROM contacts WHERE id = ?')
        .get(targetId) as ContactRow | undefined;
      if (!sourceRow || !targetRow) return false;

      this.mergeChannelIdentityRows(sourceId, targetId);
      this.mergeChannelActivityRows(sourceId, targetId);

      if (this.hasTable('l2_memories') && this.hasColumn('l2_memories', 'contact_id')) {
        this.db.prepare('UPDATE l2_memories SET contact_id = ? WHERE contact_id = ?')
          .run(targetId, sourceId);
      }

      if (this.hasTable('contact_profiles') && this.hasColumn('contact_profiles', 'contact_id')) {
        const targetProfileExists = this.db.prepare(`
          SELECT 1 AS exists_flag
          FROM contact_profiles
          WHERE contact_id = ?
          LIMIT 1
        `).get(targetId) as { exists_flag: number } | undefined;

        if (targetProfileExists) {
          this.db.prepare('DELETE FROM contact_profiles WHERE contact_id = ?').run(sourceId);
        } else {
          this.db.prepare('UPDATE contact_profiles SET contact_id = ? WHERE contact_id = ?')
            .run(targetId, sourceId);
        }
      }

      const mergedTrustLevel = this.pickMostTrustedLevel(sourceRow.trust_level, targetRow.trust_level);
      const mergedRelationshipType = mergedTrustLevel === 'primary'
        ? 'partner'
        : (targetRow.relationship_type as RelationshipType);
      const mergedDisplayName = this.pickPreferredDisplayName(
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
      const mergedFirstSeen = this.earliestTimestamp(sourceRow.first_seen, targetRow.first_seen);
      const mergedLastSeen = this.latestTimestamp(sourceRow.last_seen, targetRow.last_seen);
      const mergedNotes = targetRow.notes ?? sourceRow.notes;

      this.db.prepare('DELETE FROM contacts WHERE id = ?').run(sourceId);
      this.db.prepare(`
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

  /** Update a contact's notes. Returns false if not found. */
  updateNotes(id: string, notes: string, actor?: string): boolean {
    const contact = this.getById(id);
    if (!contact) return false;

    const previousNotes = contact.notes ?? null;
    if (previousNotes === notes) return true;

    this.db.prepare('UPDATE contacts SET notes = ? WHERE id = ?').run(notes, id);
    this.appendMutationAuditEntry(id, 'notes', previousNotes, notes, actor);
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

  private markIdentityLinkVerification(
    verificationId: string,
    status: ContactIdentityLinkVerificationState,
    failureReason?: string,
    verifiedAt?: string,
  ): ContactIdentityLinkVerification | undefined {
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE contact_identity_link_verifications
      SET status = ?,
          updated_at = ?,
          verified_at = COALESCE(?, verified_at),
          failure_reason = ?
      WHERE id = ?
    `).run(
      status,
      now,
      verifiedAt ?? null,
      failureReason ?? null,
      verificationId,
    );

    const row = this.db.prepare(`
      SELECT *
      FROM contact_identity_link_verifications
      WHERE id = ?
      LIMIT 1
    `).get(verificationId) as ContactIdentityVerificationRow | undefined;
    return row ? this.toIdentityLinkVerification(row) : undefined;
  }

  createIdentityLinkChallenge(
    input: ContactIdentityLinkChallengeInput,
  ): ContactIdentityLinkChallengeResult {
    const contact = this.getById(input.contactId);
    if (!contact) return { status: 'contact_not_found' };

    const sourceIdentity = this.normalizeIdentity(input.sourceChannel, input.sourceUserId);
    const targetIdentity = this.normalizeIdentity(input.targetChannel, input.targetUserId);
    const sourceOwner = this.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
    if (!sourceOwner || sourceOwner.id !== contact.id) {
      return { status: 'source_identity_not_linked' };
    }

    const targetOwner = this.getByChannelIdentity(targetIdentity.channel, targetIdentity.userId);
    if (targetOwner && targetOwner.id !== contact.id) {
      return { status: 'identity_conflict' };
    }
    if (targetOwner && targetOwner.id === contact.id) {
      return { status: 'already_linked' };
    }

    const existingPending = this.db.prepare(`
      SELECT *
      FROM contact_identity_link_verifications
      WHERE contact_id = ?
        AND source_channel = ?
        AND source_user_id = ?
        AND target_channel = ?
        AND target_user_id = ?
        AND status = 'pending'
      ORDER BY created_at DESC
      LIMIT 1
    `).get(
      contact.id,
      sourceIdentity.channel,
      sourceIdentity.userId,
      targetIdentity.channel,
      targetIdentity.userId,
    ) as ContactIdentityVerificationRow | undefined;

    if (existingPending) {
      const expiresAtMs = Date.parse(existingPending.expires_at);
      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        return {
          status: 'pending_exists',
          verification: this.toIdentityLinkVerification(existingPending),
        };
      }
      this.markIdentityLinkVerification(existingPending.id, 'expired', 'expired');
    }

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(
      now.getTime() + this.normalizeVerificationTtlMs(input.ttlMs),
    ).toISOString();
    const verification: ContactIdentityLinkVerification = {
      id: uuidv4(),
      contactId: contact.id,
      sourceChannel: sourceIdentity.channel,
      sourceUserId: sourceIdentity.userId,
      targetChannel: targetIdentity.channel,
      targetUserId: targetIdentity.userId,
      nonce: this.createVerificationToken(),
      expiresAt,
      signature: this.createVerificationToken(),
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    };

    this.db.prepare(`
      INSERT INTO contact_identity_link_verifications (
        id,
        contact_id,
        source_channel,
        source_user_id,
        target_channel,
        target_user_id,
        nonce,
        expires_at,
        signature,
        status,
        created_at,
        updated_at,
        verified_at,
        failure_reason
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      verification.id,
      verification.contactId,
      verification.sourceChannel,
      verification.sourceUserId,
      verification.targetChannel,
      verification.targetUserId,
      verification.nonce,
      verification.expiresAt,
      verification.signature,
      verification.status,
      verification.createdAt,
      verification.updatedAt,
      null,
      null,
    );

    return { status: 'challenge_created', verification };
  }

  verifyIdentityLinkChallenge(
    input: ContactIdentityLinkVerificationInput,
  ): ContactIdentityLinkVerificationResult {
    const contact = this.getById(input.contactId);
    if (!contact) return { status: 'contact_not_found' };

    const sourceIdentity = this.normalizeIdentity(input.sourceChannel, input.sourceUserId);
    const targetIdentity = this.normalizeIdentity(input.targetChannel, input.targetUserId);

    const row = this.db.prepare(`
      SELECT *
      FROM contact_identity_link_verifications
      WHERE contact_id = ?
        AND source_channel = ?
        AND source_user_id = ?
        AND target_channel = ?
        AND target_user_id = ?
        AND nonce = ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(
      input.contactId,
      sourceIdentity.channel,
      sourceIdentity.userId,
      targetIdentity.channel,
      targetIdentity.userId,
      input.nonce.trim(),
    ) as ContactIdentityVerificationRow | undefined;

    if (!row) {
      return { status: 'verification_not_found' };
    }

    const mappedRow = this.toIdentityLinkVerification(row);
    if (mappedRow.status !== 'pending') {
      return { status: 'verification_replayed', verification: mappedRow };
    }

    if (row.expires_at !== input.expiresAt.trim()) {
      const failed = this.markIdentityLinkVerification(row.id, 'failed', 'claim_mismatch')
        ?? mappedRow;
      return { status: 'claim_mismatch', verification: failed };
    }

    const now = Date.now();
    const expiresAtMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAtMs) || now > expiresAtMs) {
      const expired = this.markIdentityLinkVerification(row.id, 'expired', 'expired')
        ?? mappedRow;
      return { status: 'verification_expired', verification: expired };
    }

    if (row.signature !== input.signature.trim()) {
      const failed = this.markIdentityLinkVerification(row.id, 'failed', 'invalid_signature')
        ?? mappedRow;
      return { status: 'invalid_signature', verification: failed };
    }

    const sourceOwner = this.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
    if (!sourceOwner || sourceOwner.id !== input.contactId) {
      const failed = this.markIdentityLinkVerification(row.id, 'failed', 'source_identity_not_linked')
        ?? mappedRow;
      return { status: 'source_identity_not_linked', verification: failed };
    }

    const linkResult = this.linkChannelIdentity(
      input.contactId,
      targetIdentity.channel,
      targetIdentity.userId,
      { privacyLevel: input.privacyLevel },
    );

    if (linkResult === 'identity_conflict') {
      const failed = this.markIdentityLinkVerification(row.id, 'failed', 'identity_conflict')
        ?? mappedRow;
      return { status: 'identity_conflict', verification: failed };
    }

    if (linkResult === 'contact_not_found') {
      return { status: 'contact_not_found' };
    }

    const verified = this.markIdentityLinkVerification(
      row.id,
      'verified',
      undefined,
      new Date(now).toISOString(),
    ) ?? mappedRow;

    return { status: linkResult, verification: verified };
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

    if (result !== 'identity_conflict' && this.isPrimaryIdentity(identity)) {
      this.promoteContactToPrimary(contactId);
      this.reconcilePrimaryContactDuplicates(contactId);
    }

    return result;
  }

  /** List all contacts. */
  listAll(): Contact[] {
    const rows = this.db.prepare('SELECT * FROM contacts ORDER BY last_seen DESC').all() as ContactRow[];
    return rows.map(row => this.hydrateContact(row));
  }

  listIdentityLinkVerifications(limit = 25): ContactIdentityLinkVerification[] {
    const normalizedLimit = Number.isFinite(limit)
      ? Math.max(1, Math.min(Math.floor(limit), 200))
      : 25;

    const rows = this.db.prepare(`
      SELECT *
      FROM contact_identity_link_verifications
      ORDER BY created_at DESC
      LIMIT ?
    `).all(normalizedLimit) as ContactIdentityVerificationRow[];

    return rows.map(row => this.toIdentityLinkVerification(row));
  }

  listMutationAuditEntries(query: ContactMutationAuditQuery = {}): ContactMutationAuditEntry[] {
    const normalizedLimit = Number.isFinite(query.limit)
      ? Math.max(1, Math.min(Math.floor(query.limit ?? 25), 200))
      : 25;
    const contactId = query.contactId?.trim();
    const actor = query.actor?.trim();

    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (contactId) {
      clauses.push('contact_id = ?');
      params.push(contactId);
    }

    if (actor) {
      clauses.push('actor = ?');
      params.push(actor);
    }

    if (query.field) {
      clauses.push('field = ?');
      params.push(query.field);
    }

    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT id, contact_id, actor, field, old_value, new_value, timestamp
      FROM contact_mutation_audit
      ${whereClause}
      ORDER BY timestamp DESC, id DESC
      LIMIT ?
    `).all(...params, normalizedLimit) as ContactMutationAuditRow[];

    return rows.flatMap((row) => {
      const mapped = this.toMutationAuditEntry(row);
      return mapped ? [mapped] : [];
    });
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
      const now = new Date().toISOString();
      this.updateLastSeen(existing.id);
      this.upsertIdentityLink(existing.id, identity, existing.firstSeen, now);
      if (identity.channel === LEGACY_DISCORD_CHANNEL) {
        this.ensureLegacyDiscordUserId(existing.id, identity.userId);
      }

      let canonicalContactId = existing.id;
      if (this.isPrimaryIdentity(identity)) {
        this.promoteContactToPrimary(canonicalContactId);
        canonicalContactId = this.reconcilePrimaryContactDuplicates(canonicalContactId);
      }

      const candidateDisplayName = displayName?.trim();
      if (
        candidateDisplayName
        && candidateDisplayName !== existing.displayName
        && this.looksLikeOpaqueIdentifier(existing.displayName)
      ) {
        this.db.prepare('UPDATE contacts SET display_name = ? WHERE id = ?')
          .run(candidateDisplayName, canonicalContactId);
      }

      return this.getById(canonicalContactId)!;
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
