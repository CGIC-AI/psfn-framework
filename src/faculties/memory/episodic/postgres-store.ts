import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  createPostgresPool,
  executeQuery,
  queryOne,
  queryRows,
  withPostgresClient,
} from '../../../persistence/postgres.js';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisodeArc,
  serializeEpisodeArc,
  type Episode,
  type EpisodeArc,
} from '../../../shared/contracts/episodic-memory.js';
import {
  normalizeEpisodeArcMutationAudit,
  normalizeEpisodeClaimTransferInput,
  normalizeEpisodeLifecycleStatus,
  normalizeEpisodeMessageClaimWriteInput,
  normalizeEpisodicDiagnosticsNow,
  summarizeEpisodicMaintenanceDiagnostics,
} from './store-port.js';
import type {
  EpisodeArcAuditAction,
  EpisodeArcAuditEntry,
  EpisodeArcAuditListOptions,
  EpisodeArcListOptions,
  EpisodeArcMutationAudit,
  EpisodeArcRemoveInput,
  EpisodeArcRepointInput,
  EpisodeArcRepointResult,
  EpisodeArcWriteInput,
  EpisodeCandidateDecision,
  EpisodeCandidateDecisionListOptions,
  EpisodeCandidateDecisionWriteInput,
  EpisodeClaimTransferInput,
  EpisodeClaimTransferResult,
  CompanionAuthoredEpisodeCreateInput,
  CompanionAuthoredEpisodeUpdateInput,
  CompanionAuthoredEpisodicStorePort,
  EpisodeCreateInput,
  EpisodeFirstPersonAuthorship,
  EpisodeEmbeddingRuntimeStorePort,
  EpisodeEmbeddingIndexerAttachOptions,
  EpisodeEmbeddingLiveIndexerPort,
  EpisodeEmbeddingTarget,
  EpisodeEmbeddingTargetListInput,
  EpisodeEmbeddingFailureInput,
  EpisodeEmbeddingIndexHealth,
  EpisodeEmbeddingProfile,
  EpisodeEmbeddingWriteInput,
  EpisodeSemanticCandidate,
  EpisodeSemanticSearchInput,
  EpisodeLineage,
  EpisodeLineageWriteInput,
  EpisodeMessageClaim,
  EpisodeMessageClaimListOptions,
  EpisodeMessageClaimWriteInput,
  EpisodicMaintenanceDiagnostics,
  EpisodicMaintenanceDiagnosticsOptions,
  EpisodeListOptions,
  EpisodeTimeSearchOptions,
  EpisodeUpdateInput,
  FirstPersonPreservingEpisodeCreateInput,
  FirstPersonPreservingEpisodeUpdateInput,
  FirstPersonPreservingEpisodicStorePort,
  EpisodicProcessingWatermark,
  EpisodicProcessingWatermarkHealthSummary,
  EpisodicProcessingWatermarkScope,
  EpisodicProcessingWatermarkWriteInput,
  EpisodicStoreOptions,
  EpisodicStorePort,
  RepointThreadMembersInput,
  RepointThreadMembersResult,
} from './store-port.js';
import {
  CANDIDATE_DECISION_STATUSES,
  ACTIVE_CANONICAL_ARC_FILTER,
  ACTIVE_CANONICAL_EPISODE_FILTER,
  EPISODE_LINEAGE_RELATIONS,
  MAX_LIMIT,
  MESSAGE_CLAIM_STATUSES,
  mapArcAuditRow,
  mapArcRow,
  mapCandidateDecisionRow,
  mapEpisodeRow,
  mapMessageClaimRow,
  mapWatermarkRow,
  isActivePostgresArcRow,
  json,
  normalizeInstant,
  normalizeLimit,
  normalizeOffset,
  normalizeRequiredTextList,
  normalizeUnit,
  normalizeOptionalUnit,
  normalizeWatermarkScope,
  parseArcJson,
  parseOptionalText,
  parseRequiredText,
  RECONCILIATION_STATUSES,
  WATERMARK_STATUSES,
  type PostgresCandidateDecisionRow,
  type PostgresEpisodeArcAuditRow,
  type PostgresEpisodeArcRow,
  type PostgresEpisodeArcStateRow,
  type PostgresEpisodeMessageClaimRow,
  type PostgresEpisodeRow,
  type PostgresProcessingWatermarkRow,
} from './postgres-store/rows.js';
import { PostgresEpisodeFirstPersonWriter } from './postgres-store/first-person-writer.js';
import { PostgresEpisodeEmbeddingIndex } from './postgres-store/embedding-index.js';

const log = createComponentLogger('PostgresEpisodicStore');

type PostgresProcessingWatermarkHealthRow = PostgresProcessingWatermarkRow & {
  scope_count: number | string;
  blocked_scope_count: number | string;
};

function parseWatermarkHealthCount(value: number | string, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`Episodic watermark health ${field} must be a non-negative integer`);
  }
  return parsed;
}

export function createPostgresEpisodicStore(
  databaseUrl: string,
  options: EpisodicStoreOptions = {},
): PostgresEpisodicStore {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-episodic-memory',
    allowExitOnIdle: true,
    schema: options.schema,
    role: options.role,
  });
  return createPostgresEpisodicStoreFromPool(pool, options);
}

export function createPostgresEpisodicStoreFromPool(
  pool: Pool,
  options: EpisodicStoreOptions = {},
): PostgresEpisodicStore {
  return new PostgresEpisodicStore(pool, options);
}

export class PostgresEpisodicStore implements
  EpisodicStorePort,
  EpisodeEmbeddingRuntimeStorePort,
  CompanionAuthoredEpisodicStorePort,
  FirstPersonPreservingEpisodicStorePort {
  private readonly pool: Pool;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly firstPersonWriter: PostgresEpisodeFirstPersonWriter;
  private readonly embeddingIndex: PostgresEpisodeEmbeddingIndex;
  private episodeEmbeddingIndexer?: {
    indexer: EpisodeEmbeddingLiveIndexerPort;
    options: EpisodeEmbeddingIndexerAttachOptions;
  };

  constructor(pool: Pool, options: EpisodicStoreOptions = {}) {
    this.pool = pool;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.firstPersonWriter = new PostgresEpisodeFirstPersonWriter(
      pool,
      this.now,
      this.idFactory,
    );
    this.embeddingIndex = new PostgresEpisodeEmbeddingIndex(pool);
  }

  async createEpisode(input: EpisodeCreateInput): Promise<Episode> {
    const episode = await this.firstPersonWriter.createMachineEpisode(input);
    this.scheduleEpisodeEmbeddingIndex(episode);
    return episode;
  }

  async createEpisodePreservingFirstPersonFields(
    input: FirstPersonPreservingEpisodeCreateInput,
  ): Promise<Episode> {
    const { firstPersonFieldSources, ...episodeInput } = input;
    const episode = await this.firstPersonWriter.createMachineEpisode(
      episodeInput,
      firstPersonFieldSources,
    );
    this.scheduleEpisodeEmbeddingIndex(episode);
    return episode;
  }

  async createCompanionAuthoredEpisode(
    input: CompanionAuthoredEpisodeCreateInput,
  ): Promise<Episode> {
    const episode = await this.firstPersonWriter.createCompanionEpisode(input);
    this.scheduleEpisodeEmbeddingIndex(episode);
    return episode;
  }

  async updateEpisode(input: EpisodeUpdateInput): Promise<Episode> {
    const episode = await this.firstPersonWriter.updateMachineEpisode(input);
    this.scheduleEpisodeEmbeddingIndex(episode);
    return episode;
  }

  async updateEpisodePreservingFirstPersonFields(
    input: FirstPersonPreservingEpisodeUpdateInput,
  ): Promise<Episode> {
    const { firstPersonFieldSources, ...episodeInput } = input;
    const episode = await this.firstPersonWriter.updateMachineEpisode(
      episodeInput,
      firstPersonFieldSources,
    );
    this.scheduleEpisodeEmbeddingIndex(episode);
    return episode;
  }

  async updateCompanionAuthoredEpisode(
    input: CompanionAuthoredEpisodeUpdateInput,
  ): Promise<Episode> {
    const episode = await this.firstPersonWriter.updateCompanionEpisode(input);
    this.scheduleEpisodeEmbeddingIndex(episode);
    return episode;
  }

  attachEpisodeEmbeddingIndexer(
    indexer: EpisodeEmbeddingLiveIndexerPort,
    options: EpisodeEmbeddingIndexerAttachOptions = {},
  ): void {
    if (this.episodeEmbeddingIndexer) {
      throw new Error('episode embedding indexer is already attached');
    }
    this.episodeEmbeddingIndexer = { indexer, options };
  }

  private scheduleEpisodeEmbeddingIndex(episode: Episode): void {
    const attached = this.episodeEmbeddingIndexer;
    if (!attached) return;
    void attached.indexer.indexEpisode(episode).then((result) => {
      attached.options.onResult?.(result);
    }).catch((error: unknown) => {
      if (attached.options.onError) {
        attached.options.onError(error, episode);
        return;
      }
      log.error('Live episode embedding index attempt failed', {
        episodeId: episode.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  async markEpisodeMerged(episodeId: string, mergedIntoEpisodeId: string): Promise<void> {
    const sourceId = parseRequiredText(episodeId, 'episode id');
    const targetId = parseRequiredText(mergedIntoEpisodeId, 'merged-into episode id');
    if (sourceId === targetId) {
      throw new Error('an episode cannot be merged into itself');
    }
    const target = await this.getEpisode(targetId);
    if (!target) {
      throw new Error(`merge target episode "${targetId}" does not exist`);
    }
    const nowIso = this.now().toISOString();
    await withPostgresClient(this.pool, async (client) => {
      const result = await client.query(`
        UPDATE l01_episodes
        SET status = 'merged', merged_into_episode_id = $2, updated_at = $3
        WHERE id = $1
      `, [sourceId, targetId, nowIso]);
      if (result.rowCount === 0) {
        throw new Error(`episode "${sourceId}" does not exist`);
      }
      // A merged-away episode is no longer live; its arc memberships follow
      // it onto the merge target instead of dangling.
      await this.repointArcsForEpisode(client, sourceId, targetId, {
        actor: 'consolidation_repoint',
        reason: `episode "${sourceId}" merged into "${targetId}"`,
      }, nowIso);
    });
  }

  /**
   * Sleep-cycle confirmation: candidate -> canonical. Fails closed for
   * unknown or non-live episodes; idempotent when already canonical.
   */
  async confirmEpisodeCanonical(episodeId: string): Promise<void> {
    const normalizedId = parseRequiredText(episodeId, 'episode id');
    const confirmedAt = this.now().toISOString();
    const result = await executeQuery(this.pool, `
      UPDATE l01_episodes
      SET status = 'canonical',
          episode_json = jsonb_set(
            episode_json,
            '{updatedAt}',
            to_jsonb($2::text),
            true
          ),
          embedding_source_updated_at = CASE
            WHEN embedding_source_updated_at = updated_at THEN $2::timestamptz
            ELSE embedding_source_updated_at
          END,
          updated_at = $2::timestamptz
      WHERE id = $1
        AND merged_into_episode_id IS NULL
        AND superseded_by_episode_id IS NULL
    `, [normalizedId, confirmedAt]);
    if (result.rowCount === 0) {
      if (!(await this.getEpisode(normalizedId))) {
        throw new Error(`episode "${normalizedId}" does not exist`);
      }
      throw new Error(`episode "${normalizedId}" is no longer live and cannot be confirmed canonical`);
    }
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

  async listEpisodeEmbeddingTargets(
    input: EpisodeEmbeddingTargetListInput,
  ): Promise<EpisodeEmbeddingTarget[]> {
    return await this.embeddingIndex.listEpisodeEmbeddingTargets(input);
  }

  async writeEpisodeEmbedding(input: EpisodeEmbeddingWriteInput): Promise<boolean> {
    return await this.embeddingIndex.writeEpisodeEmbedding(input);
  }

  async recordEpisodeEmbeddingFailure(input: EpisodeEmbeddingFailureInput): Promise<boolean> {
    return await this.embeddingIndex.recordEpisodeEmbeddingFailure(input);
  }

  async searchEpisodesByEmbedding(
    input: EpisodeSemanticSearchInput,
  ): Promise<EpisodeSemanticCandidate[]> {
    return await this.embeddingIndex.searchEpisodesByEmbedding(input);
  }

  async getEpisodeEmbeddingIndexHealth(
    inputProfile: EpisodeEmbeddingProfile,
  ): Promise<EpisodeEmbeddingIndexHealth> {
    return await this.embeddingIndex.getEpisodeEmbeddingIndexHealth(inputProfile);
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

  async getEpisodeFirstPersonAuthorship(
    id: string,
  ): Promise<EpisodeFirstPersonAuthorship | undefined> {
    return await this.firstPersonWriter.getAuthorship(id);
  }

  async getEpisodesByIds(ids: readonly string[]): Promise<Episode[]> {
    const normalizedIds = normalizeRequiredTextList(ids, 'episode id');
    if (normalizedIds.length === 0) return [];

    const rows = await queryRows<PostgresEpisodeRow>(this.pool, `
      SELECT id, episode_json
      FROM l01_episodes
      WHERE id = ANY($1::text[])
    `, [normalizedIds]);
    const byId = new Map(rows.map(row => [row.id, mapEpisodeRow(row)]));
    return normalizedIds.flatMap((id) => {
      const episode = byId.get(id);
      return episode ? [episode] : [];
    });
  }

  async searchByTime(options: EpisodeTimeSearchOptions = {}): Promise<Episode[]> {
    const from = normalizeInstant(options.from, 'from');
    const to = normalizeInstant(options.to, 'to');
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('from must be before or equal to to');
    }

    const where = [ACTIVE_CANONICAL_EPISODE_FILTER];
    const params: Array<string | number> = [];
    if (options.lifecycleStatus !== undefined) {
      const lifecycleStatus = normalizeEpisodeLifecycleStatus(options.lifecycleStatus);
      where.push(lifecycleStatus === 'candidate'
        ? "status = 'candidate'"
        : "(status IS NULL OR status = 'canonical')");
    }
    if (from !== undefined) {
      params.push(from);
      where.push(`ended_at >= $${params.length}`);
    }
    if (to !== undefined) {
      params.push(to);
      where.push(`started_at <= $${params.length}`);
    }
    if (options.spanSessionId !== undefined) {
      // Real session scope (apq0). An episode's session identity lives in its
      // span refs (episode_json.spanRefs[].sessionId), NOT thread_id — since
      // apq0 thread_id is a topic-thread id (arc connected-component
      // representative), decoupled from the session. Match any episode carrying
      // a span in this session via jsonb containment, served by the existing
      // episode_json GIN index (idx_l01_episodes_episode_json_gin).
      params.push(json({
        spanRefs: [{ sessionId: parseRequiredText(options.spanSessionId, 'spanSessionId') }],
      }));
      where.push(`episode_json @> $${params.length}::jsonb`);
    }
    params.push(normalizeLimit(options.limit));
    const limitIndex = params.length;
    params.push(normalizeOffset(options.offset));
    const offsetIndex = params.length;

    const orderDir = options.order === 'desc' ? 'DESC' : 'ASC';
    const rows = await queryRows<PostgresEpisodeRow>(this.pool, `
      SELECT id, episode_json
      FROM l01_episodes
      WHERE ${where.join(' AND ')}
      ORDER BY started_at ${orderDir}, id ${orderDir}
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

  async repointThreadMembers(input: RepointThreadMembersInput): Promise<RepointThreadMembersResult> {
    const fromThreadId = parseRequiredText(input.fromThreadId, 'repointThreadMembers.fromThreadId');
    const toThreadId = parseRequiredText(input.toThreadId, 'repointThreadMembers.toThreadId');
    if (!Number.isInteger(input.maxEpisodes) || input.maxEpisodes < 1) {
      throw new Error('repointThreadMembers requires a positive integer maxEpisodes');
    }
    if (input.memberEpisodeIds !== undefined && input.memberEpisodeIds.length === 0) {
      throw new Error('repointThreadMembers memberEpisodeIds must be non-empty when provided');
    }
    const memberEpisodeIds = input.memberEpisodeIds?.map(
      (id, index) => parseRequiredText(id, `repointThreadMembers.memberEpisodeIds[${String(index)}]`),
    );
    if (fromThreadId === toThreadId && memberEpisodeIds === undefined) {
      throw new Error('thread members cannot be re-pointed onto the same thread');
    }
    const nowIso = this.now().toISOString();

    return withPostgresClient(this.pool, async (client) => {
      // Lock the losing thread's live members and detect oversize in one shot:
      // fetching one row past the cap lets us refuse without a separate count.
      // With memberEpisodeIds the scan is further restricted to those specific
      // members (apq0 legacy extraction) — the rest of the bucket is untouched.
      const memberFilter = memberEpisodeIds ? ' AND id = ANY($3::text[])' : '';
      const memberParams: unknown[] = [fromThreadId, input.maxEpisodes + 1];
      if (memberEpisodeIds) memberParams.push(memberEpisodeIds);
      const members = (await client.query<{ id: string }>(`
        SELECT id
        FROM l01_episodes
        WHERE (thread_id = $1 OR (thread_id IS NULL AND id = $1))
          AND ${ACTIVE_CANONICAL_EPISODE_FILTER}${memberFilter}
        ORDER BY started_at ASC, id ASC
        LIMIT $2
        FOR UPDATE
      `, memberParams)).rows;

      if (members.length > input.maxEpisodes) {
        return { updatedEpisodeIds: [], skippedOversize: true };
      }
      if (members.length === 0) {
        return { updatedEpisodeIds: [], skippedOversize: false };
      }

      const ids = members.map(row => row.id);
      // One naturally-atomic statement re-points every locked member and keeps
      // the materialized episode_json.threadId consistent with the thread_id
      // column. There is no per-row loop, so a crash cannot leave the thread
      // half-split: the whole re-point commits or rolls back together.
      await client.query(`
        UPDATE l01_episodes
        SET thread_id = $2,
            episode_json = jsonb_set(
              jsonb_set(episode_json, '{threadId}', to_jsonb($2::text), true),
              '{updatedAt}', to_jsonb($3::text), true
            ),
            updated_at = $3::timestamptz
        WHERE id = ANY($1::text[])
      `, [ids, toThreadId, nowIso]);

      return { updatedEpisodeIds: ids, skippedOversize: false };
    });
  }

  async writeEpisodeArc(input: EpisodeArcWriteInput): Promise<EpisodeArc> {
    await this.assertEpisodeExists(input.sourceEpisodeId, 'episodeArc.sourceEpisodeId');
    await this.assertEpisodeExists(input.targetEpisodeId, 'episodeArc.targetEpisodeId');
    const audit = input.audit
      ? normalizeEpisodeArcMutationAudit(input.audit, 'episodeArc.audit')
      : undefined;

    const now = this.now().toISOString();
    const { audit: _audit, ...arcFields } = input;
    const arc = parseEpisodeArc({
      ...arcFields,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    await withPostgresClient(this.pool, async (client) => {
      await client.query(`
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
      if (audit) {
        await this.insertArcAudit(client, arc.id, 'written', audit, {
          sourceEpisodeId: arc.sourceEpisodeId,
          targetEpisodeId: arc.targetEpisodeId,
          arcKind: arc.arcKind,
          themes: arc.themes,
          confidence: arc.confidence,
        }, now);
      }
    });

    return arc;
  }

  /**
   * Retires one active arc; the row and its audit history are kept forever.
   */
  async removeEpisodeArc(input: EpisodeArcRemoveInput): Promise<void> {
    const arcId = parseRequiredText(input.arcId, 'removeEpisodeArc.arcId');
    const audit = normalizeEpisodeArcMutationAudit(input, 'removeEpisodeArc');
    const nowIso = this.now().toISOString();

    await withPostgresClient(this.pool, async (client) => {
      const result = await client.query<PostgresEpisodeArcStateRow>(`
        SELECT id, arc_json, source_episode_id, target_episode_id, status, superseded_by_arc_id
        FROM l01_episode_arcs
        WHERE id = $1
        LIMIT 1
      `, [arcId]);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error(`removeEpisodeArc references unknown arc "${arcId}"`);
      }
      if (!isActivePostgresArcRow(row)) {
        throw new Error(`arc "${arcId}" is already retired and cannot be removed again`);
      }
      await this.retireArc(client, arcId, null, nowIso);
      await this.insertArcAudit(client, arcId, 'removed', audit, {
        sourceEpisodeId: row.source_episode_id,
        targetEpisodeId: row.target_episode_id,
      }, nowIso);
    });
  }

  /**
   * Moves every active arc membership of one episode onto another, retiring
   * arcs that would become self-loops or duplicates. Atomic, audited.
   */
  async repointEpisodeArcMemberships(input: EpisodeArcRepointInput): Promise<EpisodeArcRepointResult> {
    const fromEpisodeId = parseRequiredText(input.fromEpisodeId, 'repoint.fromEpisodeId');
    const toEpisodeId = parseRequiredText(input.toEpisodeId, 'repoint.toEpisodeId');
    const audit = normalizeEpisodeArcMutationAudit(input, 'repoint');
    if (fromEpisodeId === toEpisodeId) {
      throw new Error('arc memberships cannot be re-pointed onto the same episode');
    }
    const nowIso = this.now().toISOString();

    return withPostgresClient(this.pool, async (client) => {
      await this.assertEpisodeExists(fromEpisodeId, 'repoint.fromEpisodeId', client);
      await this.assertLiveEpisode(toEpisodeId, 'repoint.toEpisodeId', client);
      return this.repointArcsForEpisode(client, fromEpisodeId, toEpisodeId, audit, nowIso);
    });
  }

  async listEpisodeArcAudit(options: EpisodeArcAuditListOptions = {}): Promise<EpisodeArcAuditEntry[]> {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.arcId !== undefined) {
      params.push(parseRequiredText(options.arcId, 'arcId'));
      where.push(`arc_id = $${params.length}`);
    }
    params.push(normalizeLimit(options.limit));
    const limitIndex = params.length;
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await queryRows<PostgresEpisodeArcAuditRow>(this.pool, `
      SELECT *
      FROM l01_episode_arc_audit
      ${whereClause}
      ORDER BY created_at ASC, id ASC
      LIMIT $${limitIndex}
    `, params);
    return rows.map(mapArcAuditRow);
  }

  /**
   * Within-transaction helper shared by the public repoint surface and by
   * supersession/merge paths: no arc membership may silently dangle on an
   * episode that stops being live.
   */
  private async repointArcsForEpisode(
    client: PoolClient,
    fromEpisodeId: string,
    toEpisodeId: string,
    audit: EpisodeArcMutationAudit,
    nowIso: string,
  ): Promise<EpisodeArcRepointResult> {
    const result: EpisodeArcRepointResult = { repointedArcIds: [], removedArcIds: [] };
    const rows = (await client.query<PostgresEpisodeArcStateRow>(`
      SELECT id, arc_json, source_episode_id, target_episode_id, status, superseded_by_arc_id
      FROM l01_episode_arcs
      WHERE (source_episode_id = $1 OR target_episode_id = $1) AND ${ACTIVE_CANONICAL_ARC_FILTER}
      ORDER BY updated_at ASC, id ASC
    `, [fromEpisodeId])).rows;

    for (const row of rows) {
      const newSource = row.source_episode_id === fromEpisodeId ? toEpisodeId : row.source_episode_id;
      const newTarget = row.target_episode_id === fromEpisodeId ? toEpisodeId : row.target_episode_id;
      const previous = {
        sourceEpisodeId: row.source_episode_id,
        targetEpisodeId: row.target_episode_id,
      };

      if (newSource === newTarget) {
        await this.retireArc(client, row.id, null, nowIso);
        await this.insertArcAudit(client, row.id, 'removed', audit, {
          cause: 'repoint_self_loop',
          previous,
          movedToEpisodeId: toEpisodeId,
        }, nowIso);
        result.removedArcIds.push(row.id);
        continue;
      }

      const duplicates = (await client.query<{ id: string }>(`
        SELECT id
        FROM l01_episode_arcs
        WHERE id <> $1
          AND (
            (source_episode_id = $2 AND target_episode_id = $3)
            OR (source_episode_id = $3 AND target_episode_id = $2)
          )
          AND ${ACTIVE_CANONICAL_ARC_FILTER}
        LIMIT 1
      `, [row.id, newSource, newTarget])).rows;
      if (duplicates.length > 0) {
        const duplicate = duplicates[0];
        if (duplicate === undefined) continue;
        await this.retireArc(client, row.id, duplicate.id, nowIso);
        await this.insertArcAudit(client, row.id, 'removed', audit, {
          cause: 'repoint_duplicate',
          previous,
          duplicateOfArcId: duplicate.id,
          movedToEpisodeId: toEpisodeId,
        }, nowIso);
        result.removedArcIds.push(row.id);
        continue;
      }

      const arc = parseEpisodeArc({
        ...parseArcJson(row.arc_json, row.id),
        sourceEpisodeId: newSource,
        targetEpisodeId: newTarget,
        updatedAt: nowIso,
      });
      await client.query(`
        UPDATE l01_episode_arcs
        SET source_episode_id = $2, target_episode_id = $3, arc_json = $4::jsonb, updated_at = $5
        WHERE id = $1
      `, [row.id, newSource, newTarget, serializeEpisodeArc(arc), nowIso]);
      await this.insertArcAudit(client, row.id, 'repointed', audit, {
        previous,
        next: { sourceEpisodeId: newSource, targetEpisodeId: newTarget },
      }, nowIso);
      result.repointedArcIds.push(row.id);
    }

    return result;
  }

  private async retireArc(
    client: PoolClient,
    arcId: string,
    supersededByArcId: string | null,
    nowIso: string,
  ): Promise<void> {
    await client.query(`
      UPDATE l01_episode_arcs
      SET status = 'superseded', superseded_by_arc_id = $2, updated_at = $3
      WHERE id = $1
    `, [arcId, supersededByArcId, nowIso]);
  }

  private async insertArcAudit(
    client: PoolClient,
    arcId: string,
    action: EpisodeArcAuditAction,
    audit: EpisodeArcMutationAudit,
    details: Record<string, unknown>,
    createdAt: string,
  ): Promise<void> {
    await client.query(`
      INSERT INTO l01_episode_arc_audit (id, arc_id, action, actor, reason, details_json, created_at)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
    `, [this.idFactory(), arcId, action, audit.actor, audit.reason, json(details), createdAt]);
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

  async listEpisodeArcsForEpisodes(
    episodeIds: readonly string[],
    options: EpisodeArcListOptions = {},
  ): Promise<EpisodeArc[]> {
    const normalizedEpisodeIds = normalizeRequiredTextList(episodeIds, 'episodeId');
    if (normalizedEpisodeIds.length === 0) return [];

    const direction = options.direction ?? 'both';
    const joinCondition = direction === 'incoming'
      ? 'arcs.target_episode_id = requested.episode_id'
      : direction === 'outgoing'
        ? 'arcs.source_episode_id = requested.episode_id'
        : '(arcs.source_episode_id = requested.episode_id OR arcs.target_episode_id = requested.episode_id)';

    const where = [ACTIVE_CANONICAL_ARC_FILTER];
    const params: unknown[] = [normalizedEpisodeIds];
    if (options.arcKind !== undefined) {
      params.push(options.arcKind);
      where.push(`arc_kind = $${params.length}`);
    }
    params.push(normalizeLimit(options.limit));
    const limitIndex = params.length;

    const rows = await queryRows<PostgresEpisodeArcRow>(this.pool, `
      WITH requested(episode_id) AS (
        SELECT unnest($1::text[])
      ),
      matched AS (
        SELECT
          arcs.id,
          arcs.arc_json,
          arcs.updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY requested.episode_id
            ORDER BY arcs.updated_at DESC, arcs.id ASC
          ) AS episode_rank
        FROM requested
        JOIN l01_episode_arcs arcs
          ON ${joinCondition}
        WHERE ${where.join(' AND ')}
      ),
      deduped AS (
        SELECT DISTINCT ON (id)
          id,
          arc_json,
          updated_at
        FROM matched
        WHERE episode_rank <= $${limitIndex}
        ORDER BY id, updated_at DESC
      )
      SELECT id, arc_json
      FROM deduped
      ORDER BY updated_at DESC, id ASC
    `, params);
    return rows.map(mapArcRow);
  }

  async listEpisodeArcsNeedingThreadAssignment(
    options: Pick<EpisodeListOptions, 'limit'> = {},
  ): Promise<EpisodeArc[]> {
    const rows = await queryRows<PostgresEpisodeArcRow>(this.pool, `
      SELECT arcs.id, arcs.arc_json
      FROM l01_episode_arcs arcs
      JOIN l01_episodes source ON source.id = arcs.source_episode_id
      JOIN l01_episodes target ON target.id = arcs.target_episode_id
      WHERE (arcs.status IS NULL OR arcs.status = 'canonical')
        AND (arcs.canonical_arc_id IS NULL OR arcs.canonical_arc_id = arcs.id)
        AND arcs.merged_into_arc_id IS NULL
        AND arcs.superseded_by_arc_id IS NULL
        AND (source.status IS NULL OR source.status IN ('canonical', 'candidate'))
        AND (source.canonical_episode_id IS NULL OR source.canonical_episode_id = source.id)
        AND source.merged_into_episode_id IS NULL
        AND source.superseded_by_episode_id IS NULL
        AND (target.status IS NULL OR target.status IN ('canonical', 'candidate'))
        AND (target.canonical_episode_id IS NULL OR target.canonical_episode_id = target.id)
        AND target.merged_into_episode_id IS NULL
        AND target.superseded_by_episode_id IS NULL
        AND (
          COALESCE(source.thread_id, source.id) IS DISTINCT FROM COALESCE(target.thread_id, target.id)
          OR (
            source.thread_id IS NOT NULL
            AND source.thread_id <> source.id
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(source.episode_json->'spanRefs') = 'array'
                    THEN source.episode_json->'spanRefs'
                  ELSE '[]'::jsonb
                END
              ) AS span_ref
              WHERE span_ref->>'sessionId' = source.thread_id
            )
          )
          OR (
            target.thread_id IS NOT NULL
            AND target.thread_id <> target.id
            AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                CASE
                  WHEN jsonb_typeof(target.episode_json->'spanRefs') = 'array'
                    THEN target.episode_json->'spanRefs'
                  ELSE '[]'::jsonb
                END
              ) AS span_ref
              WHERE span_ref->>'sessionId' = target.thread_id
            )
          )
        )
      ORDER BY arcs.updated_at DESC, arcs.id ASC
      LIMIT $1
    `, [normalizeLimit(options.limit)]);
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

  async listProcessingWatermarkHealth(): Promise<EpisodicProcessingWatermarkHealthSummary[]> {
    const rows = await queryRows<PostgresProcessingWatermarkHealthRow>(this.pool, `
      WITH ranked_watermarks AS (
        SELECT
          watermarks.*,
          ROW_NUMBER() OVER (
            PARTITION BY watermarks.processor
            ORDER BY watermarks.last_processed_at DESC, watermarks.updated_at DESC, watermarks.id ASC
          ) AS processor_rank,
          (COUNT(*) OVER (PARTITION BY watermarks.processor))::integer AS scope_count,
          (
            COUNT(*) FILTER (
              WHERE watermarks.status = 'blocked'
                OR watermarks.reconciliation_status = 'blocked'
            ) OVER (PARTITION BY watermarks.processor)
          )::integer AS blocked_scope_count
        FROM l01_processing_watermarks AS watermarks
      )
      SELECT *
      FROM ranked_watermarks
      WHERE processor_rank = 1
      ORDER BY processor ASC
    `);
    return rows.map((row) => ({
      processor: row.processor,
      latestWatermark: mapWatermarkRow(row),
      scopeCount: parseWatermarkHealthCount(row.scope_count, 'scope_count'),
      blockedScopeCount: parseWatermarkHealthCount(row.blocked_scope_count, 'blocked_scope_count'),
    }));
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

  async claimEpisodeMessages(input: EpisodeMessageClaimWriteInput): Promise<EpisodeMessageClaim[]> {
    const normalized = normalizeEpisodeMessageClaimWriteInput(input);
    const claimedAt = normalizeInstant(normalized.claimedAt, 'claimedAt') ?? this.now().toISOString();
    const claimKeys = normalized.claims.map(claim => claim.claimKey);

    await withPostgresClient(this.pool, async (client) => {
      await this.assertEpisodeExists(normalized.episodeId, 'claim.episodeId', client);
      const activeRows = (await client.query<PostgresEpisodeMessageClaimRow>(`
        SELECT *
        FROM l01_episode_message_claims
        WHERE status = 'active' AND claim_key = ANY($1::text[])
        FOR UPDATE
      `, [claimKeys])).rows;
      const activeKeys = new Set<string>();
      for (const row of activeRows) {
        if (row.episode_id !== normalized.episodeId) {
          throw new Error(
            `source message "${row.claim_key}" is already claimed by episode "${row.episode_id}"; `
            + `refusing to claim it for episode "${normalized.episodeId}"`,
          );
        }
        activeKeys.add(row.claim_key);
      }

      for (const claim of normalized.claims) {
        if (activeKeys.has(claim.claimKey)) continue;
        await client.query(`
          INSERT INTO l01_episode_message_claims (
            episode_id, claim_key, turn_id, channel_id, session_id, status, claimed_at
          )
          VALUES ($1, $2, $3, $4, $5, 'active', $6)
        `, [
          normalized.episodeId,
          claim.claimKey,
          claim.turnId ?? null,
          claim.channelId ?? null,
          normalized.sessionId ?? null,
          claimedAt,
        ]);
      }
    });

    return this.listEpisodeMessageClaims({
      episodeId: normalized.episodeId,
      claimKeys,
      status: 'active',
      limit: Math.min(MAX_LIMIT, claimKeys.length),
    });
  }

  async listEpisodeMessageClaims(options: EpisodeMessageClaimListOptions = {}): Promise<EpisodeMessageClaim[]> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (options.episodeId !== undefined) {
      params.push(parseRequiredText(options.episodeId, 'episodeId'));
      where.push(`episode_id = $${params.length}`);
    }
    if (options.claimKeys !== undefined) {
      const claimKeys = normalizeRequiredTextList(options.claimKeys, 'claimKeys');
      if (claimKeys.length === 0) return [];
      params.push(claimKeys);
      where.push(`claim_key = ANY($${params.length}::text[])`);
    }
    if (options.status !== undefined) {
      if (!MESSAGE_CLAIM_STATUSES.has(options.status)) {
        throw new Error(`episode message claim status is not supported: ${options.status}`);
      }
      params.push(options.status);
      where.push(`status = $${params.length}`);
    }
    params.push(normalizeLimit(options.limit));
    const limitIndex = params.length;
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

    const rows = await queryRows<PostgresEpisodeMessageClaimRow>(this.pool, `
      SELECT *
      FROM l01_episode_message_claims
      ${whereClause}
      ORDER BY claimed_at ASC, episode_id ASC, claim_key ASC
      LIMIT $${limitIndex}
    `, params);
    return rows.map(mapMessageClaimRow);
  }

  async transferEpisodeMessageClaims(input: EpisodeClaimTransferInput): Promise<EpisodeClaimTransferResult> {
    const normalized = normalizeEpisodeClaimTransferInput(input);
    const transferredAt = normalizeInstant(normalized.transferredAt, 'transferredAt') ?? this.now().toISOString();

    const transferOutcome = await withPostgresClient(this.pool, async (client) => {
      await this.assertLiveEpisode(normalized.targetEpisodeId, 'transfer.targetEpisodeId', client);
      for (const sourceEpisodeId of normalized.sourceEpisodeIds) {
        await this.assertLiveEpisode(sourceEpisodeId, 'transfer.sourceEpisodeIds', client);
      }

      const activeClaims = (await client.query<PostgresEpisodeMessageClaimRow>(`
        SELECT *
        FROM l01_episode_message_claims
        WHERE status = 'active' AND episode_id = ANY($1::text[])
        FOR UPDATE
      `, [normalized.sourceEpisodeIds])).rows;

      await client.query(`
        UPDATE l01_episode_message_claims
        SET status = 'transferred', transferred_to_episode_id = $1, transferred_at = $2, reason = $3
        WHERE status = 'active' AND episode_id = ANY($4::text[])
      `, [normalized.targetEpisodeId, transferredAt, normalized.reason, normalized.sourceEpisodeIds]);

      for (const claim of activeClaims) {
        await client.query(`
          INSERT INTO l01_episode_message_claims (
            episode_id, claim_key, turn_id, channel_id, session_id, status, claimed_at, reason
          )
          VALUES ($1, $2, $3, $4, $5, 'active', $6, $7)
        `, [
          normalized.targetEpisodeId,
          claim.claim_key,
          claim.turn_id,
          claim.channel_id,
          claim.session_id,
          transferredAt,
          normalized.reason,
        ]);
      }

      await client.query(`
        UPDATE l01_episodes
        SET status = 'superseded', superseded_by_episode_id = $1, updated_at = $2
        WHERE id = ANY($3::text[])
      `, [normalized.targetEpisodeId, transferredAt, normalized.sourceEpisodeIds]);

      // Superseded sources must not keep live arc memberships: re-point
      // every arc onto the consolidated target in the same transaction.
      const repointAudit: EpisodeArcMutationAudit = {
        actor: 'consolidation_repoint',
        reason: normalized.reason,
      };
      const repointedArcIds: string[] = [];
      const removedArcIds: string[] = [];
      for (const sourceEpisodeId of normalized.sourceEpisodeIds) {
        const repointed = await this.repointArcsForEpisode(
          client,
          sourceEpisodeId,
          normalized.targetEpisodeId,
          repointAudit,
          transferredAt,
        );
        repointedArcIds.push(...repointed.repointedArcIds);
        removedArcIds.push(...repointed.removedArcIds);
      }

      // An arc re-pointed for one source and then retired for a later source
      // (e.g. it collapsed between two superseded siblings) counts as removed.
      const removedSet = new Set(removedArcIds);
      return {
        transferredClaimKeys: activeClaims.map(claim => claim.claim_key).sort(),
        repointedArcIds: repointedArcIds.filter(id => !removedSet.has(id)),
        removedArcIds,
      };
    });

    const transferredClaims = transferOutcome.transferredClaimKeys.length > 0
      ? await this.listEpisodeMessageClaims({
        episodeId: normalized.targetEpisodeId,
        claimKeys: transferOutcome.transferredClaimKeys,
        status: 'active',
        limit: Math.min(MAX_LIMIT, transferOutcome.transferredClaimKeys.length),
      })
      : [];
    return {
      targetEpisodeId: normalized.targetEpisodeId,
      supersededEpisodeIds: normalized.sourceEpisodeIds,
      transferredClaims,
      repointedArcIds: transferOutcome.repointedArcIds,
      removedArcIds: transferOutcome.removedArcIds,
    };
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

  private async assertEpisodeExists(id: string, field: string, client?: PoolClient): Promise<void> {
    const normalizedId = parseRequiredText(id, field);
    const queryable = client ?? this.pool;
    const result = await queryable.query<{ id: string }>(`
      SELECT id
      FROM l01_episodes
      WHERE id = $1
      LIMIT 1
    `, [normalizedId]);
    if (result.rows.length === 0) {
      throw new Error(`${field} references unknown episode "${normalizedId}"`);
    }
  }

  private async assertLiveEpisode(id: string, field: string, client: PoolClient): Promise<void> {
    const normalizedId = parseRequiredText(id, field);
    const result = await client.query<{
      id: string;
      merged_into_episode_id: string | null;
      superseded_by_episode_id: string | null;
    }>(`
      SELECT id, merged_into_episode_id, superseded_by_episode_id
      FROM l01_episodes
      WHERE id = $1
      LIMIT 1
    `, [normalizedId]);
    const row = result.rows[0];
    if (row === undefined) {
      throw new Error(`${field} references unknown episode "${normalizedId}"`);
    }
    if (row.merged_into_episode_id !== null || row.superseded_by_episode_id !== null) {
      throw new Error(`${field} references episode "${normalizedId}" which is no longer live`);
    }
  }
}
