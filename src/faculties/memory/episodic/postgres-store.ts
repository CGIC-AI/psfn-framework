import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import {
  createPostgresPool,
  executeQuery,
  queryOne,
  queryRows,
} from '../../../persistence/postgres.js';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  parseEpisodeArc,
  serializeEpisode,
  serializeEpisodeArc,
  type Episode,
  type EpisodeArc,
  type EpisodeArtifactRef,
  type EpisodeProvenanceRef,
} from '../../../shared/contracts/episodic-memory.js';
import {
  normalizeEpisodicDiagnosticsNow,
  summarizeEpisodicMaintenanceDiagnostics,
} from './store.js';
import type {
  EpisodeArcListOptions,
  EpisodeArcWriteInput,
  EpisodeCandidateDecision,
  EpisodeCandidateDecisionListOptions,
  EpisodeCandidateDecisionStatus,
  EpisodeCandidateDecisionWriteInput,
  EpisodeCreateInput,
  EpisodeLineage,
  EpisodeLineageRelation,
  EpisodeLineageWriteInput,
  EpisodicMaintenanceDiagnostics,
  EpisodicMaintenanceDiagnosticsOptions,
  EpisodeListOptions,
  EpisodeTimeSearchOptions,
  EpisodeUpdateInput,
  EpisodicProcessingWatermark,
  EpisodicProcessingWatermarkScope,
  EpisodicProcessingWatermarkStatus,
  EpisodicProcessingWatermarkWriteInput,
  EpisodicReconciliationStatus,
  EpisodicStoreOptions,
  EpisodicStorePort,
} from './store.js';

interface PostgresEpisodeRow {
  id: string;
  episode_json: unknown;
}

interface PostgresEpisodeArcRow {
  id: string;
  arc_json: unknown;
}

interface PostgresProcessingWatermarkRow {
  id: string;
  processor: string;
  source_ref: string;
  channel_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  high_water_turn_id: string | null;
  high_water_message_id: string | null;
  processed_started_at: string | null;
  processed_ended_at: string | null;
  previous_watermark_json: unknown;
  next_watermark_json: unknown;
  status: string;
  reconciliation_status: string;
  artifacts_json: unknown;
  last_processed_at: string;
  updated_at: string;
}

interface PostgresCandidateDecisionRow {
  id: string;
  candidate_episode_id: string | null;
  canonical_episode_id: string | null;
  merged_into_episode_id: string | null;
  superseded_by_episode_id: string | null;
  source_watermark_id: string | null;
  status: string;
  channel_id: string | null;
  thread_id: string | null;
  session_id: string | null;
  started_at: string | null;
  ended_at: string | null;
  overlap_score: number | null;
  confidence: number;
  reason: string | null;
  candidate_json: unknown;
  artifact_refs: unknown;
  provenance_refs: unknown;
  created_at: string;
  updated_at: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const WATERMARK_STATUSES = new Set<EpisodicProcessingWatermarkStatus>(['active', 'reconciling', 'blocked', 'complete']);
const RECONCILIATION_STATUSES = new Set<EpisodicReconciliationStatus>(['pending', 'clean', 'needs_review', 'blocked']);
const CANDIDATE_DECISION_STATUSES = new Set<EpisodeCandidateDecisionStatus>([
  'pending',
  'accepted',
  'canonical',
  'merged',
  'superseded',
  'rejected',
  'needs_review',
]);
const EPISODE_LINEAGE_RELATIONS = new Set<EpisodeLineageRelation>([
  'canonicalizes',
  'merges',
  'supersedes',
  'splits_from',
  'derived_from',
  'conflicts_with',
  'updates',
]);
const ACTIVE_CANONICAL_EPISODE_FILTER = `
  (status IS NULL OR status = 'canonical')
  AND (canonical_episode_id IS NULL OR canonical_episode_id = id)
  AND merged_into_episode_id IS NULL
  AND superseded_by_episode_id IS NULL
`;
const ACTIVE_CANONICAL_ARC_FILTER = `
  (status IS NULL OR status = 'canonical')
  AND (canonical_arc_id IS NULL OR canonical_arc_id = id)
  AND merged_into_arc_id IS NULL
  AND superseded_by_arc_id IS NULL
`;

export function createPostgresEpisodicStore(
  databaseUrl: string,
  options: EpisodicStoreOptions = {},
): PostgresEpisodicStore {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-episodic-memory',
    allowExitOnIdle: true,
  });
  return createPostgresEpisodicStoreFromPool(pool, options);
}

export function createPostgresEpisodicStoreFromPool(
  pool: Pool,
  options: EpisodicStoreOptions = {},
): PostgresEpisodicStore {
  return new PostgresEpisodicStore(pool, options);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return offset;
}

function normalizeInstant(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!ISO_INSTANT_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC instant`);
  }
  return trimmed;
}

function parseRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function parseJsonPayload(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} JSON is not parseable: ${String(error)}`);
  }
}

function parseRecordPayload(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJsonPayload(value, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseArrayPayload<T>(value: unknown, label: string): T[] {
  const parsed = parseJsonPayload(value, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed as T[];
}

function parseEpisodeJson(raw: unknown, id: string): Episode {
  try {
    return parseEpisode(parseJsonPayload(raw, `episode "${id}"`));
  } catch (error) {
    throw new Error(`malformed persisted episode "${id}": ${String(error)}`);
  }
}

function parseArcJson(raw: unknown, id: string): EpisodeArc {
  try {
    return parseEpisodeArc(parseJsonPayload(raw, `episode arc "${id}"`));
  } catch (error) {
    throw new Error(`malformed persisted episode arc "${id}": ${String(error)}`);
  }
}

function mapEpisodeRow(row: PostgresEpisodeRow): Episode {
  const episode = parseEpisodeJson(row.episode_json, row.id);
  if (episode.id !== row.id) {
    throw new Error(`malformed persisted episode "${row.id}": JSON id mismatch`);
  }
  return episode;
}

function mapArcRow(row: PostgresEpisodeArcRow): EpisodeArc {
  const arc = parseArcJson(row.arc_json, row.id);
  if (arc.id !== row.id) {
    throw new Error(`malformed persisted episode arc "${row.id}": JSON id mismatch`);
  }
  return arc;
}

function mapWatermarkRow(row: PostgresProcessingWatermarkRow): EpisodicProcessingWatermark {
  const status = row.status as EpisodicProcessingWatermarkStatus;
  if (!WATERMARK_STATUSES.has(status)) {
    throw new Error(`malformed persisted processing watermark "${row.id}": unsupported status`);
  }
  const reconciliationStatus = row.reconciliation_status as EpisodicReconciliationStatus;
  if (!RECONCILIATION_STATUSES.has(reconciliationStatus)) {
    throw new Error(`malformed persisted processing watermark "${row.id}": unsupported reconciliation status`);
  }
  return {
    id: row.id,
    processor: row.processor,
    sourceRef: row.source_ref,
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.high_water_turn_id ? { highWaterTurnId: row.high_water_turn_id } : {}),
    ...(row.high_water_message_id ? { highWaterMessageId: row.high_water_message_id } : {}),
    ...(row.processed_started_at ? { processedStartedAt: new Date(row.processed_started_at).toISOString() } : {}),
    ...(row.processed_ended_at ? { processedEndedAt: new Date(row.processed_ended_at).toISOString() } : {}),
    previousWatermarkJson: parseRecordPayload(
      row.previous_watermark_json,
      `processing watermark "${row.id}" previousWatermarkJson`,
    ),
    nextWatermarkJson: parseRecordPayload(row.next_watermark_json, `processing watermark "${row.id}" nextWatermarkJson`),
    status,
    reconciliationStatus,
    artifactsJson: parseRecordPayload(row.artifacts_json, `processing watermark "${row.id}" artifactsJson`),
    lastProcessedAt: new Date(row.last_processed_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function mapCandidateDecisionRow(row: PostgresCandidateDecisionRow): EpisodeCandidateDecision {
  const status = row.status as EpisodeCandidateDecisionStatus;
  if (!CANDIDATE_DECISION_STATUSES.has(status)) {
    throw new Error(`malformed persisted episode candidate "${row.id}": unsupported status`);
  }
  return {
    id: row.id,
    ...(row.candidate_episode_id ? { candidateEpisodeId: row.candidate_episode_id } : {}),
    ...(row.canonical_episode_id ? { canonicalEpisodeId: row.canonical_episode_id } : {}),
    ...(row.merged_into_episode_id ? { mergedIntoEpisodeId: row.merged_into_episode_id } : {}),
    ...(row.superseded_by_episode_id ? { supersededByEpisodeId: row.superseded_by_episode_id } : {}),
    ...(row.source_watermark_id ? { sourceWatermarkId: row.source_watermark_id } : {}),
    status,
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.started_at ? { startedAt: new Date(row.started_at).toISOString() } : {}),
    ...(row.ended_at ? { endedAt: new Date(row.ended_at).toISOString() } : {}),
    ...(row.overlap_score !== null ? { overlapScore: row.overlap_score } : {}),
    confidence: row.confidence,
    ...(row.reason ? { reason: row.reason } : {}),
    candidateJson: parseJsonPayload(row.candidate_json, `episode candidate "${row.id}" candidateJson`),
    artifactRefs: parseArrayPayload<EpisodeArtifactRef>(row.artifact_refs, `episode candidate "${row.id}" artifactRefs`),
    provenanceRefs: parseArrayPayload<EpisodeProvenanceRef>(
      row.provenance_refs,
      `episode candidate "${row.id}" provenanceRefs`,
    ),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function parseOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseRequiredText(value, field);
}

function normalizeUnit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

function normalizeOptionalUnit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  return normalizeUnit(value, field);
}

function normalizeWatermarkScope(scope: EpisodicProcessingWatermarkScope): EpisodicProcessingWatermarkScope {
  return {
    processor: parseRequiredText(scope.processor, 'processor'),
    sourceRef: parseRequiredText(scope.sourceRef, 'sourceRef'),
    ...(scope.channelId !== undefined ? { channelId: parseRequiredText(scope.channelId, 'channelId') } : {}),
    ...(scope.threadId !== undefined ? { threadId: parseRequiredText(scope.threadId, 'threadId') } : {}),
    ...(scope.sessionId !== undefined ? { sessionId: parseRequiredText(scope.sessionId, 'sessionId') } : {}),
  };
}

export class PostgresEpisodicStore implements EpisodicStorePort {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(pool: Pool, options: EpisodicStoreOptions = {}) {
    this.pool = pool;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async createEpisode(input: EpisodeCreateInput): Promise<Episode> {
    const now = this.now().toISOString();
    const episode = parseEpisode({
      ...input,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    await executeQuery(this.pool, `
      INSERT INTO l01_episodes (
        id,
        schema_version,
        title,
        landmark,
        status,
        canonical_episode_id,
        merged_into_episode_id,
        superseded_by_episode_id,
        thread_id,
        channel_id,
        started_at,
        ended_at,
        participant_contact_ids,
        salience_score,
        salience_json,
        affect_json,
        themes,
        artifact_refs,
        provenance_refs,
        scope_json,
        consent_flags,
        episode_json,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15::jsonb,$16::jsonb,
        $17::jsonb,$18::jsonb,$19::jsonb,$20::jsonb,$21::jsonb,$22::jsonb,$23,$24
      )
    `, [
      episode.id,
      episode.schemaVersion,
      episode.title,
      episode.landmark,
      'canonical',
      episode.id,
      null,
      null,
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      json(episode.participantContactIds),
      episode.salience.score,
      json(episode.salience),
      json(episode.affect),
      json(episode.themes),
      json(episode.artifactRefs),
      json(episode.provenanceRefs),
      json({}),
      json({}),
      serializeEpisode(episode),
      episode.createdAt,
      episode.updatedAt,
    ]);

    return episode;
  }

  async updateEpisode(input: EpisodeUpdateInput): Promise<Episode> {
    const current = await this.getEpisode(input.id);
    if (!current) {
      throw new Error(`episode "${input.id}" does not exist`);
    }

    const now = this.now().toISOString();
    const episode = parseEpisode({
      ...input,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      createdAt: current.createdAt,
      updatedAt: input.updatedAt ?? now,
    });

    await executeQuery(this.pool, `
      UPDATE l01_episodes
      SET
        schema_version = $2,
        title = $3,
        landmark = $4,
        status = $5,
        canonical_episode_id = $6,
        merged_into_episode_id = $7,
        superseded_by_episode_id = $8,
        thread_id = $9,
        channel_id = $10,
        started_at = $11,
        ended_at = $12,
        participant_contact_ids = $13::jsonb,
        salience_score = $14,
        salience_json = $15::jsonb,
        affect_json = $16::jsonb,
        themes = $17::jsonb,
        artifact_refs = $18::jsonb,
        provenance_refs = $19::jsonb,
        scope_json = $20::jsonb,
        consent_flags = $21::jsonb,
        episode_json = $22::jsonb,
        updated_at = $23
      WHERE id = $1
    `, [
      episode.id,
      episode.schemaVersion,
      episode.title,
      episode.landmark,
      'canonical',
      episode.id,
      null,
      null,
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      json(episode.participantContactIds),
      episode.salience.score,
      json(episode.salience),
      json(episode.affect),
      json(episode.themes),
      json(episode.artifactRefs),
      json(episode.provenanceRefs),
      json({}),
      json({}),
      serializeEpisode(episode),
      episode.updatedAt,
    ]);

    return episode;
  }

  async listEpisodes(options: EpisodeListOptions = {}): Promise<Episode[]> {
    const rows = await queryRows<PostgresEpisodeRow>(this.pool, `
      SELECT id, episode_json
      FROM l01_episodes
      WHERE ${ACTIVE_CANONICAL_EPISODE_FILTER}
      ORDER BY started_at ASC, id ASC
      LIMIT $1 OFFSET $2
    `, [
      normalizeLimit(options.limit),
      normalizeOffset(options.offset),
    ]);
    return rows.map(mapEpisodeRow);
  }

  async getEpisode(id: string): Promise<Episode | undefined> {
    const normalizedId = parseRequiredText(id, 'episode id');
    const row = await queryOne<PostgresEpisodeRow>(this.pool, `
      SELECT id, episode_json
      FROM l01_episodes
      WHERE id = $1
      LIMIT 1
    `, [normalizedId]);
    return row ? mapEpisodeRow(row) : undefined;
  }

  async searchByTime(options: EpisodeTimeSearchOptions = {}): Promise<Episode[]> {
    const from = normalizeInstant(options.from, 'from');
    const to = normalizeInstant(options.to, 'to');
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('from must be before or equal to to');
    }

    const where = [ACTIVE_CANONICAL_EPISODE_FILTER];
    const params: Array<string | number> = [];
    if (from !== undefined) {
      params.push(from);
      where.push(`ended_at >= $${params.length}`);
    }
    if (to !== undefined) {
      params.push(to);
      where.push(`started_at <= $${params.length}`);
    }
    params.push(normalizeLimit(options.limit));
    const limitIndex = params.length;
    params.push(normalizeOffset(options.offset));
    const offsetIndex = params.length;

    const rows = await queryRows<PostgresEpisodeRow>(this.pool, `
      SELECT id, episode_json
      FROM l01_episodes
      WHERE ${where.join(' AND ')}
      ORDER BY started_at ASC, id ASC
      LIMIT $${limitIndex} OFFSET $${offsetIndex}
    `, params);
    return rows.map(mapEpisodeRow);
  }

  async searchByThread(threadId: string, options: EpisodeListOptions = {}): Promise<Episode[]> {
    const normalizedThreadId = parseRequiredText(threadId, 'threadId');
    const rows = await queryRows<PostgresEpisodeRow>(this.pool, `
      SELECT id, episode_json
      FROM l01_episodes
      WHERE ${ACTIVE_CANONICAL_EPISODE_FILTER}
        AND thread_id = $1
      ORDER BY started_at ASC, id ASC
      LIMIT $2 OFFSET $3
    `, [
      normalizedThreadId,
      normalizeLimit(options.limit),
      normalizeOffset(options.offset),
    ]);
    return rows.map(mapEpisodeRow);
  }

  async writeEpisodeArc(input: EpisodeArcWriteInput): Promise<EpisodeArc> {
    await this.assertEpisodeExists(input.sourceEpisodeId, 'sourceEpisodeId');
    await this.assertEpisodeExists(input.targetEpisodeId, 'targetEpisodeId');

    const now = this.now().toISOString();
    const arc = parseEpisodeArc({
      ...input,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    await executeQuery(this.pool, `
      INSERT INTO l01_episode_arcs (
        id,
        schema_version,
        source_episode_id,
        target_episode_id,
        arc_kind,
        status,
        canonical_arc_id,
        merged_into_arc_id,
        superseded_by_arc_id,
        salience_score,
        confidence,
        themes,
        span_refs,
        artifact_refs,
        provenance_refs,
        arc_json,
        created_at,
        updated_at
      )
      VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13::jsonb,$14::jsonb,$15::jsonb,$16::jsonb,$17,$18
      )
      ON CONFLICT (id) DO UPDATE SET
        schema_version = EXCLUDED.schema_version,
        source_episode_id = EXCLUDED.source_episode_id,
        target_episode_id = EXCLUDED.target_episode_id,
        arc_kind = EXCLUDED.arc_kind,
        status = EXCLUDED.status,
        canonical_arc_id = EXCLUDED.canonical_arc_id,
        merged_into_arc_id = EXCLUDED.merged_into_arc_id,
        superseded_by_arc_id = EXCLUDED.superseded_by_arc_id,
        salience_score = EXCLUDED.salience_score,
        confidence = EXCLUDED.confidence,
        themes = EXCLUDED.themes,
        span_refs = EXCLUDED.span_refs,
        artifact_refs = EXCLUDED.artifact_refs,
        provenance_refs = EXCLUDED.provenance_refs,
        arc_json = EXCLUDED.arc_json,
        updated_at = EXCLUDED.updated_at
    `, [
      arc.id,
      arc.schemaVersion,
      arc.sourceEpisodeId,
      arc.targetEpisodeId,
      arc.arcKind,
      'canonical',
      arc.id,
      null,
      null,
      arc.salience,
      arc.confidence,
      json(arc.themes),
      json(arc.spanRefs),
      json(arc.artifactRefs),
      json(arc.provenanceRefs),
      serializeEpisodeArc(arc),
      arc.createdAt,
      arc.updatedAt,
    ]);

    return arc;
  }

  async listEpisodeArcsForEpisode(
    episodeId: string,
    options: EpisodeArcListOptions = {},
  ): Promise<EpisodeArc[]> {
    const normalizedEpisodeId = parseRequiredText(episodeId, 'episodeId');
    const direction = options.direction ?? 'both';

    const where = [ACTIVE_CANONICAL_ARC_FILTER];
    const params: Array<string | number> = [];
    if (direction === 'incoming') {
      params.push(normalizedEpisodeId);
      where.push(`target_episode_id = $${params.length}`);
    } else if (direction === 'outgoing') {
      params.push(normalizedEpisodeId);
      where.push(`source_episode_id = $${params.length}`);
    } else {
      params.push(normalizedEpisodeId, normalizedEpisodeId);
      where.push(`(source_episode_id = $${params.length - 1} OR target_episode_id = $${params.length})`);
    }

    if (options.arcKind !== undefined) {
      params.push(options.arcKind);
      where.push(`arc_kind = $${params.length}`);
    }
    params.push(normalizeLimit(options.limit));
    const limitIndex = params.length;

    const rows = await queryRows<PostgresEpisodeArcRow>(this.pool, `
      SELECT id, arc_json
      FROM l01_episode_arcs
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id ASC
      LIMIT $${limitIndex}
    `, params);
    return rows.map(mapArcRow);
  }

  async getProcessingWatermark(
    scope: EpisodicProcessingWatermarkScope,
  ): Promise<EpisodicProcessingWatermark | undefined> {
    const normalized = normalizeWatermarkScope(scope);
    const row = await queryOne<PostgresProcessingWatermarkRow>(this.pool, `
      SELECT *
      FROM l01_processing_watermarks
      WHERE processor = $1
        AND source_ref = $2
        AND COALESCE(channel_id, '') = $3
        AND COALESCE(thread_id, '') = $4
        AND COALESCE(session_id, '') = $5
      LIMIT 1
    `, [
      normalized.processor,
      normalized.sourceRef,
      normalized.channelId ?? '',
      normalized.threadId ?? '',
      normalized.sessionId ?? '',
    ]);
    return row ? mapWatermarkRow(row) : undefined;
  }

  async upsertProcessingWatermark(
    input: EpisodicProcessingWatermarkWriteInput,
  ): Promise<EpisodicProcessingWatermark> {
    const scope = normalizeWatermarkScope(input);
    const now = this.now().toISOString();
    const highWaterTurnId = parseOptionalText(input.highWaterTurnId, 'highWaterTurnId');
    const highWaterMessageId = parseOptionalText(input.highWaterMessageId, 'highWaterMessageId');
    const processedStartedAt = normalizeInstant(input.processedStartedAt, 'processedStartedAt');
    const processedEndedAt = normalizeInstant(input.processedEndedAt, 'processedEndedAt');
    const watermark: EpisodicProcessingWatermark = {
      ...scope,
      id: input.id ?? this.idFactory(),
      ...(highWaterTurnId ? { highWaterTurnId } : {}),
      ...(highWaterMessageId ? { highWaterMessageId } : {}),
      ...(processedStartedAt ? { processedStartedAt } : {}),
      ...(processedEndedAt ? { processedEndedAt } : {}),
      previousWatermarkJson: input.previousWatermarkJson ?? {},
      nextWatermarkJson: input.nextWatermarkJson ?? {},
      status: input.status ?? 'active',
      reconciliationStatus: input.reconciliationStatus ?? 'pending',
      artifactsJson: input.artifactsJson ?? {},
      lastProcessedAt: normalizeInstant(input.lastProcessedAt, 'lastProcessedAt') ?? now,
      updatedAt: normalizeInstant(input.updatedAt, 'updatedAt') ?? now,
    };
    if (!WATERMARK_STATUSES.has(watermark.status)) {
      throw new Error(`watermark status is not supported: ${watermark.status}`);
    }
    if (!RECONCILIATION_STATUSES.has(watermark.reconciliationStatus)) {
      throw new Error(`watermark reconciliationStatus is not supported: ${watermark.reconciliationStatus}`);
    }

    await executeQuery(this.pool, `
      INSERT INTO l01_processing_watermarks (
        id,
        processor,
        channel_id,
        thread_id,
        session_id,
        source_ref,
        high_water_turn_id,
        high_water_message_id,
        processed_started_at,
        processed_ended_at,
        previous_watermark_json,
        next_watermark_json,
        status,
        reconciliation_status,
        artifacts_json,
        last_processed_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14,$15::jsonb,$16,$17)
      ON CONFLICT (id) DO UPDATE SET
        processor = EXCLUDED.processor,
        channel_id = EXCLUDED.channel_id,
        thread_id = EXCLUDED.thread_id,
        session_id = EXCLUDED.session_id,
        source_ref = EXCLUDED.source_ref,
        high_water_turn_id = EXCLUDED.high_water_turn_id,
        high_water_message_id = EXCLUDED.high_water_message_id,
        processed_started_at = EXCLUDED.processed_started_at,
        processed_ended_at = EXCLUDED.processed_ended_at,
        previous_watermark_json = EXCLUDED.previous_watermark_json,
        next_watermark_json = EXCLUDED.next_watermark_json,
        status = EXCLUDED.status,
        reconciliation_status = EXCLUDED.reconciliation_status,
        artifacts_json = EXCLUDED.artifacts_json,
        last_processed_at = EXCLUDED.last_processed_at,
        updated_at = EXCLUDED.updated_at
    `, [
      watermark.id,
      watermark.processor,
      watermark.channelId ?? null,
      watermark.threadId ?? null,
      watermark.sessionId ?? null,
      watermark.sourceRef,
      watermark.highWaterTurnId ?? null,
      watermark.highWaterMessageId ?? null,
      watermark.processedStartedAt ?? null,
      watermark.processedEndedAt ?? null,
      json(watermark.previousWatermarkJson),
      json(watermark.nextWatermarkJson),
      watermark.status,
      watermark.reconciliationStatus,
      json(watermark.artifactsJson),
      watermark.lastProcessedAt,
      watermark.updatedAt,
    ]);

    return watermark;
  }

  async writeEpisodeCandidateDecision(input: EpisodeCandidateDecisionWriteInput): Promise<EpisodeCandidateDecision> {
    const now = this.now().toISOString();
    const startedAt = normalizeInstant(input.startedAt, 'startedAt');
    const endedAt = normalizeInstant(input.endedAt, 'endedAt');
    const overlapScore = normalizeOptionalUnit(input.overlapScore, 'overlapScore');
    const decision: EpisodeCandidateDecision = {
      id: input.id ?? this.idFactory(),
      ...(parseOptionalText(input.candidateEpisodeId, 'candidateEpisodeId') ? { candidateEpisodeId: parseRequiredText(input.candidateEpisodeId ?? '', 'candidateEpisodeId') } : {}),
      ...(parseOptionalText(input.canonicalEpisodeId, 'canonicalEpisodeId') ? { canonicalEpisodeId: parseRequiredText(input.canonicalEpisodeId ?? '', 'canonicalEpisodeId') } : {}),
      ...(parseOptionalText(input.mergedIntoEpisodeId, 'mergedIntoEpisodeId') ? { mergedIntoEpisodeId: parseRequiredText(input.mergedIntoEpisodeId ?? '', 'mergedIntoEpisodeId') } : {}),
      ...(parseOptionalText(input.supersededByEpisodeId, 'supersededByEpisodeId') ? { supersededByEpisodeId: parseRequiredText(input.supersededByEpisodeId ?? '', 'supersededByEpisodeId') } : {}),
      ...(parseOptionalText(input.sourceWatermarkId, 'sourceWatermarkId') ? { sourceWatermarkId: parseRequiredText(input.sourceWatermarkId ?? '', 'sourceWatermarkId') } : {}),
      status: input.status,
      ...(parseOptionalText(input.channelId, 'channelId') ? { channelId: parseRequiredText(input.channelId ?? '', 'channelId') } : {}),
      ...(parseOptionalText(input.threadId, 'threadId') ? { threadId: parseRequiredText(input.threadId ?? '', 'threadId') } : {}),
      ...(parseOptionalText(input.sessionId, 'sessionId') ? { sessionId: parseRequiredText(input.sessionId ?? '', 'sessionId') } : {}),
      ...(startedAt ? { startedAt } : {}),
      ...(endedAt ? { endedAt } : {}),
      ...(overlapScore !== undefined ? { overlapScore } : {}),
      confidence: normalizeUnit(input.confidence, 'confidence'),
      ...(parseOptionalText(input.reason, 'reason') ? { reason: parseRequiredText(input.reason ?? '', 'reason') } : {}),
      candidateJson: input.candidateJson,
      artifactRefs: input.artifactRefs,
      provenanceRefs: input.provenanceRefs,
      createdAt: normalizeInstant(input.createdAt, 'createdAt') ?? now,
      updatedAt: normalizeInstant(input.updatedAt, 'updatedAt') ?? input.createdAt ?? now,
    };
    if (!CANDIDATE_DECISION_STATUSES.has(decision.status)) {
      throw new Error(`episode candidate status is not supported: ${decision.status}`);
    }

    await executeQuery(this.pool, `
      INSERT INTO l01_episode_candidates (
        id,
        candidate_episode_id,
        canonical_episode_id,
        merged_into_episode_id,
        superseded_by_episode_id,
        source_watermark_id,
        status,
        channel_id,
        thread_id,
        session_id,
        started_at,
        ended_at,
        overlap_score,
        confidence,
        reason,
        candidate_json,
        artifact_refs,
        provenance_refs,
        created_at,
        updated_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb,$17::jsonb,$18::jsonb,$19,$20)
      ON CONFLICT (id) DO UPDATE SET
        candidate_episode_id = EXCLUDED.candidate_episode_id,
        canonical_episode_id = EXCLUDED.canonical_episode_id,
        merged_into_episode_id = EXCLUDED.merged_into_episode_id,
        superseded_by_episode_id = EXCLUDED.superseded_by_episode_id,
        source_watermark_id = EXCLUDED.source_watermark_id,
        status = EXCLUDED.status,
        channel_id = EXCLUDED.channel_id,
        thread_id = EXCLUDED.thread_id,
        session_id = EXCLUDED.session_id,
        started_at = EXCLUDED.started_at,
        ended_at = EXCLUDED.ended_at,
        overlap_score = EXCLUDED.overlap_score,
        confidence = EXCLUDED.confidence,
        reason = EXCLUDED.reason,
        candidate_json = EXCLUDED.candidate_json,
        artifact_refs = EXCLUDED.artifact_refs,
        provenance_refs = EXCLUDED.provenance_refs,
        updated_at = EXCLUDED.updated_at
    `, [
      decision.id,
      decision.candidateEpisodeId ?? null,
      decision.canonicalEpisodeId ?? null,
      decision.mergedIntoEpisodeId ?? null,
      decision.supersededByEpisodeId ?? null,
      decision.sourceWatermarkId ?? null,
      decision.status,
      decision.channelId ?? null,
      decision.threadId ?? null,
      decision.sessionId ?? null,
      decision.startedAt ?? null,
      decision.endedAt ?? null,
      decision.overlapScore ?? null,
      decision.confidence,
      decision.reason ?? null,
      json(decision.candidateJson),
      json(decision.artifactRefs),
      json(decision.provenanceRefs),
      decision.createdAt,
      decision.updatedAt,
    ]);

    return decision;
  }

  async listEpisodeCandidateDecisions(
    options: EpisodeCandidateDecisionListOptions = {},
  ): Promise<EpisodeCandidateDecision[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.sourceWatermarkId !== undefined) {
      params.push(parseRequiredText(options.sourceWatermarkId, 'sourceWatermarkId'));
      where.push(`source_watermark_id = $${params.length}`);
    }
    if (options.canonicalEpisodeId !== undefined) {
      params.push(parseRequiredText(options.canonicalEpisodeId, 'canonicalEpisodeId'));
      where.push(`canonical_episode_id = $${params.length}`);
    }
    params.push(normalizeLimit(options.limit));
    const limitIndex = params.length;
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await queryRows<PostgresCandidateDecisionRow>(this.pool, `
      SELECT *
      FROM l01_episode_candidates
      ${whereClause}
      ORDER BY created_at ASC, id ASC
      LIMIT $${limitIndex}
    `, params);
    return rows.map(mapCandidateDecisionRow);
  }

  async writeEpisodeLineage(input: EpisodeLineageWriteInput): Promise<EpisodeLineage> {
    await this.assertEpisodeExists(input.sourceEpisodeId, 'lineage.sourceEpisodeId');
    await this.assertEpisodeExists(input.targetEpisodeId, 'lineage.targetEpisodeId');
    if (input.sourceEpisodeId === input.targetEpisodeId) {
      throw new Error('episode lineage source and target must differ');
    }
    if (!EPISODE_LINEAGE_RELATIONS.has(input.relation)) {
      throw new Error(`episode lineage relation is not supported: ${input.relation}`);
    }

    const now = this.now().toISOString();
    const lineage: EpisodeLineage = {
      id: input.id ?? this.idFactory(),
      sourceEpisodeId: parseRequiredText(input.sourceEpisodeId, 'sourceEpisodeId'),
      targetEpisodeId: parseRequiredText(input.targetEpisodeId, 'targetEpisodeId'),
      relation: input.relation,
      confidence: normalizeUnit(input.confidence, 'confidence'),
      ...(parseOptionalText(input.reason, 'reason') ? { reason: parseRequiredText(input.reason ?? '', 'reason') } : {}),
      ...(parseOptionalText(input.sourceRef, 'sourceRef') ? { sourceRef: parseRequiredText(input.sourceRef ?? '', 'sourceRef') } : {}),
      provenanceRefs: input.provenanceRefs,
      lineageJson: input.lineageJson,
      createdAt: normalizeInstant(input.createdAt, 'createdAt') ?? now,
    };

    await executeQuery(this.pool, `
      INSERT INTO l01_episode_lineage (
        id,
        source_episode_id,
        target_episode_id,
        relation,
        confidence,
        reason,
        source_ref,
        provenance_refs,
        lineage_json,
        created_at
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)
      ON CONFLICT (id) DO UPDATE SET
        source_episode_id = EXCLUDED.source_episode_id,
        target_episode_id = EXCLUDED.target_episode_id,
        relation = EXCLUDED.relation,
        confidence = EXCLUDED.confidence,
        reason = EXCLUDED.reason,
        source_ref = EXCLUDED.source_ref,
        provenance_refs = EXCLUDED.provenance_refs,
        lineage_json = EXCLUDED.lineage_json,
        created_at = EXCLUDED.created_at
    `, [
      lineage.id,
      lineage.sourceEpisodeId,
      lineage.targetEpisodeId,
      lineage.relation,
      lineage.confidence,
      lineage.reason ?? null,
      lineage.sourceRef ?? null,
      json(lineage.provenanceRefs),
      json(lineage.lineageJson),
      lineage.createdAt,
    ]);

    return lineage;
  }

  async getMaintenanceDiagnostics(
    options: EpisodicMaintenanceDiagnosticsOptions = {},
  ): Promise<EpisodicMaintenanceDiagnostics> {
    const [decisions, watermarkRows] = await Promise.all([
      this.listEpisodeCandidateDecisions({ limit: MAX_LIMIT }),
      queryRows<PostgresProcessingWatermarkRow>(this.pool, `
        SELECT *
        FROM l01_processing_watermarks
        ORDER BY updated_at ASC, id ASC
        LIMIT $1
      `, [MAX_LIMIT]),
    ]);
    return summarizeEpisodicMaintenanceDiagnostics({
      decisions,
      watermarks: watermarkRows.map(mapWatermarkRow),
      now: normalizeEpisodicDiagnosticsNow(options.now),
    });
  }

  private async assertEpisodeExists(id: string, field: string): Promise<void> {
    const normalizedId = parseRequiredText(id, `episodeArc.${field}`);
    const row = await queryOne<{ id: string }>(this.pool, `
      SELECT id
      FROM l01_episodes
      WHERE id = $1
      LIMIT 1
    `, [normalizedId]);
    if (!row) {
      throw new Error(`episodeArc.${field} references unknown episode "${normalizedId}"`);
    }
  }
}
