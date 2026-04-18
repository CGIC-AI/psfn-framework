import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  POSTGRES_CONTACT_MIGRATIONS,
} from '../../persistence/postgres/migrations.js';
import type {
  ChannelPrivacyLevel,
  Contact,
  ContactChannel,
  ContactIdentityLinkChallengeInput,
  ContactIdentityLinkChallengeResult,
  ContactIdentityLinkOptions,
  ContactIdentityLinkResult,
  ContactIdentityLinkVerification,
  ContactIdentityLinkVerificationInput,
  ContactIdentityLinkVerificationResult,
  ContactMutationAuditEntry,
  ContactMutationAuditQuery,
  RelationshipType,
  SocialGraphEntity,
  SocialGraphEntityQuery,
  SocialGraphEntityUpsertInput,
  SocialRelationshipEdge,
  SocialRelationshipEdgeQuery,
  SocialRelationshipEdgeUpsertInput,
} from './types.js';
import type { TrustLevel, LowTierTrustLevel } from '../../system/trust/types.js';
import {
  evaluateLowTierTrustDriftSuggestion,
  getAllowedSensitivities,
  isManualHighTierTrustMutationAuthorized,
  resolveTrustMutationSource,
  type TrustDriftBehaviorSignals,
} from '../../system/trust/policy.js';
import {
  isHighTierTrustLevel,
  isLowTierTrustLevel,
  type ChannelVisibility,
  type SensitivityLevel,
  SENSITIVITY_LEVELS,
  sensitivityOrd,
} from '../../system/trust/types.js';
import type { EmotionalSnapshot, EmotionalTimeSeriesPoint } from './store/emotional-baseline.js';
import {
  appendEmotionalObservationToTimeSeries,
  computeUpdatedEmotionalBaseline,
  hasLearnedMoodSnapshot,
  mergeEmotionalTimeSeries,
  normalizeEmotionalTimeSeries,
  parseMoodSnapshot,
} from './store/emotional-baseline.js';
import type {
  ContactStorePort,
  ContactTrustDriftApplyResult,
  ContactTrustDriftSuggestion,
  ContactTrustMutationOptions,
  ContactUpsertMutationOptions,
} from './contact-store-port.js';
import {
  defaultPrivacyForChannel,
  earliestTimestamp,
  isPrimaryIdentity,
  looksLikeOpaqueIdentifier,
  latestTimestamp,
  normalizeIdentity,
  normalizeNicknameValue,
  normalizePrivacyLevel,
  pickMostTrustedLevel,
  pickPreferredDisplayName,
} from './store/identity-utils.js';
import { collectUpsertIdentities } from './store/upsert.js';
import { CONTACT_MUTATION_AUDIT_FIELDS } from './types.js';

export interface ContactRow {
  id: string;
  discord_user_id: string | null;
  display_name: string;
  nickname: string | null;
  trust_level: string;
  relationship_type: string;
  emotional_baseline: unknown;
  emotional_time_series?: unknown;
  first_seen: string;
  last_seen: string;
  notes: string | null;
}

export interface ContactIdentityRow {
  contact_id: string;
  channel: string;
  channel_user_id: string;
  privacy_level: string | null;
  first_seen: string;
  last_seen: string;
}

export interface ContactChannelActivityRow {
  contact_id: string;
  channel: string;
  channel_id: string;
  privacy_level: string | null;
  first_seen: string;
  last_seen: string;
}

export interface ContactIdentityVerificationRow {
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

export interface ContactMutationAuditRow {
  id: number;
  contact_id: string;
  actor: string;
  field: string;
  old_value: string | null;
  new_value: string | null;
  timestamp: string;
}

export interface SocialGraphEntityRow {
  id: string;
  entity_kind: string;
  display_name: string;
  contact_id: string | null;
  sensitivity: string;
  provenance_refs: unknown;
  confidence: number;
  source: string;
  created_at: string;
  updated_at: string;
}

export interface SocialRelationshipEdgeRow {
  id: string;
  source_entity_id: string;
  target_entity_id: string;
  relationship_type: string;
  directional: boolean;
  sensitivity: string;
  provenance_refs: unknown;
  evidence_memory_ids: unknown;
  confidence: number;
  created_at: string;
  updated_at: string;
}

export interface PostgresContactStoreOptions {
  pool?: Pool;
  applicationName?: string;
  exportDir?: string;
}

function normalizeTrimmed(value: string | undefined): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => (typeof entry === 'string' ? [entry] : []));
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return normalizeJsonArray(parsed);
    } catch {
      return [];
    }
  }
  return [];
}

function normalizeJsonObject(value: unknown): Record<string, number> {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const out: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value)) {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        out[key] = raw;
      }
    }
    return out;
  }
  if (typeof value === 'string') {
    try {
      return normalizeJsonObject(JSON.parse(value));
    } catch {
      return {};
    }
  }
  return {};
}

function normalizeTrustLevel(value: string): TrustLevel {
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

function normalizeRelationshipType(value: string): RelationshipType {
  switch (value) {
    case 'partner':
    case 'family':
    case 'friend':
    case 'acquaintance':
    case 'stranger':
    case 'ai_companion':
      return value;
    default:
      return 'stranger';
  }
}

function normalizeSocialEntityKind(value: string): SocialGraphEntity['entityKind'] {
  return value.trim().toLowerCase() === 'person' ? 'person' : 'person';
}

function normalizeSocialEntitySource(value: string): SocialGraphEntity['source'] {
  switch (value) {
    case 'contact':
    case 'memory':
    case 'manual':
    case 'system':
      return value;
    default:
      return 'manual';
  }
}

function normalizeSocialRelationshipKind(value: string): SocialRelationshipEdge['relationshipType'] {
  const allowed = [
    'partner',
    'family',
    'friend',
    'acquaintance',
    'colleague',
    'parent',
    'child',
    'sibling',
    'caregiver',
    'household',
    'manager',
    'direct_report',
    'other',
  ] as const;
  return allowed.includes(value as typeof allowed[number]) ? value as SocialRelationshipEdge['relationshipType'] : 'other';
}

function normalizeSensitivity(value: string): SensitivityLevel {
  const normalized = value.trim().toLowerCase() as SensitivityLevel;
  return SENSITIVITY_LEVELS.includes(normalized) ? normalized : 'personal';
}

function normalizeViewerTrustLevel(value: TrustLevel | undefined): TrustLevel {
  return value ?? 'public';
}

function normalizeViewerVisibility(value: ChannelVisibility | undefined): ChannelVisibility {
  return value ?? 'public';
}

function chooseMoreRestrictiveSensitivity(left: SensitivityLevel, right: SensitivityLevel): SensitivityLevel {
  return sensitivityOrd(left) >= sensitivityOrd(right) ? left : right;
}

function edgeVisible(
  edgeSensitivity: SensitivityLevel,
  sourceSensitivity: SensitivityLevel,
  targetSensitivity: SensitivityLevel,
  query: SocialRelationshipEdgeQuery,
): boolean {
  const allowed = getAllowedSensitivities(
    normalizeViewerTrustLevel(query.viewerTrustLevel),
    normalizeViewerVisibility(query.viewerChannelVisibility),
  );
  return allowed.includes(edgeSensitivity)
    && allowed.includes(sourceSensitivity)
    && allowed.includes(targetSensitivity);
}

function normalizeLimit(limit: number | undefined, fallback: number, min: number, max: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(limit)));
}

function normalizeAuditActor(actor: string | undefined): string {
  const trimmed = actor?.trim();
  if (!trimmed) return 'system:unknown';
  return trimmed.slice(0, 120);
}

function rowToContact(row: ContactRow, identities: ContactIdentityRow[], conversationChannels: ContactChannelActivityRow[]): Contact {
  const emotionalBaseline = normalizeJsonObject(row.emotional_baseline);
  const contact: Contact = {
    id: row.id,
    ...(row.discord_user_id ? { discordUserId: row.discord_user_id } : {}),
    displayName: row.display_name,
    ...(row.nickname ? { nickname: row.nickname } : {}),
    trustLevel: normalizeTrustLevel(row.trust_level),
    relationshipType: normalizeRelationshipType(row.relationship_type),
    emotionalBaseline,
    firstSeen: row.first_seen,
    lastSeen: row.last_seen,
    ...(row.notes ? { notes: row.notes } : {}),
  };

  if (identities.length > 0) {
    contact.channels = identities.map(identity => ({
      channel: identity.channel,
      userId: identity.channel_user_id,
      privacyLevel: normalizePrivacyLevel(identity.privacy_level as ChannelPrivacyLevel | undefined, identity.channel),
      firstSeen: identity.first_seen,
      lastSeen: identity.last_seen,
    }));
    contact.channelIdentities = contact.channels.map(identity => ({
      channel: identity.channel,
      userId: identity.userId,
    }));
  }

  if (row.discord_user_id && !contact.channels?.some(identity => identity.channel === 'discord' && identity.userId === row.discord_user_id)) {
    const discordIdentity = {
      channel: 'discord',
      userId: row.discord_user_id,
      privacyLevel: defaultPrivacyForChannel('discord'),
      firstSeen: row.first_seen,
      lastSeen: row.last_seen,
    };
    contact.channels = [discordIdentity, ...(contact.channels ?? [])];
    contact.channelIdentities = [discordIdentity, ...(contact.channelIdentities ?? [])].map(identity => ({
      channel: identity.channel,
      userId: identity.userId,
    }));
  }

  if (conversationChannels.length > 0) {
    contact.conversationChannels = conversationChannels.map(channel => ({
      channel: channel.channel,
      channelId: channel.channel_id,
      firstSeen: channel.first_seen,
      lastSeen: channel.last_seen,
      ...(channel.privacy_level ? { privacyLevel: normalizePrivacyLevel(channel.privacy_level as ChannelPrivacyLevel, channel.channel) } : {}),
    }));
  }

  return contact;
}

function contactMutationAuditRowToEntry(row: ContactMutationAuditRow): ContactMutationAuditEntry | undefined {
  if (!(CONTACT_MUTATION_AUDIT_FIELDS as readonly string[]).includes(row.field)) {
    return undefined;
  }

  return {
    id: row.id,
    contactId: row.contact_id,
    actor: row.actor,
    field: row.field as ContactMutationAuditEntry['field'],
    oldValue: row.old_value,
    newValue: row.new_value,
    timestamp: row.timestamp,
  };
}

function socialGraphEntityRowToEntity(row: SocialGraphEntityRow): SocialGraphEntity {
  return {
    id: row.id,
    entityKind: normalizeSocialEntityKind(row.entity_kind),
    displayName: row.display_name,
    ...(row.contact_id ? { contactId: row.contact_id } : {}),
    sensitivity: normalizeSensitivity(row.sensitivity),
    provenanceRefs: normalizeJsonArray(row.provenance_refs),
    confidence: Number.isFinite(row.confidence) ? row.confidence : 1,
    source: normalizeSocialEntitySource(row.source),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function socialGraphEdgeRowToEdge(row: SocialRelationshipEdgeRow): SocialRelationshipEdge {
  return {
    id: row.id,
    sourceEntityId: row.source_entity_id,
    targetEntityId: row.target_entity_id,
    relationshipType: normalizeSocialRelationshipKind(row.relationship_type),
    directional: Boolean(row.directional),
    sensitivity: normalizeSensitivity(row.sensitivity),
    provenanceRefs: normalizeJsonArray(row.provenance_refs),
    evidenceMemoryIds: normalizeJsonArray(row.evidence_memory_ids),
    confidence: Number.isFinite(row.confidence) ? row.confidence : 0.7,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function withPostgresClient<T>(
  pool: Pool,
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // best effort rollback
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ensureSchema(pool: Pool, statements: readonly string[]): Promise<void> {
  await withPostgresClient(pool, async (client) => {
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

async function queryRows<T>(pool: Pool, text: string, values: readonly unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, values);
  return result.rows as T[];
}

async function queryOne<T>(pool: Pool, text: string, values: readonly unknown[] = []): Promise<T | undefined> {
  const rows = await queryRows<T>(pool, text, values);
  return rows[0];
}

export async function createPostgresContactStore(
  databaseUrl: string,
  primaryUserId?: string,
  options: PostgresContactStoreOptions = {},
): Promise<ContactStorePort> {
  const pool = options.pool ?? new Pool({
    connectionString: databaseUrl,
    application_name: options.applicationName ?? 'psfn-contacts',
    allowExitOnIdle: true,
  });
  await ensureSchema(pool, POSTGRES_CONTACT_MIGRATIONS);
  return new PostgresContactStore(pool, primaryUserId, options.exportDir);
}

class PostgresContactStore implements ContactStorePort {
  private readonly pool: Pool;
  private readonly primaryUserId?: string;
  private readonly exportDir: string | null;

  constructor(pool: Pool, primaryUserId?: string, exportDir?: string) {
    this.pool = pool;
    this.primaryUserId = normalizeTrimmed(primaryUserId);
    this.exportDir = normalizeTrimmed(exportDir);
  }

  private async tableExists(tableName: string): Promise<boolean> {
    const row = await queryOne<{ exists: boolean }>(
      this.pool,
      'SELECT to_regclass($1) IS NOT NULL AS exists',
      [tableName],
    );
    return Boolean(row?.exists);
  }

  private async loadContactRow(id: string): Promise<ContactRow | undefined> {
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
  }

  private async loadContactEmotionalTimeSeries(
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
  }

  private async loadContactByChannelIdentity(channel: ContactChannel, channelUserId: string): Promise<Contact | undefined> {
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
  }

  private async loadContactByRow(row: ContactRow): Promise<Contact> {
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
  }

  private async touchContactLastSeen(id: string): Promise<void> {
    const now = new Date().toISOString();
    await this.pool.query('UPDATE contacts SET last_seen = $1 WHERE id = $2', [now, id]);
    await this.pool.query('UPDATE contact_channel_ids SET last_seen = $1 WHERE contact_id = $2', [now, id]);
    await this.pool.query('UPDATE contact_channel_activity SET last_seen = $1 WHERE contact_id = $2', [now, id]);
  }

  private async appendMutationAuditEntry(
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
  }

  private async upsertIdentityLinkRecord(
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
  }

  private async upsertSocialGraphEntityForContact(contact: Pick<Contact, 'id' | 'displayName' | 'firstSeen' | 'lastSeen'>): Promise<SocialGraphEntity> {
    return await this.upsertSocialGraphEntity({
      id: `contact:${contact.id}`,
      displayName: contact.displayName,
      contactId: contact.id,
      source: 'contact',
      confidence: 1,
    });
  }

  private async loadSocialGraphEntityByRow(row: SocialGraphEntityRow | undefined): Promise<SocialGraphEntity | undefined> {
    return row ? socialGraphEntityRowToEntity(row) : undefined;
  }

  private async loadSocialGraphEntityById(entityId: string): Promise<SocialGraphEntity | undefined> {
    const row = await queryOne<SocialGraphEntityRow>(
      this.pool,
      `
        SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
               confidence, source, created_at, updated_at
        FROM social_graph_entities
        WHERE id = $1
        LIMIT 1
      `,
      [entityId],
    );
    return await this.loadSocialGraphEntityByRow(row);
  }

  private async loadSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined> {
    const row = await queryOne<SocialGraphEntityRow>(
      this.pool,
      `
        SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
               confidence, source, created_at, updated_at
        FROM social_graph_entities
        WHERE contact_id = $1
        LIMIT 1
      `,
      [contactId],
    );
    return await this.loadSocialGraphEntityByRow(row);
  }

  private async loadSocialRelationshipEdgeRows(
    query: SocialRelationshipEdgeQuery = {},
  ): Promise<Array<SocialRelationshipEdgeRow & { source_sensitivity: string; target_sensitivity: string }>> {
    const limit = normalizeLimit(query.limit, 200, 1, 200);
    let entityId = normalizeTrimmed(query.entityId);
    if (!entityId && query.contactId) {
      entityId = (await this.loadSocialGraphEntityByContactId(query.contactId))?.id;
    }
    if (query.contactId && !entityId) return [];

    const params: unknown[] = [];
    const clauses: string[] = [];
    if (entityId) {
      clauses.push('(e.source_entity_id = $1 OR e.target_entity_id = $1)');
      params.push(entityId);
    }
    if (query.relationshipType) {
      clauses.push(`e.relationship_type = $${params.length + 1}`);
      params.push(query.relationshipType);
    }
    if (Number.isFinite(query.minConfidence)) {
      clauses.push(`e.confidence >= $${params.length + 1}`);
      params.push(query.minConfidence);
    }

    const sql = `
      SELECT
        e.id,
        e.source_entity_id,
        e.target_entity_id,
        e.relationship_type,
        e.directional,
        e.sensitivity,
        e.provenance_refs,
        e.evidence_memory_ids,
        e.confidence,
        e.created_at,
        e.updated_at,
        source.sensitivity AS source_sensitivity,
        target.sensitivity AS target_sensitivity
      FROM social_relationship_edges e
      INNER JOIN social_graph_entities source ON source.id = e.source_entity_id
      INNER JOIN social_graph_entities target ON target.id = e.target_entity_id
      ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
      ORDER BY e.updated_at DESC, e.created_at DESC
      LIMIT $${params.length + 1}
    `;
    return await queryRows<SocialRelationshipEdgeRow & { source_sensitivity: string; target_sensitivity: string }>(
      this.pool,
      sql,
      [...params, limit],
    );
  }

  private async loadRelatedContactIds(contactId: string, query: SocialRelationshipEdgeQuery = {}): Promise<string[]> {
    const entity = await this.loadSocialGraphEntityByContactId(contactId);
    if (!entity) return [];
    const rows = await this.loadSocialRelationshipEdgeRows({
      ...query,
      entityId: entity.id,
    });
    const related = new Set<string>();
    for (const row of rows) {
      const edge = socialGraphEdgeRowToEdge(row);
      const otherEntityId = edge.sourceEntityId === entity.id ? edge.targetEntityId : edge.sourceEntityId;
      const otherEntity = await this.loadSocialGraphEntityById(otherEntityId);
      if (otherEntity?.contactId) {
        related.add(otherEntity.contactId);
      }
    }
    return [...related];
  }

  private async syncContactExports(): Promise<void> {
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
  }

  async upsert(
    partial: Partial<Contact> & { displayName: string },
    options: ContactUpsertMutationOptions = {},
  ): Promise<Contact> {
    const identities = collectUpsertIdentities(partial);
    let target = partial.id ? await this.getById(partial.id) : undefined;
    if (!target && partial.discordUserId) {
      target = await this.getByDiscordUserId(partial.discordUserId);
    }
    if (!target) {
      for (const identity of identities) {
        target = await this.getByChannelIdentity(identity.channel, identity.userId);
        if (target) break;
      }
    }

    const mutationSource = resolveTrustMutationSource(options.actor, options.mutationSource);

    if (
      partial.trustLevel !== undefined
      && isHighTierTrustLevel(partial.trustLevel)
      && !isManualHighTierTrustMutationAuthorized(options.actor, mutationSource)
    ) {
      throw new Error('High-tier trust assignment denied: manual operator authorization required');
    }

    if (
      partial.trustLevel === 'primary'
      && !this.isPrimaryTrustAssignmentAuthorized(target, identities, partial.discordUserId, options)
    ) {
      await this.appendPrimaryTrustAudit(target?.id, target?.trustLevel ?? null, 'upsert', 'denied', options.actor, {
        requestedTrustLevel: partial.trustLevel,
        hasConfiguredPrimaryUserId: Boolean(this.primaryUserId?.trim()),
      });
      throw new Error('Primary trust assignment denied: identity does not match configured owner mapping');
    }

    const now = new Date().toISOString();
    if (target) {
      const previousTrustLevel = target.trustLevel;
      const nextDisplayName = partial.displayName.trim() || target.displayName;
      const requestedNickname = normalizeNicknameValue(partial.nickname);
      const nextNickname = requestedNickname === undefined ? (target.nickname ?? undefined) : requestedNickname;
      const nextTrustLevel = partial.trustLevel ?? target.trustLevel;
      const nextRelationshipType = nextTrustLevel === 'primary'
        ? 'partner'
        : (partial.relationshipType ?? target.relationshipType);
      const nextEmotion = partial.emotionalBaseline ?? target.emotionalBaseline ?? {};
      const nextDiscordUserId = partial.discordUserId ?? target.discordUserId ?? undefined;
      await this.pool.query(
        `
          UPDATE contacts
          SET discord_user_id = COALESCE(discord_user_id, $1),
              display_name = $2,
              nickname = $3,
              trust_level = $4,
              relationship_type = $5,
              emotional_baseline = $6,
              last_seen = $7,
              notes = COALESCE($8, notes)
          WHERE id = $9
        `,
        [
          nextDiscordUserId ?? null,
          nextDisplayName,
          nextNickname ?? null,
          nextTrustLevel,
          nextRelationshipType,
          nextEmotion,
          now,
          partial.notes ?? null,
          target.id,
        ],
      );

      for (const identity of identities) {
        await this.upsertIdentityLinkRecord(
          target.id,
          identity.channel,
          identity.userId,
          target.firstSeen,
          now,
          identity.privacyLevel,
        );
      }

      if (nextTrustLevel === 'primary' && previousTrustLevel !== 'primary') {
        await this.appendPrimaryTrustAudit(target.id, previousTrustLevel, 'upsert', 'allowed', options.actor);
      } else if (previousTrustLevel !== nextTrustLevel) {
        await this.appendMutationAuditEntry(target.id, 'trust_level', previousTrustLevel, nextTrustLevel, options.actor);
      }
      if (target.displayName !== nextDisplayName) {
        await this.appendMutationAuditEntry(target.id, 'display_name', target.displayName, nextDisplayName, options.actor);
      }
      if ((target.nickname ?? null) !== (nextNickname ?? null)) {
        await this.appendMutationAuditEntry(target.id, 'nickname', target.nickname ?? null, nextNickname ?? null, options.actor);
      }
      if ((target.notes ?? null) !== (partial.notes ?? target.notes ?? null) && partial.notes !== undefined) {
        await this.appendMutationAuditEntry(target.id, 'notes', target.notes ?? null, partial.notes ?? null, options.actor);
      }

      const hydrated = await this.loadContactById(target.id);
      if (!hydrated) {
        throw new Error(`Failed to reload updated contact ${target.id}`);
      }
      await this.upsertSocialGraphEntityForContact({
        id: hydrated.id,
        displayName: hydrated.displayName,
        firstSeen: hydrated.firstSeen,
        lastSeen: hydrated.lastSeen,
      });
      await this.syncContactExports();
      return hydrated;
    }

    const legacyDiscordUserId = partial.discordUserId?.trim() || undefined;
    const shouldForcePrimary = identities.some(identity => isPrimaryIdentity(identity, this.primaryUserId))
      || (legacyDiscordUserId ? isPrimaryIdentity({ channel: 'discord', userId: legacyDiscordUserId }, this.primaryUserId) : false);
    const contact: Contact = {
      id: partial.id?.trim() || uuidv4(),
      ...(legacyDiscordUserId ? { discordUserId: legacyDiscordUserId } : {}),
      displayName: partial.displayName.trim(),
      ...(normalizeNicknameValue(partial.nickname) !== undefined ? { nickname: normalizeNicknameValue(partial.nickname) ?? undefined } : {}),
      trustLevel: shouldForcePrimary ? 'primary' : (partial.trustLevel ?? 'regular'),
      relationshipType: shouldForcePrimary ? 'partner' : (partial.relationshipType ?? 'stranger'),
      emotionalBaseline: partial.emotionalBaseline ?? {},
      firstSeen: partial.firstSeen ?? now,
      lastSeen: partial.lastSeen ?? now,
      ...(partial.notes ? { notes: partial.notes } : {}),
    };

    await this.pool.query(
      `
        INSERT INTO contacts (
          id,
          discord_user_id,
          display_name,
          nickname,
          trust_level,
          relationship_type,
          emotional_baseline,
          first_seen,
          last_seen,
          notes
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [
        contact.id,
        contact.discordUserId ?? null,
        contact.displayName,
        contact.nickname ?? null,
        contact.trustLevel,
        contact.relationshipType,
        contact.emotionalBaseline ?? {},
        contact.firstSeen,
        contact.lastSeen,
        contact.notes ?? null,
      ],
    );

    for (const identity of identities) {
      await this.upsertIdentityLinkRecord(
        contact.id,
        identity.channel,
        identity.userId,
        contact.firstSeen,
        contact.lastSeen,
        identity.privacyLevel,
      );
    }

    if (contact.trustLevel === 'primary') {
      await this.appendPrimaryTrustAudit(contact.id, null, 'upsert', 'allowed', options.actor);
    }
    await this.upsertSocialGraphEntityForContact(contact);
    await this.syncContactExports();
    return contact;
  }

  private async appendPrimaryTrustAudit(
    contactId: string | undefined,
    previousTrustLevel: TrustLevel | null,
    source: 'upsert' | 'set_trust_level',
    outcome: 'allowed' | 'denied',
    actor?: string,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const baseActor = actor?.trim() || `system:contact_store:${source}`;
    const auditActor = `${baseActor}:primary_${outcome}`;
    if (contactId) {
      await this.appendMutationAuditEntry(contactId, 'trust_level', previousTrustLevel, 'primary', auditActor);
    }
    if (outcome === 'denied') {
      console.warn('Denied primary trust mutation', {
        contactId,
        previousTrustLevel,
        actor: baseActor,
        source,
        ...(details ?? {}),
      });
    }
  }

  private isPrimaryTrustAssignmentAuthorized(
    contact: Contact | undefined,
    identities: ReturnType<typeof collectUpsertIdentities>,
    discordUserId: string | undefined,
    options: ContactTrustMutationOptions = {},
  ): boolean {
    if (options.allowPrimaryTrustAssignment === true) return true;
    if (!this.primaryUserId) return false;
    if (contact?.discordUserId?.trim() === this.primaryUserId) return true;
    if (discordUserId?.trim() === this.primaryUserId) return true;
    const candidates = [
      ...identities,
      ...(Array.isArray(contact?.channelIdentities) ? contact.channelIdentities : []),
      ...(contact?.discordUserId ? [{ channel: 'discord', userId: contact.discordUserId }] : []),
      ...(discordUserId ? [{ channel: 'discord', userId: discordUserId }] : []),
    ];
    return candidates.some(identity => isPrimaryIdentity(identity, this.primaryUserId));
  }

  async getById(id: string): Promise<Contact | undefined> {
    const row = await this.loadContactRow(id);
    if (!row) return undefined;
    return await this.loadContactByRow(row);
  }

  async getByDiscordUserId(discordUserId: string): Promise<Contact | undefined> {
    const trimmed = discordUserId.trim();
    if (!trimmed) return undefined;
    const row = await queryOne<ContactRow>(
      this.pool,
      `
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type,
               emotional_baseline, first_seen, last_seen, notes
        FROM contacts
        WHERE discord_user_id = $1
        LIMIT 1
      `,
      [trimmed],
    );
    if (row) return await this.loadContactByRow(row);
    return await this.loadContactByChannelIdentity('discord', trimmed);
  }

  async getByChannelIdentity(channel: ContactChannel, channelUserId: string): Promise<Contact | undefined> {
    return await this.loadContactByChannelIdentity(channel, channelUserId);
  }

  async getByTrustLevel(trustLevel: TrustLevel): Promise<Contact[]> {
    const rows = await queryRows<ContactRow>(
      this.pool,
      `
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type,
               emotional_baseline, first_seen, last_seen, notes
        FROM contacts
        WHERE trust_level = $1
        ORDER BY last_seen DESC
      `,
      [trustLevel],
    );
    const contacts: Contact[] = [];
    for (const row of rows) {
      const contact = await this.loadContactByRow(row);
      contacts.push(contact);
    }
    return contacts;
  }

  async getSocialGraphEntityById(entityId: string): Promise<SocialGraphEntity | undefined> {
    return await this.loadSocialGraphEntityById(entityId);
  }

  async getSocialGraphEntityByContactId(contactId: string): Promise<SocialGraphEntity | undefined> {
    return await this.loadSocialGraphEntityByContactId(contactId);
  }

  async listSocialGraphEntities(query: SocialGraphEntityQuery = {}): Promise<SocialGraphEntity[]> {
    const limit = normalizeLimit(query.limit, 100, 1, 100);
    const allowed = new Set(getAllowedSensitivities(
      normalizeViewerTrustLevel(query.viewerTrustLevel),
      normalizeViewerVisibility(query.viewerChannelVisibility),
    ));
    const rows = query.contactId
      ? await queryRows<SocialGraphEntityRow>(
        this.pool,
        `
          SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
                 confidence, source, created_at, updated_at
          FROM social_graph_entities
          WHERE contact_id = $1
          ORDER BY updated_at DESC
          LIMIT $2
        `,
        [query.contactId, limit],
      )
      : await queryRows<SocialGraphEntityRow>(
        this.pool,
        `
          SELECT id, entity_kind, display_name, contact_id, sensitivity, provenance_refs,
                 confidence, source, created_at, updated_at
          FROM social_graph_entities
          ORDER BY updated_at DESC
          LIMIT $1
        `,
        [limit],
      );
    return rows
      .map(socialGraphEntityRowToEntity)
      .filter(entity => allowed.has(entity.sensitivity));
  }

  async upsertSocialGraphEntity(input: SocialGraphEntityUpsertInput): Promise<SocialGraphEntity> {
    const displayName = input.displayName.trim();
    if (!displayName) {
      throw new Error('social graph entity displayName must be non-empty');
    }
    const normalizedContactId = normalizeTrimmed(input.contactId);
    const existing = normalizedContactId
      ? await this.loadSocialGraphEntityByContactId(normalizedContactId)
      : (input.id ? await this.loadSocialGraphEntityById(input.id) : undefined);
    const now = new Date().toISOString();
    const id = normalizedContactId
      ? `contact:${normalizedContactId}`
      : (normalizeTrimmed(input.id) ?? `entity:${randomUUID()}`);
    const sensitivity = input.sensitivity ?? 'personal';
    const entityKind = input.entityKind ?? 'person';
    const source = input.source ?? (normalizedContactId ? 'contact' : 'manual');
    const provenanceRefs = input.provenanceRefs ?? [];
    const confidence = input.confidence ?? (normalizedContactId ? 1 : 0.7);

    if (existing) {
      const nextSensitivity = chooseMoreRestrictiveSensitivity(
        existing.sensitivity,
        sensitivity,
      );
      const nextProvenanceRefs = [...new Set([...existing.provenanceRefs, ...provenanceRefs])];
      const nextConfidence = Math.max(existing.confidence, confidence);
      await this.pool.query(
        `
          UPDATE social_graph_entities
          SET entity_kind = $1,
              display_name = $2,
              contact_id = $3,
              sensitivity = $4,
              provenance_refs = $5,
              confidence = $6,
              source = $7,
              updated_at = $8
          WHERE id = $9
        `,
        [entityKind, displayName, normalizedContactId ?? null, nextSensitivity, nextProvenanceRefs, nextConfidence, source, now, existing.id],
      );
      const updated = await this.loadSocialGraphEntityById(existing.id);
      if (!updated) throw new Error(`Failed to reload social graph entity ${existing.id}`);
      return updated;
    }

    await this.pool.query(
      `
        INSERT INTO social_graph_entities (
          id,
          entity_kind,
          display_name,
          contact_id,
          sensitivity,
          provenance_refs,
          confidence,
          source,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `,
      [id, entityKind, displayName, normalizedContactId ?? null, sensitivity, provenanceRefs, confidence, source, now, now],
    );
    const created = await this.loadSocialGraphEntityById(id);
    if (!created) throw new Error(`Failed to load social graph entity ${id}`);
    return created;
  }

  async upsertSocialRelationshipEdge(input: SocialRelationshipEdgeUpsertInput): Promise<SocialRelationshipEdge> {
    const sourceEntityId = input.sourceEntityId.trim();
    const targetEntityId = input.targetEntityId.trim();
    if (!sourceEntityId || !targetEntityId) {
      throw new Error('social relationship edge requires sourceEntityId and targetEntityId');
    }
    if (sourceEntityId === targetEntityId) {
      throw new Error('social relationship edge cannot target the same entity');
    }

    const directional = input.directional ?? true;
    const relationshipType = input.relationshipType;
    const sensitivity = input.sensitivity ?? 'personal';
    const provenanceRefs = input.provenanceRefs ?? [];
    const evidenceMemoryIds = input.evidenceMemoryIds ?? [];
    const confidence = input.confidence ?? 0.7;
    const sourceExists = await this.loadSocialGraphEntityById(sourceEntityId);
    const targetExists = await this.loadSocialGraphEntityById(targetEntityId);
    if (!sourceExists || !targetExists) {
      throw new Error('social relationship edge requires existing source and target entities');
    }

    const existing = await queryOne<SocialRelationshipEdgeRow>(
      this.pool,
      `
        SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
               sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
        FROM social_relationship_edges
        WHERE source_entity_id = $1
          AND target_entity_id = $2
          AND relationship_type = $3
          AND directional = $4
        LIMIT 1
      `,
      [sourceEntityId, targetEntityId, relationshipType, directional],
    );
    const now = new Date().toISOString();

    if (existing) {
      const existingEdge = socialGraphEdgeRowToEdge(existing);
      const nextSensitivity = existingEdge.sensitivity >= sensitivity ? existingEdge.sensitivity : sensitivity;
      const nextProvenanceRefs = [...new Set([...existingEdge.provenanceRefs, ...provenanceRefs])];
      const nextEvidenceMemoryIds = [...new Set([...existingEdge.evidenceMemoryIds, ...evidenceMemoryIds])];
      const nextConfidence = Math.max(existingEdge.confidence, confidence);
      await this.pool.query(
        `
          UPDATE social_relationship_edges
          SET sensitivity = $1,
              provenance_refs = $2,
              evidence_memory_ids = $3,
              confidence = $4,
              updated_at = $5
          WHERE id = $6
        `,
        [nextSensitivity, nextProvenanceRefs, nextEvidenceMemoryIds, nextConfidence, now, existingEdge.id],
      );
      const updated = await queryOne<SocialRelationshipEdgeRow>(
        this.pool,
        `
          SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
                 sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
          FROM social_relationship_edges
          WHERE id = $1
          LIMIT 1
        `,
        [existingEdge.id],
      );
      if (!updated) throw new Error(`Failed to reload social relationship edge ${existingEdge.id}`);
      return socialGraphEdgeRowToEdge(updated);
    }

    const id = `edge:${randomUUID()}`;
    await this.pool.query(
      `
        INSERT INTO social_relationship_edges (
          id,
          source_entity_id,
          target_entity_id,
          relationship_type,
          directional,
          sensitivity,
          provenance_refs,
          evidence_memory_ids,
          confidence,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [id, sourceEntityId, targetEntityId, relationshipType, directional, sensitivity, provenanceRefs, evidenceMemoryIds, confidence, now, now],
    );
    const created = await queryOne<SocialRelationshipEdgeRow>(
      this.pool,
      `
        SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
               sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
        FROM social_relationship_edges
        WHERE id = $1
        LIMIT 1
      `,
      [id],
    );
    if (!created) throw new Error(`Failed to load social relationship edge ${id}`);
    return socialGraphEdgeRowToEdge(created);
  }

  async listSocialRelationshipEdges(query: SocialRelationshipEdgeQuery = {}): Promise<SocialRelationshipEdge[]> {
    const rows = await this.loadSocialRelationshipEdgeRows(query);
    return rows
      .filter(row => edgeVisible(
        normalizeSensitivity(row.sensitivity),
        normalizeSensitivity(row.source_sensitivity),
        normalizeSensitivity(row.target_sensitivity),
        query,
      ))
      .map(socialGraphEdgeRowToEdge);
  }

  async listRelatedContacts(contactId: string, query: SocialRelationshipEdgeQuery = {}): Promise<Contact[]> {
    const relatedIds = await this.loadRelatedContactIds(contactId, query);
    const contacts: Contact[] = [];
    for (const relatedId of relatedIds) {
      const contact = await this.getById(relatedId);
      if (contact) contacts.push(contact);
    }
    return contacts;
  }

  async suggestLowTierTrustDrift(
    id: string,
    signals: TrustDriftBehaviorSignals,
    _actor?: string,
  ): Promise<ContactTrustDriftSuggestion | null> {
    const contact = await this.getById(id);
    if (!contact) return null;
    const suggestion = evaluateLowTierTrustDriftSuggestion(contact.trustLevel, signals);
    if (!suggestion) return null;
    return {
      ...suggestion,
      contactId: contact.id,
      createdAt: new Date().toISOString(),
    };
  }

  async applyLowTierTrustDriftSuggestion(
    id: string,
    suggestion: ContactTrustDriftSuggestion,
    actor?: string,
  ): Promise<ContactTrustDriftApplyResult> {
    const contact = await this.getById(id);
    if (!contact) {
      return { applied: false, reason: `Contact ${id} not found` };
    }
    if (suggestion.contactId !== id) {
      return { applied: false, reason: 'Trust drift suggestion contact mismatch' };
    }
    if (!isLowTierTrustLevel(contact.trustLevel)) {
      return { applied: false, reason: 'High-tier trust requires manual-only mutation paths' };
    }
    const currentTrustLevel = contact.trustLevel as LowTierTrustLevel;
    if (suggestion.fromTrustLevel !== currentTrustLevel) {
      return {
        applied: false,
        reason: `Stale trust drift suggestion: expected ${suggestion.fromTrustLevel}, found ${currentTrustLevel}`,
      };
    }
    if (!isLowTierTrustLevel(suggestion.suggestedTrustLevel)) {
      return {
        applied: false,
        reason: 'Trust drift suggestion denied: high-tier trust cannot be set through suggestion flow',
      };
    }
    const applied = await this.setTrustLevel(
      id,
      suggestion.suggestedTrustLevel,
      actor,
      { mutationSource: 'behavior_drift' },
    );
    if (!applied) {
      return { applied: false, reason: 'Trust drift suggestion denied by trust guardrails' };
    }
    return {
      applied: true,
      reason: `Applied low-tier trust drift: ${suggestion.fromTrustLevel} -> ${suggestion.suggestedTrustLevel}`,
    };
  }

  async setTrustLevel(
    id: string,
    trustLevel: TrustLevel,
    actor?: string,
    options: ContactTrustMutationOptions = {},
  ): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    if (contact.trustLevel === trustLevel) return true;

    const mutationSource = resolveTrustMutationSource(actor, options.mutationSource);
    if (
      mutationSource === 'behavior_drift'
      && isHighTierTrustLevel(contact.trustLevel)
    ) {
      return false;
    }
    if (
      mutationSource === 'behavior_drift'
      && isHighTierTrustLevel(trustLevel)
      && !isManualHighTierTrustMutationAuthorized(actor, mutationSource)
    ) {
      return false;
    }
    if (contact.trustLevel === 'primary') {
      return false;
    }
    if (trustLevel === 'primary' && !this.isPrimaryTrustAssignmentAuthorized(contact, [], contact.discordUserId, options)) {
      await this.appendPrimaryTrustAudit(contact.id, contact.trustLevel, 'set_trust_level', 'denied', actor, {
        requestedTrustLevel: trustLevel,
        hasConfiguredPrimaryUserId: Boolean(this.primaryUserId),
      });
      return false;
    }

    await this.pool.query('UPDATE contacts SET trust_level = $1 WHERE id = $2', [trustLevel, id]);
    if (trustLevel === 'primary') {
      await this.appendPrimaryTrustAudit(id, contact.trustLevel, 'set_trust_level', 'allowed', actor);
    } else {
      await this.appendMutationAuditEntry(id, 'trust_level', contact.trustLevel, trustLevel, actor);
    }
    await this.syncContactExports();
    return true;
  }

  async updateLastSeen(id: string): Promise<void> {
    await this.touchContactLastSeen(id);
  }

  async updateIdentityProfile(contactId: string, displayName: string, nickname?: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const nextDisplayName = displayName.trim() || contact.displayName;
    const requestedNickname = normalizeNicknameValue(nickname);
    const nextNickname = requestedNickname === undefined ? (contact.nickname ?? null) : requestedNickname;
    if (contact.displayName === nextDisplayName && (contact.nickname ?? null) === nextNickname) {
      return true;
    }
    await this.pool.query(
      `
        UPDATE contacts
        SET display_name = $1,
            nickname = $2
        WHERE id = $3
      `,
      [nextDisplayName, nextNickname, contactId],
    );
    if (contact.displayName !== nextDisplayName) {
      await this.appendMutationAuditEntry(contactId, 'display_name', contact.displayName, nextDisplayName, actor);
    }
    if ((contact.nickname ?? null) !== nextNickname) {
      await this.appendMutationAuditEntry(contactId, 'nickname', contact.nickname ?? null, nextNickname, actor);
    }
    await this.upsertSocialGraphEntityForContact({
      id: contactId,
      displayName: nextDisplayName,
      firstSeen: contact.firstSeen,
      lastSeen: contact.lastSeen,
    });
    await this.syncContactExports();
    return true;
  }

  async recordChannelActivity(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel?: ChannelPrivacyLevel,
  ): Promise<void> {
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return;
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const now = new Date().toISOString();
    const normalizedPrivacy = privacyLevel !== undefined
      ? normalizePrivacyLevel(privacyLevel, normalizedChannel)
      : undefined;
    await this.pool.query(
      `
        INSERT INTO contact_channel_activity (
          contact_id,
          channel,
          channel_id,
          privacy_level,
          first_seen,
          last_seen
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(contact_id, channel, channel_id)
        DO UPDATE SET
          privacy_level = EXCLUDED.privacy_level,
          last_seen = EXCLUDED.last_seen
      `,
      [contactId, normalizedChannel, trimmedChannelId, normalizedPrivacy ?? null, now, now],
    );
    await this.syncContactExports();
  }

  async mergeContacts(sourceContactId: string, targetContactId: string): Promise<boolean> {
    if (sourceContactId === targetContactId) return true;
    return await withPostgresClient(this.pool, async (client) => {
      const sourceRow = await queryOne<ContactRow>(
        this.pool,
        `
          SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type,
                 emotional_baseline, emotional_time_series, first_seen, last_seen, notes
          FROM contacts
          WHERE id = $1
          LIMIT 1
        `,
        [sourceContactId],
      );
      const targetRow = await queryOne<ContactRow>(
        this.pool,
        `
          SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type,
                 emotional_baseline, emotional_time_series, first_seen, last_seen, notes
          FROM contacts
          WHERE id = $1
          LIMIT 1
        `,
        [targetContactId],
      );
      if (!sourceRow || !targetRow) return false;

      await client.query('UPDATE contact_channel_ids SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
      await client.query('UPDATE contact_channel_activity SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);

      if (await this.tableExists('l2_memories')) {
        await client.query('UPDATE l2_memories SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
      }
      if (await this.tableExists('contact_profiles')) {
        const targetProfileExists = await queryOne<{ exists_flag: number }>(
          this.pool,
          'SELECT 1 AS exists_flag FROM contact_profiles WHERE contact_id = $1 LIMIT 1',
          [targetContactId],
        );
        if (targetProfileExists) {
          await client.query('DELETE FROM contact_profiles WHERE contact_id = $1', [sourceContactId]);
        } else {
          await client.query('UPDATE contact_profiles SET contact_id = $1 WHERE contact_id = $2', [targetContactId, sourceContactId]);
        }
      }

      const mergedTrustLevel = pickMostTrustedLevel(sourceRow.trust_level, targetRow.trust_level);
      const mergedRelationshipType = mergedTrustLevel === 'primary'
        ? 'partner'
        : targetRow.relationship_type;
      const mergedDisplayName = pickPreferredDisplayName(
        targetRow.display_name,
        sourceRow.display_name,
        targetRow.discord_user_id,
        sourceRow.discord_user_id,
      );
      const mergedNickname = targetRow.nickname ?? sourceRow.nickname;
      const mergedDiscordUserId = targetRow.discord_user_id ?? sourceRow.discord_user_id;
      const mergedBaseline = Object.keys(normalizeJsonObject(targetRow.emotional_baseline)).length > 0
        ? targetRow.emotional_baseline
        : sourceRow.emotional_baseline;
      const mergedEmotionalTimeSeries = mergeEmotionalTimeSeries(
        sourceRow.emotional_time_series,
        targetRow.emotional_time_series,
      );
      const mergedFirstSeen = earliestTimestamp(sourceRow.first_seen, targetRow.first_seen);
      const mergedLastSeen = latestTimestamp(sourceRow.last_seen, targetRow.last_seen);
      const mergedNotes = targetRow.notes ?? sourceRow.notes;

      const sourceEntity = await this.loadSocialGraphEntityByContactId(sourceContactId);
      const targetEntity = await this.loadSocialGraphEntityByContactId(targetContactId);
      if (sourceEntity && targetEntity) {
        const mergedSensitivity = chooseMoreRestrictiveSensitivity(
          targetEntity.sensitivity,
          sourceEntity.sensitivity,
        );
        const mergedProvenanceRefs = [...new Set([...targetEntity.provenanceRefs, ...sourceEntity.provenanceRefs])];
        const mergedConfidence = Math.max(targetEntity.confidence, sourceEntity.confidence);
        await client.query(
          `
            UPDATE social_graph_entities
            SET sensitivity = $1,
                provenance_refs = $2,
                confidence = $3,
                updated_at = $4
            WHERE id = $5
          `,
          [mergedSensitivity, mergedProvenanceRefs, mergedConfidence, mergedLastSeen, targetEntity.id],
        );

        const sourceEdges = await queryRows<SocialRelationshipEdgeRow>(
          this.pool,
          `
            SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
                   sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
            FROM social_relationship_edges
            WHERE source_entity_id = $1 OR target_entity_id = $1
            ORDER BY created_at ASC, id ASC
          `,
          [sourceEntity.id],
        );
        for (const row of sourceEdges) {
          const edge = socialGraphEdgeRowToEdge(row);
          const rewrittenSource = edge.sourceEntityId === sourceEntity.id ? targetEntity.id : edge.sourceEntityId;
          const rewrittenTarget = edge.targetEntityId === sourceEntity.id ? targetEntity.id : edge.targetEntityId;
          if (rewrittenSource === rewrittenTarget) {
            await client.query('DELETE FROM social_relationship_edges WHERE id = $1', [edge.id]);
            continue;
          }
          const duplicate = await queryOne<SocialRelationshipEdgeRow>(
            this.pool,
            `
              SELECT id, source_entity_id, target_entity_id, relationship_type, directional,
                     sensitivity, provenance_refs, evidence_memory_ids, confidence, created_at, updated_at
              FROM social_relationship_edges
              WHERE source_entity_id = $1
                AND target_entity_id = $2
                AND relationship_type = $3
                AND directional = $4
                AND id != $5
              LIMIT 1
            `,
            [rewrittenSource, rewrittenTarget, edge.relationshipType, edge.directional, edge.id],
          );
          if (duplicate) {
            const duplicateEdge = socialGraphEdgeRowToEdge(duplicate);
            await client.query(
              `
                UPDATE social_relationship_edges
                SET sensitivity = $1,
                    provenance_refs = $2,
                    evidence_memory_ids = $3,
                    confidence = $4,
                    updated_at = $5
                WHERE id = $6
              `,
              [
                duplicateEdge.sensitivity >= edge.sensitivity ? duplicateEdge.sensitivity : edge.sensitivity,
                [...new Set([...duplicateEdge.provenanceRefs, ...edge.provenanceRefs])],
                [...new Set([...duplicateEdge.evidenceMemoryIds, ...edge.evidenceMemoryIds])],
                Math.max(duplicateEdge.confidence, edge.confidence),
                duplicateEdge.updatedAt >= edge.updatedAt ? duplicateEdge.updatedAt : edge.updatedAt,
                duplicateEdge.id,
              ],
            );
            await client.query('DELETE FROM social_relationship_edges WHERE id = $1', [edge.id]);
            continue;
          }
          await client.query(
            `
              UPDATE social_relationship_edges
              SET source_entity_id = $1,
                  target_entity_id = $2,
                  updated_at = $3
              WHERE id = $4
            `,
            [rewrittenSource, rewrittenTarget, mergedLastSeen, edge.id],
          );
        }
        await client.query('DELETE FROM social_graph_entities WHERE id = $1', [sourceEntity.id]);
      }

      await client.query('DELETE FROM contacts WHERE id = $1', [sourceContactId]);
      await client.query(
        `
          UPDATE contacts
          SET discord_user_id = $1,
              display_name = $2,
              nickname = $3,
              trust_level = $4,
              relationship_type = $5,
              emotional_baseline = $6,
              emotional_time_series = $7,
              first_seen = $8,
              last_seen = $9,
              notes = $10
          WHERE id = $11
        `,
        [
          mergedDiscordUserId,
          mergedDisplayName,
          mergedNickname ?? null,
          mergedTrustLevel,
          mergedRelationshipType,
          mergedBaseline,
          mergedEmotionalTimeSeries,
          mergedFirstSeen,
          mergedLastSeen,
          mergedNotes ?? null,
          targetContactId,
        ],
      );

      await this.syncContactExports();
      return true;
    });
  }

  async updateNotes(id: string, notes: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    const previousNotes = contact.notes ?? null;
    if (previousNotes === notes) return true;
    await this.pool.query('UPDATE contacts SET notes = $1 WHERE id = $2', [notes, id]);
    await this.appendMutationAuditEntry(id, 'notes', previousNotes, notes, actor);
    await this.syncContactExports();
    return true;
  }

  async updateEmotionalBaseline(
    id: string,
    observation: {
      valence: number;
      confidence?: number;
      observedAtMs?: number;
    },
  ): Promise<Contact | undefined> {
    const contact = await this.getById(id);
    if (!contact) return undefined;
    const updatedBaseline = computeUpdatedEmotionalBaseline(contact.emotionalBaseline, observation);
    const updatedTimeSeries = appendEmotionalObservationToTimeSeries(
      await this.loadContactEmotionalTimeSeries(id),
      observation,
    );
    await this.pool.query(
      `
        UPDATE contacts
        SET emotional_baseline = $1,
            emotional_time_series = $2,
            last_seen = $3
        WHERE id = $4
      `,
      [updatedBaseline, updatedTimeSeries, new Date().toISOString(), id],
    );
    await this.syncContactExports();
    return await this.getById(id);
  }

  async getEmotionalSnapshot(id: string): Promise<EmotionalSnapshot | undefined> {
    const contact = await this.getById(id);
    if (!contact) return undefined;
    const snapshot = parseMoodSnapshot(contact.emotionalBaseline);
    return hasLearnedMoodSnapshot(snapshot) ? snapshot : undefined;
  }

  async getEmotionalTimeSeries(id: string, limit?: number): Promise<EmotionalTimeSeriesPoint[]> {
    return await this.loadContactEmotionalTimeSeries(id, limit);
  }

  async updateRelationshipType(id: string, relationshipType: RelationshipType, actor?: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    if (contact.relationshipType === relationshipType) return true;
    if (contact.trustLevel === 'primary' && relationshipType !== 'partner') {
      return false;
    }
    await this.pool.query('UPDATE contacts SET relationship_type = $1 WHERE id = $2', [relationshipType, id]);
    await this.appendMutationAuditEntry(id, 'relationship_type', contact.relationshipType, relationshipType, actor);
    await this.syncContactExports();
    return true;
  }

  async setChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    if (existingLink.privacyLevel === privacyLevel) return true;
    await this.pool.query(
      `
        UPDATE contact_channel_ids
        SET privacy_level = $1,
            last_seen = $2
        WHERE contact_id = $3 AND channel = $4 AND channel_user_id = $5
      `,
      [privacyLevel, new Date().toISOString(), contactId, normalizedIdentity.channel, normalizedIdentity.userId],
    );
    await this.appendMutationAuditEntry(
      contactId,
      'channel_privacy',
      JSON.stringify({
        channel: normalizedIdentity.channel,
        userId: normalizedIdentity.userId,
        privacyLevel: existingLink.privacyLevel,
      }),
      JSON.stringify({
        channel: normalizedIdentity.channel,
        userId: normalizedIdentity.userId,
        privacyLevel,
      }),
      actor,
    );
    await this.syncContactExports();
    return true;
  }

  async setConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
    privacyLevel: ChannelPrivacyLevel,
    actor?: string,
  ): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return false;
    const existingChannel = contact.conversationChannels?.find(entry => (
      entry.channel === normalizedChannel && entry.channelId === trimmedChannelId
    ));
    const previousPrivacyLevel = existingChannel?.privacyLevel;
    const normalizedPrivacyLevel = normalizePrivacyLevel(privacyLevel, normalizedChannel);
    if (previousPrivacyLevel === normalizedPrivacyLevel) return true;
    await this.pool.query(
      `
        INSERT INTO contact_channel_activity (
          contact_id,
          channel,
          channel_id,
          privacy_level,
          first_seen,
          last_seen
        )
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(contact_id, channel, channel_id)
        DO UPDATE SET
          privacy_level = EXCLUDED.privacy_level,
          last_seen = EXCLUDED.last_seen
      `,
      [contactId, normalizedChannel, trimmedChannelId, normalizedPrivacyLevel, new Date().toISOString(), new Date().toISOString()],
    );
    await this.appendMutationAuditEntry(
      contactId,
      'channel_privacy',
      previousPrivacyLevel
        ? JSON.stringify({
          channel: normalizedChannel,
          channelId: trimmedChannelId,
          privacyLevel: previousPrivacyLevel,
        })
        : null,
      JSON.stringify({
        channel: normalizedChannel,
        channelId: trimmedChannelId,
        privacyLevel: normalizedPrivacyLevel,
      }),
      actor,
    );
    await this.syncContactExports();
    return true;
  }

  async getConversationChannelPrivacy(
    contactId: string,
    channel: ContactChannel,
    channelId: string,
  ): Promise<ChannelPrivacyLevel | undefined> {
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return undefined;
    const row = await queryOne<{ privacy_level: string | null }>(
      this.pool,
      `
        SELECT privacy_level
        FROM contact_channel_activity
        WHERE contact_id = $1 AND channel = $2 AND channel_id = $3
        LIMIT 1
      `,
      [contactId, normalizedChannel, trimmedChannelId],
    );
    if (!row?.privacy_level) return undefined;
    return normalizePrivacyLevel(row.privacy_level as ChannelPrivacyLevel, normalizedChannel);
  }

  async deleteConversationChannel(contactId: string, channel: ContactChannel, channelId: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedChannel = channel.trim().toLowerCase() || 'unknown';
    const trimmedChannelId = channelId.trim();
    if (!trimmedChannelId) return false;
    const existingChannel = contact.conversationChannels?.find(entry => (
      entry.channel === normalizedChannel && entry.channelId === trimmedChannelId
    ));
    if (!existingChannel) return false;
    const result = await this.pool.query(
      `
        DELETE FROM contact_channel_activity
        WHERE contact_id = $1 AND channel = $2 AND channel_id = $3
      `,
      [contactId, normalizedChannel, trimmedChannelId],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.appendMutationAuditEntry(
        contactId,
        'conversation_channel',
        JSON.stringify({
          channel: normalizedChannel,
          channelId: trimmedChannelId,
          ...(existingChannel.privacyLevel ? { privacyLevel: existingChannel.privacyLevel } : {}),
        }),
        null,
        actor,
      );
      await this.syncContactExports();
    }
    return (result.rowCount ?? 0) > 0;
  }

  async createIdentityLinkChallenge(
    input: ContactIdentityLinkChallengeInput,
  ): Promise<ContactIdentityLinkChallengeResult> {
    const contact = await this.getById(input.contactId);
    if (!contact) return { status: 'contact_not_found' };

    const sourceIdentity = normalizeIdentity(input.sourceChannel, input.sourceUserId);
    const targetIdentity = normalizeIdentity(input.targetChannel, input.targetUserId);
    const sourceOwner = await this.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
    if (!sourceOwner || sourceOwner.id !== contact.id) {
      return { status: 'source_identity_not_linked' };
    }

    const targetOwner = await this.getByChannelIdentity(targetIdentity.channel, targetIdentity.userId);
    if (targetOwner && targetOwner.id !== contact.id) {
      return { status: 'identity_conflict' };
    }
    if (targetOwner && targetOwner.id === contact.id) {
      return { status: 'already_linked' };
    }

    const existingPending = await queryOne<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        WHERE contact_id = $1
          AND source_channel = $2
          AND source_user_id = $3
          AND target_channel = $4
          AND target_user_id = $5
          AND status = 'pending'
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [contact.id, sourceIdentity.channel, sourceIdentity.userId, targetIdentity.channel, targetIdentity.userId],
    );
    if (existingPending) {
      const expiresAtMs = Date.parse(existingPending.expires_at);
      if (Number.isFinite(expiresAtMs) && expiresAtMs > Date.now()) {
        return {
          status: 'pending_exists',
          verification: this.toVerification(existingPending),
        };
      }
      await this.markIdentityLinkVerification(existingPending.id, 'expired', 'expired');
    }

    const now = new Date();
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + Math.min(Math.max(Math.floor(input.ttlMs ?? 5 * 60_000), 1), 60 * 60_000)).toISOString();
    const verification: ContactIdentityLinkVerification = {
      id: uuidv4(),
      contactId: contact.id,
      sourceChannel: sourceIdentity.channel,
      sourceUserId: sourceIdentity.userId,
      targetChannel: targetIdentity.channel,
      targetUserId: targetIdentity.userId,
      nonce: randomUUID().replace(/-/g, ''),
      expiresAt,
      signature: randomUUID().replace(/-/g, ''),
      status: 'pending',
      createdAt,
      updatedAt: createdAt,
    };
    await this.pool.query(
      `
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
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NULL, NULL)
      `,
      [
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
      ],
    );
    return { status: 'challenge_created', verification };
  }

  private toVerification(row: ContactIdentityVerificationRow): ContactIdentityLinkVerification {
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
      status: row.status as ContactIdentityLinkVerification['status'],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      ...(row.verified_at ? { verifiedAt: row.verified_at } : {}),
      ...(row.failure_reason ? { failureReason: row.failure_reason } : {}),
    };
  }

  private async markIdentityLinkVerification(
    verificationId: string,
    status: ContactIdentityLinkVerification['status'],
    failureReason?: string,
    verifiedAt?: string,
  ): Promise<ContactIdentityLinkVerification | undefined> {
    const now = new Date().toISOString();
    await this.pool.query(
      `
        UPDATE contact_identity_link_verifications
        SET status = $1,
            updated_at = $2,
            verified_at = COALESCE($3, verified_at),
            failure_reason = $4
        WHERE id = $5
      `,
      [status, now, verifiedAt ?? null, failureReason ?? null, verificationId],
    );
    const row = await queryOne<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        WHERE id = $1
        LIMIT 1
      `,
      [verificationId],
    );
    return row ? this.toVerification(row) : undefined;
  }

  async verifyIdentityLinkChallenge(
    input: ContactIdentityLinkVerificationInput,
  ): Promise<ContactIdentityLinkVerificationResult> {
    const contact = await this.getById(input.contactId);
    if (!contact) return { status: 'contact_not_found' };

    const sourceIdentity = normalizeIdentity(input.sourceChannel, input.sourceUserId);
    const targetIdentity = normalizeIdentity(input.targetChannel, input.targetUserId);
    const row = await queryOne<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        WHERE contact_id = $1
          AND source_channel = $2
          AND source_user_id = $3
          AND target_channel = $4
          AND target_user_id = $5
          AND nonce = $6
        ORDER BY created_at DESC
        LIMIT 1
      `,
      [input.contactId, sourceIdentity.channel, sourceIdentity.userId, targetIdentity.channel, targetIdentity.userId, input.nonce.trim()],
    );
    if (!row) {
      return { status: 'verification_not_found' };
    }

    const verification = this.toVerification(row);
    if (verification.status !== 'pending') {
      return { status: 'verification_replayed', verification };
    }
    if (row.expires_at !== input.expiresAt.trim()) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'claim_mismatch');
      return { status: 'claim_mismatch', verification: failed ?? verification };
    }
    const expiresAtMs = Date.parse(row.expires_at);
    if (!Number.isFinite(expiresAtMs) || Date.now() > expiresAtMs) {
      const expired = await this.markIdentityLinkVerification(row.id, 'expired', 'expired');
      return { status: 'verification_expired', verification: expired ?? verification };
    }
    if (row.signature !== input.signature.trim()) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'invalid_signature');
      return { status: 'invalid_signature', verification: failed ?? verification };
    }

    const sourceOwner = await this.getByChannelIdentity(sourceIdentity.channel, sourceIdentity.userId);
    if (!sourceOwner || sourceOwner.id !== input.contactId) {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'source_identity_not_linked');
      return { status: 'source_identity_not_linked', verification: failed ?? verification };
    }

    const linkResult = await this.linkChannelIdentity(
      input.contactId,
      targetIdentity.channel,
      targetIdentity.userId,
      { privacyLevel: input.privacyLevel },
    );
    if (linkResult === 'identity_conflict') {
      const failed = await this.markIdentityLinkVerification(row.id, 'failed', 'identity_conflict');
      return { status: 'identity_conflict', verification: failed ?? verification };
    }
    if (linkResult === 'contact_not_found') {
      return { status: 'contact_not_found' };
    }

    const linked = await this.markIdentityLinkVerification(row.id, 'verified', undefined, new Date().toISOString());
    const finalVerification = linked ?? verification;
    return {
      status: linkResult === 'linked' ? 'linked' : 'already_linked',
      verification: finalVerification,
    };
  }

  async linkChannelIdentity(
    contactId: string,
    channel: ContactChannel,
    channelUserId: string,
    options?: ContactIdentityLinkOptions,
    _actor?: string,
  ): Promise<ContactIdentityLinkResult> {
    const contact = await this.getById(contactId);
    if (!contact) return 'contact_not_found';

    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const result = await this.upsertIdentityLinkRecord(
      contactId,
      normalizedIdentity.channel,
      normalizedIdentity.userId,
      contact.firstSeen,
      new Date().toISOString(),
      options?.privacyLevel,
    );
    if (result === 'identity_conflict') {
      return result;
    }

    if (normalizedIdentity.channel === 'discord') {
      await this.pool.query(
        `
          UPDATE contacts
          SET discord_user_id = COALESCE(discord_user_id, $1)
          WHERE id = $2
        `,
        [normalizedIdentity.userId, contactId],
      );
    }

    if (isPrimaryIdentity(normalizedIdentity, this.primaryUserId)) {
      await this.pool.query(
        `
          UPDATE contacts
          SET trust_level = 'primary',
              relationship_type = 'partner'
          WHERE id = $1
        `,
        [contactId],
      );
      const duplicatePrimaryRows = await queryRows<{ id: string }>(
        this.pool,
        `
          SELECT id
          FROM contacts
          WHERE id <> $1 AND trust_level = 'primary'
          ORDER BY first_seen ASC
        `,
        [contactId],
      );
      for (const duplicate of duplicatePrimaryRows) {
        await this.mergeContacts(duplicate.id, contactId);
      }
    }

    await this.upsertSocialGraphEntityForContact({
      id: contact.id,
      displayName: contact.displayName,
      firstSeen: contact.firstSeen,
      lastSeen: contact.lastSeen,
    });
    await this.syncContactExports();
    return result;
  }

  async listAll(): Promise<Contact[]> {
    const rows = await queryRows<ContactRow>(
      this.pool,
      `
        SELECT id, discord_user_id, display_name, nickname, trust_level, relationship_type,
               emotional_baseline, first_seen, last_seen, notes
        FROM contacts
        ORDER BY last_seen DESC
      `,
    );
    const contacts: Contact[] = [];
    for (const row of rows) {
      contacts.push(await this.loadContactByRow(row));
    }
    return contacts;
  }

  async listIdentityLinkVerifications(limit = 25): Promise<ContactIdentityLinkVerification[]> {
    const normalizedLimit = normalizeLimit(limit, 25, 1, 200);
    const rows = await queryRows<ContactIdentityVerificationRow>(
      this.pool,
      `
        SELECT *
        FROM contact_identity_link_verifications
        ORDER BY created_at DESC
        LIMIT $1
      `,
      [normalizedLimit],
    );
    return rows.map(row => this.toVerification(row));
  }

  async listMutationAuditEntries(query: ContactMutationAuditQuery = {}): Promise<ContactMutationAuditEntry[]> {
    const normalizedLimit = normalizeLimit(query.limit, 25, 1, 200);
    const clauses: string[] = [];
    const params: unknown[] = [];
    if (query.contactId) {
      clauses.push(`contact_id = $${params.length + 1}`);
      params.push(query.contactId.trim());
    }
    if (query.actor) {
      clauses.push(`actor = $${params.length + 1}`);
      params.push(query.actor.trim());
    }
    if (query.field) {
      clauses.push(`field = $${params.length + 1}`);
      params.push(query.field);
    }
    const rows = await queryRows<ContactMutationAuditRow>(
      this.pool,
      `
        SELECT id, contact_id, actor, field, old_value, new_value, timestamp
        FROM contact_mutation_audit
        ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
        ORDER BY timestamp DESC, id DESC
        LIMIT $${params.length + 1}
      `,
      [...params, normalizedLimit],
    );
    return rows.flatMap((row) => {
      const mapped = contactMutationAuditRowToEntry(row);
      return mapped ? [mapped] : [];
    });
  }

  async resolveChannelIdentity(
    channel: ContactChannel,
    channelUserId: string,
    displayName?: string,
  ): Promise<Contact> {
    const identity = normalizeIdentity(channel, channelUserId);
    const existing = await this.getByChannelIdentity(identity.channel, identity.userId);
    if (existing) {
      await this.touchContactLastSeen(existing.id);
      if (displayName?.trim() && looksLikeOpaqueIdentifier(existing.displayName)) {
        await this.pool.query('UPDATE contacts SET display_name = $1 WHERE id = $2', [displayName.trim(), existing.id]);
      }
      await this.upsertIdentityLinkRecord(existing.id, identity.channel, identity.userId, existing.firstSeen, new Date().toISOString(), defaultPrivacyForChannel(identity.channel));
      const updated = await this.getById(existing.id);
      if (!updated) throw new Error(`Failed to reload resolved contact ${existing.id}`);
      await this.upsertSocialGraphEntityForContact({
        id: updated.id,
        displayName: updated.displayName,
        firstSeen: updated.firstSeen,
        lastSeen: updated.lastSeen,
      });
      await this.syncContactExports();
      return updated;
    }

    return await this.upsert({
      displayName: displayName?.trim() || identity.userId,
      channels: [{
        channel: identity.channel,
        userId: identity.userId,
        privacyLevel: defaultPrivacyForChannel(identity.channel),
        firstSeen: '',
        lastSeen: '',
      }],
      ...(identity.channel === 'discord' ? { discordUserId: identity.userId } : {}),
    });
  }

  async resolveUserId(discordUserId: string): Promise<Contact> {
    const contact = await this.getByDiscordUserId(discordUserId);
    if (contact) {
      await this.touchContactLastSeen(contact.id);
      const updated = await this.getById(contact.id);
      if (!updated) throw new Error(`Failed to reload resolved contact ${contact.id}`);
      return updated;
    }
    return await this.upsert({
      displayName: discordUserId.trim() || discordUserId,
      discordUserId,
    });
  }

  async getCanonicalContactKey(channel: ContactChannel, channelUserId: string): Promise<string | undefined> {
    return (await this.getByChannelIdentity(channel, channelUserId))?.id;
  }

  async deleteContact(id: string): Promise<boolean> {
    const contact = await this.getById(id);
    if (!contact) return false;
    if (contact.trustLevel === 'primary') {
      return false;
    }
    await this.pool.query('DELETE FROM contact_channel_ids WHERE contact_id = $1', [id]);
    await this.pool.query('DELETE FROM contact_channel_activity WHERE contact_id = $1', [id]);
    await this.pool.query('DELETE FROM contact_identity_link_verifications WHERE contact_id = $1', [id]);
    await this.pool.query('DELETE FROM contact_mutation_audit WHERE contact_id = $1', [id]);
    if (await this.tableExists('l2_memories')) {
      await this.pool.query('UPDATE l2_memories SET contact_id = NULL WHERE contact_id = $1', [id]);
    }
    if (await this.tableExists('contact_profiles')) {
      await this.pool.query('DELETE FROM contact_profiles WHERE contact_id = $1', [id]);
    }
    const result = await this.pool.query('DELETE FROM contacts WHERE id = $1', [id]);
    if ((result.rowCount ?? 0) > 0) {
      await this.syncContactExports();
    }
    return (result.rowCount ?? 0) > 0;
  }

  async unlinkChannelIdentity(contactId: string, channel: string, channelUserId: string, actor?: string): Promise<boolean> {
    const contact = await this.getById(contactId);
    if (!contact) return false;
    const normalizedIdentity = normalizeIdentity(channel, channelUserId);
    const existingLink = contact.channels?.find(link => (
      link.channel === normalizedIdentity.channel && link.userId === normalizedIdentity.userId
    ));
    if (!existingLink) return false;
    const result = await this.pool.query(
      `
        DELETE FROM contact_channel_ids
        WHERE contact_id = $1 AND channel = $2 AND channel_user_id = $3
      `,
      [contactId, normalizedIdentity.channel, normalizedIdentity.userId],
    );
    if ((result.rowCount ?? 0) > 0) {
      await this.appendMutationAuditEntry(
        contactId,
        'channel_link',
        JSON.stringify({
          channel: normalizedIdentity.channel,
          userId: normalizedIdentity.userId,
          privacyLevel: existingLink.privacyLevel,
        }),
        null,
        actor,
      );
      await this.syncContactExports();
    }
    return (result.rowCount ?? 0) > 0;
  }
}
