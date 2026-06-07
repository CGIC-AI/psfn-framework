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
} from '../../../shared/contracts/episodic-memory.js';
import type {
  EpisodeArcListOptions,
  EpisodeArcWriteInput,
  EpisodeCreateInput,
  EpisodeListOptions,
  EpisodeTimeSearchOptions,
  EpisodeUpdateInput,
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

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1000;
const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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

function json(value: unknown): string {
  return JSON.stringify(value);
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
