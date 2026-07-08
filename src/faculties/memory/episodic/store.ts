import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  EPISODIC_CONTRACT_VERSION,
  parseEpisode,
  parseEpisodeArc,
  serializeEpisode,
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
  normalizeOptionalUnit,
  normalizeRequiredTextList,
  normalizeUnit,
  parseOptionalText,
  parseRequiredText,
  summarizeEpisodicMaintenanceDiagnostics,
} from './store-port.js';
import { EPISODE_LIFECYCLE_STATUSES } from './store-port.js';
import type {
  EpisodeArcAuditAction,
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
  EpisodeCreateInput,
  EpisodeLineage,
  EpisodeLineageRelation,
  EpisodeLineageWriteInput,
  EpisodeListOptions,
  EpisodeMessageClaim,
  EpisodeMessageClaimListOptions,
  EpisodeMessageClaimWriteInput,
  EpisodeTimeSearchOptions,
  EpisodeUpdateInput,
  EpisodicMaintenanceDiagnostics,
  EpisodicMaintenanceDiagnosticsOptions,
  EpisodicProcessingWatermark,
  EpisodicProcessingWatermarkScope,
  EpisodicProcessingWatermarkWriteInput,
  EpisodicStoreOptions,
  EpisodicStorePort,
} from './store-port.js';
import {
  ACTIVE_ARC_PREDICATE,
  CANDIDATE_DECISION_STATUSES,
  MAX_LIMIT,
  MESSAGE_CLAIM_STATUSES,
  RECONCILIATION_STATUSES,
  WATERMARK_STATUSES,
  createEpisodicSchema,
  isActiveArcStateRow,
  json,
  lifecycleStatusPredicate,
  mapArcAuditRow,
  mapArcRow,
  mapCandidateDecisionRow,
  mapEpisodeRow,
  mapMessageClaimRow,
  mapWatermarkRow,
  normalizeInstant,
  normalizeLimit,
  normalizeOffset,
  normalizeWatermarkScope,
  parseArcJson,
  type EpisodeArcAuditRow,
  type EpisodeArcRow,
  type EpisodeArcStateRow,
  type EpisodeCandidateDecisionRow,
  type EpisodeMessageClaimRow,
  type EpisodeRow,
  type ProcessingWatermarkRow,
} from './store-rows.js';

const EPISODE_LINEAGE_RELATIONS = new Set<EpisodeLineageRelation>([
  'canonicalizes',
  'merges',
  'supersedes',
  'splits_from',
  'derived_from',
  'conflicts_with',
  'updates',
]);

export class EpisodicStore implements EpisodicStorePort {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(db: Database.Database, options: EpisodicStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.db.pragma('foreign_keys = ON');
    createEpisodicSchema(this.db);
    this.ensureMergeColumns();
  }

  // Pre-existing databases predate the merge/supersede-tracking columns;
  // CREATE TABLE IF NOT EXISTS does not add them.
  private ensureMergeColumns(): void {
    const columns = this.db.prepare("SELECT name FROM pragma_table_info('l01_episodes')").all() as Array<{ name: string }>;
    const names = new Set(columns.map(column => column.name));
    if (!names.has('status')) {
      this.db.exec('ALTER TABLE l01_episodes ADD COLUMN status TEXT');
    }
    if (!names.has('merged_into_episode_id')) {
      this.db.exec('ALTER TABLE l01_episodes ADD COLUMN merged_into_episode_id TEXT');
    }
    if (!names.has('superseded_by_episode_id')) {
      this.db.exec('ALTER TABLE l01_episodes ADD COLUMN superseded_by_episode_id TEXT');
    }
    const arcColumns = this.db.prepare("SELECT name FROM pragma_table_info('l01_episode_arcs')").all() as Array<{ name: string }>;
    const arcNames = new Set(arcColumns.map(column => column.name));
    if (!arcNames.has('status')) {
      this.db.exec('ALTER TABLE l01_episode_arcs ADD COLUMN status TEXT');
    }
    if (!arcNames.has('superseded_by_arc_id')) {
      this.db.exec('ALTER TABLE l01_episode_arcs ADD COLUMN superseded_by_arc_id TEXT');
    }
  }

  markEpisodeMerged(episodeId: string, mergedIntoEpisodeId: string): void {
    const sourceId = parseRequiredText(episodeId, 'episode id');
    const targetId = parseRequiredText(mergedIntoEpisodeId, 'merged-into episode id');
    if (sourceId === targetId) {
      throw new Error('an episode cannot be merged into itself');
    }
    if (!this.getEpisode(targetId)) {
      throw new Error(`merge target episode "${targetId}" does not exist`);
    }
    const nowIso = this.now().toISOString();
    const merge = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE l01_episodes
        SET status = 'merged', merged_into_episode_id = ?, updated_at = ?
        WHERE id = ?
      `).run(targetId, nowIso, sourceId);
      if (result.changes === 0) {
        throw new Error(`episode "${sourceId}" does not exist`);
      }
      // A merged-away episode is no longer live; its arc memberships follow
      // it onto the merge target instead of dangling.
      this.repointArcsForEpisode(sourceId, targetId, {
        actor: 'consolidation_repoint',
        reason: `episode "${sourceId}" merged into "${targetId}"`,
      }, nowIso);
    });
    merge();
  }

  createEpisode(input: EpisodeCreateInput): Episode {
    const now = this.now().toISOString();
    const lifecycleStatus = normalizeEpisodeLifecycleStatus(input.lifecycleStatus);
    const { lifecycleStatus: _lifecycleStatus, ...episodeFields } = input;
    const episode = parseEpisode({
      ...episodeFields,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    this.db.prepare(`
      INSERT INTO l01_episodes (
        id,
        thread_id,
        channel_id,
        started_at,
        ended_at,
        salience_score,
        status,
        episode_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episode.id,
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      episode.salience.score,
      lifecycleStatus,
      serializeEpisode(episode),
      episode.createdAt,
      episode.updatedAt,
    );

    return episode;
  }

  /**
   * Sleep-cycle confirmation: candidate -> canonical. Fails closed for
   * unknown or non-live episodes; idempotent when already canonical.
   */
  confirmEpisodeCanonical(episodeId: string): void {
    const normalizedId = parseRequiredText(episodeId, 'episode id');
    const result = this.db.prepare(`
      UPDATE l01_episodes
      SET status = 'canonical', updated_at = ?
      WHERE id = ?
        AND merged_into_episode_id IS NULL
        AND superseded_by_episode_id IS NULL
    `).run(this.now().toISOString(), normalizedId);
    if (result.changes === 0) {
      if (!this.getEpisode(normalizedId)) {
        throw new Error(`episode "${normalizedId}" does not exist`);
      }
      throw new Error(`episode "${normalizedId}" is no longer live and cannot be confirmed canonical`);
    }
  }

  updateEpisode(input: EpisodeUpdateInput): Episode {
    const current = this.getEpisode(input.id);
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

    this.db.prepare(`
      UPDATE l01_episodes
      SET
        thread_id = ?,
        channel_id = ?,
        started_at = ?,
        ended_at = ?,
        salience_score = ?,
        episode_json = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      episode.salience.score,
      serializeEpisode(episode),
      episode.updatedAt,
      episode.id,
    );

    return episode;
  }

  listEpisodes(options: EpisodeListOptions = {}): Episode[] {
    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE merged_into_episode_id IS NULL AND superseded_by_episode_id IS NULL
      ORDER BY started_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(normalizeLimit(options.limit), normalizeOffset(options.offset)) as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  getEpisode(id: string): Episode | undefined {
    const normalizedId = parseRequiredText(id, 'episode id');
    const row = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as EpisodeRow | undefined;
    return row ? mapEpisodeRow(row) : undefined;
  }

  getEpisodesByIds(ids: readonly string[]): Episode[] {
    const normalizedIds = normalizeRequiredTextList(ids, 'episode id');
    if (normalizedIds.length === 0) return [];

    const placeholders = normalizedIds.map(() => '?').join(', ');
    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE id IN (${placeholders})
    `).all(...normalizedIds) as EpisodeRow[];
    const byId = new Map(rows.map(row => [row.id, mapEpisodeRow(row)]));
    return normalizedIds.flatMap((id) => {
      const episode = byId.get(id);
      return episode ? [episode] : [];
    });
  }

  searchByTime(options: EpisodeTimeSearchOptions = {}): Episode[] {
    const from = normalizeInstant(options.from, 'from');
    const to = normalizeInstant(options.to, 'to');
    if (from !== undefined && to !== undefined && from > to) {
      throw new Error('from must be before or equal to to');
    }

    const where: string[] = ['merged_into_episode_id IS NULL', 'superseded_by_episode_id IS NULL'];
    const params: Array<string | number> = [];
    if (options.lifecycleStatus !== undefined) {
      if (!EPISODE_LIFECYCLE_STATUSES.has(options.lifecycleStatus)) {
        throw new Error(`episode lifecycleStatus is not supported: ${String(options.lifecycleStatus)}`);
      }
      where.push(lifecycleStatusPredicate(options.lifecycleStatus));
    }
    if (from !== undefined) {
      where.push('ended_at >= ?');
      params.push(from);
    }
    if (to !== undefined) {
      where.push('started_at <= ?');
      params.push(to);
    }
    if (options.sessionId !== undefined) {
      // Episodes are scoped by their threadId, which synthesis sets equal to the
      // session id (buildEpisodeInput); the episode record has no distinct
      // top-level sessionId field.
      where.push('thread_id = ?');
      params.push(parseRequiredText(options.sessionId, 'sessionId'));
    }

    const orderDir = options.order === 'desc' ? 'DESC' : 'ASC';
    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE ${where.join(' AND ')}
      ORDER BY started_at ${orderDir}, id ${orderDir}
      LIMIT ? OFFSET ?
    `).all(
      ...params,
      normalizeLimit(options.limit),
      normalizeOffset(options.offset),
    ) as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  searchByThread(threadId: string, options: EpisodeListOptions = {}): Episode[] {
    const normalizedThreadId = parseRequiredText(threadId, 'threadId');
    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE thread_id = ? AND merged_into_episode_id IS NULL AND superseded_by_episode_id IS NULL
      ORDER BY started_at ASC, id ASC
      LIMIT ? OFFSET ?
    `).all(
      normalizedThreadId,
      normalizeLimit(options.limit),
      normalizeOffset(options.offset),
    ) as EpisodeRow[];
    return rows.map(mapEpisodeRow);
  }

  writeEpisodeArc(input: EpisodeArcWriteInput): EpisodeArc {
    this.assertEpisodeExists(input.sourceEpisodeId, 'episodeArc.sourceEpisodeId');
    this.assertEpisodeExists(input.targetEpisodeId, 'episodeArc.targetEpisodeId');
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

    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO l01_episode_arcs (
          id,
          source_episode_id,
          target_episode_id,
          arc_kind,
          status,
          salience_score,
          confidence,
          arc_json,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, ?, 'canonical', ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_episode_id = excluded.source_episode_id,
          target_episode_id = excluded.target_episode_id,
          arc_kind = excluded.arc_kind,
          status = excluded.status,
          salience_score = excluded.salience_score,
          confidence = excluded.confidence,
          arc_json = excluded.arc_json,
          updated_at = excluded.updated_at
      `).run(
        arc.id,
        arc.sourceEpisodeId,
        arc.targetEpisodeId,
        arc.arcKind,
        arc.salience,
        arc.confidence,
        serializeEpisodeArc(arc),
        arc.createdAt,
        arc.updatedAt,
      );
      if (audit) {
        this.insertArcAudit(arc.id, 'written', audit, {
          sourceEpisodeId: arc.sourceEpisodeId,
          targetEpisodeId: arc.targetEpisodeId,
          arcKind: arc.arcKind,
          themes: arc.themes,
          confidence: arc.confidence,
        }, now);
      }
    });
    write();

    return arc;
  }

  /**
   * Retires one active arc; the row and its audit history are kept forever.
   */
  removeEpisodeArc(input: EpisodeArcRemoveInput): void {
    const arcId = parseRequiredText(input.arcId, 'removeEpisodeArc.arcId');
    const audit = normalizeEpisodeArcMutationAudit(input, 'removeEpisodeArc');
    const nowIso = this.now().toISOString();

    const remove = this.db.transaction(() => {
      const row = this.getArcStateRow(arcId);
      if (!row) {
        throw new Error(`removeEpisodeArc references unknown arc "${arcId}"`);
      }
      if (!isActiveArcStateRow(row)) {
        throw new Error(`arc "${arcId}" is already retired and cannot be removed again`);
      }
      this.retireArc(arcId, null, nowIso);
      this.insertArcAudit(arcId, 'removed', audit, {
        sourceEpisodeId: row.source_episode_id,
        targetEpisodeId: row.target_episode_id,
      }, nowIso);
    });
    remove();
  }

  /**
   * Moves every active arc membership of one episode onto another, retiring
   * arcs that would become self-loops or duplicates. Atomic, audited.
   */
  repointEpisodeArcMemberships(input: EpisodeArcRepointInput): EpisodeArcRepointResult {
    const fromEpisodeId = parseRequiredText(input.fromEpisodeId, 'repoint.fromEpisodeId');
    const toEpisodeId = parseRequiredText(input.toEpisodeId, 'repoint.toEpisodeId');
    const audit = normalizeEpisodeArcMutationAudit(input, 'repoint');
    if (fromEpisodeId === toEpisodeId) {
      throw new Error('arc memberships cannot be re-pointed onto the same episode');
    }
    const nowIso = this.now().toISOString();

    const repoint = this.db.transaction(() => {
      this.assertEpisodeExists(fromEpisodeId, 'repoint.fromEpisodeId');
      this.assertLiveEpisode(toEpisodeId, 'repoint.toEpisodeId');
      return this.repointArcsForEpisode(fromEpisodeId, toEpisodeId, audit, nowIso);
    });
    return repoint();
  }

  listEpisodeArcAudit(options: EpisodeArcAuditListOptions = {}): EpisodeArcAuditEntry[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.arcId !== undefined) {
      where.push('arc_id = ?');
      params.push(parseRequiredText(options.arcId, 'arcId'));
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT *
      FROM l01_episode_arc_audit
      ${whereClause}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params, normalizeLimit(options.limit)) as EpisodeArcAuditRow[];
    return rows.map(mapArcAuditRow);
  }

  /**
   * Within-transaction helper shared by the public repoint surface and by
   * supersession/merge paths: no arc membership may silently dangle on an
   * episode that stops being live.
   */
  private repointArcsForEpisode(
    fromEpisodeId: string,
    toEpisodeId: string,
    audit: EpisodeArcMutationAudit,
    nowIso: string,
  ): EpisodeArcRepointResult {
    const result: EpisodeArcRepointResult = { repointedArcIds: [], removedArcIds: [] };
    const rows = this.db.prepare(`
      SELECT id, arc_json, source_episode_id, target_episode_id, status, superseded_by_arc_id
      FROM l01_episode_arcs
      WHERE (source_episode_id = ? OR target_episode_id = ?) AND ${ACTIVE_ARC_PREDICATE}
      ORDER BY updated_at ASC, id ASC
    `).all(fromEpisodeId, fromEpisodeId) as EpisodeArcStateRow[];

    for (const row of rows) {
      const newSource = row.source_episode_id === fromEpisodeId ? toEpisodeId : row.source_episode_id;
      const newTarget = row.target_episode_id === fromEpisodeId ? toEpisodeId : row.target_episode_id;
      const previous = {
        sourceEpisodeId: row.source_episode_id,
        targetEpisodeId: row.target_episode_id,
      };

      if (newSource === newTarget) {
        this.retireArc(row.id, null, nowIso);
        this.insertArcAudit(row.id, 'removed', audit, {
          cause: 'repoint_self_loop',
          previous,
          movedToEpisodeId: toEpisodeId,
        }, nowIso);
        result.removedArcIds.push(row.id);
        continue;
      }

      const duplicate = this.db.prepare(`
        SELECT id
        FROM l01_episode_arcs
        WHERE id <> ?
          AND (
            (source_episode_id = ? AND target_episode_id = ?)
            OR (source_episode_id = ? AND target_episode_id = ?)
          )
          AND ${ACTIVE_ARC_PREDICATE}
        LIMIT 1
      `).get(row.id, newSource, newTarget, newTarget, newSource) as { id: string } | undefined;
      if (duplicate) {
        this.retireArc(row.id, duplicate.id, nowIso);
        this.insertArcAudit(row.id, 'removed', audit, {
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
      this.db.prepare(`
        UPDATE l01_episode_arcs
        SET source_episode_id = ?, target_episode_id = ?, arc_json = ?, updated_at = ?
        WHERE id = ?
      `).run(newSource, newTarget, serializeEpisodeArc(arc), nowIso, row.id);
      this.insertArcAudit(row.id, 'repointed', audit, {
        previous,
        next: { sourceEpisodeId: newSource, targetEpisodeId: newTarget },
      }, nowIso);
      result.repointedArcIds.push(row.id);
    }

    return result;
  }

  private retireArc(arcId: string, supersededByArcId: string | null, nowIso: string): void {
    this.db.prepare(`
      UPDATE l01_episode_arcs
      SET status = 'superseded', superseded_by_arc_id = ?, updated_at = ?
      WHERE id = ?
    `).run(supersededByArcId, nowIso, arcId);
  }

  private insertArcAudit(
    arcId: string,
    action: EpisodeArcAuditAction,
    audit: EpisodeArcMutationAudit,
    details: Record<string, unknown>,
    createdAt: string,
  ): void {
    this.db.prepare(`
      INSERT INTO l01_episode_arc_audit (id, arc_id, action, actor, reason, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(this.idFactory(), arcId, action, audit.actor, audit.reason, json(details), createdAt);
  }

  private getArcStateRow(arcId: string): EpisodeArcStateRow | undefined {
    return this.db.prepare(`
      SELECT id, arc_json, source_episode_id, target_episode_id, status, superseded_by_arc_id
      FROM l01_episode_arcs
      WHERE id = ?
      LIMIT 1
    `).get(arcId) as EpisodeArcStateRow | undefined;
  }

  getEpisodeArc(id: string): EpisodeArc | undefined {
    const normalizedId = parseRequiredText(id, 'episode arc id');
    const row = this.db.prepare(`
      SELECT id, arc_json
      FROM l01_episode_arcs
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as EpisodeArcRow | undefined;
    return row ? mapArcRow(row) : undefined;
  }

  listEpisodeArcsForEpisode(episodeId: string, options: EpisodeArcListOptions = {}): EpisodeArc[] {
    const normalizedEpisodeId = parseRequiredText(episodeId, 'episodeId');
    const direction = options.direction ?? 'both';

    const where: string[] = [ACTIVE_ARC_PREDICATE];
    const params: Array<string | number> = [];
    if (direction === 'incoming') {
      where.push('target_episode_id = ?');
      params.push(normalizedEpisodeId);
    } else if (direction === 'outgoing') {
      where.push('source_episode_id = ?');
      params.push(normalizedEpisodeId);
    } else {
      where.push('(source_episode_id = ? OR target_episode_id = ?)');
      params.push(normalizedEpisodeId, normalizedEpisodeId);
    }

    if (options.arcKind !== undefined) {
      where.push('arc_kind = ?');
      params.push(options.arcKind);
    }

    const rows = this.db.prepare(`
      SELECT id, arc_json
      FROM l01_episode_arcs
      WHERE ${where.join(' AND ')}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
    `).all(...params, normalizeLimit(options.limit)) as EpisodeArcRow[];
    return rows.map(mapArcRow);
  }

  listEpisodeArcsForEpisodes(
    episodeIds: readonly string[],
    options: EpisodeArcListOptions = {},
  ): EpisodeArc[] {
    const normalizedEpisodeIds = normalizeRequiredTextList(episodeIds, 'episodeId');
    if (normalizedEpisodeIds.length === 0) return [];

    const direction = options.direction ?? 'both';
    const requestedValues = normalizedEpisodeIds.map(() => '(?)').join(', ');
    const joinCondition = direction === 'incoming'
      ? 'arcs.target_episode_id = requested.episode_id'
      : direction === 'outgoing'
        ? 'arcs.source_episode_id = requested.episode_id'
        : '(arcs.source_episode_id = requested.episode_id OR arcs.target_episode_id = requested.episode_id)';

    const where: string[] = [
      "(arcs.status IS NULL OR arcs.status = 'canonical') AND arcs.superseded_by_arc_id IS NULL",
    ];
    const params: Array<string | number> = [...normalizedEpisodeIds];
    if (options.arcKind !== undefined) {
      where.push('arcs.arc_kind = ?');
      params.push(options.arcKind);
    }
    params.push(normalizeLimit(options.limit));

    const rows = this.db.prepare(`
      WITH requested(episode_id) AS (
        VALUES ${requestedValues}
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
        ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
      ),
      deduped AS (
        SELECT id, arc_json, updated_at
        FROM matched
        WHERE episode_rank <= ?
        GROUP BY id, arc_json, updated_at
      )
      SELECT id, arc_json
      FROM deduped
      ORDER BY updated_at DESC, id ASC
    `).all(...params) as EpisodeArcRow[];
    return rows.map(mapArcRow);
  }

  getProcessingWatermark(scope: EpisodicProcessingWatermarkScope): EpisodicProcessingWatermark | undefined {
    const normalized = normalizeWatermarkScope(scope);
    const row = this.db.prepare(`
      SELECT *
      FROM l01_processing_watermarks
      WHERE processor = ?
        AND source_ref = ?
        AND COALESCE(channel_id, '') = ?
        AND COALESCE(thread_id, '') = ?
        AND COALESCE(session_id, '') = ?
      LIMIT 1
    `).get(
      normalized.processor,
      normalized.sourceRef,
      normalized.channelId ?? '',
      normalized.threadId ?? '',
      normalized.sessionId ?? '',
    ) as ProcessingWatermarkRow | undefined;
    return row ? mapWatermarkRow(row) : undefined;
  }

  upsertProcessingWatermark(input: EpisodicProcessingWatermarkWriteInput): EpisodicProcessingWatermark {
    const scope = normalizeWatermarkScope(input);
    const now = this.now().toISOString();
    const watermark: EpisodicProcessingWatermark = {
      ...scope,
      id: input.id ?? this.idFactory(),
      ...(parseOptionalText(input.highWaterTurnId, 'highWaterTurnId') ? { highWaterTurnId: parseRequiredText(input.highWaterTurnId ?? '', 'highWaterTurnId') } : {}),
      ...(parseOptionalText(input.highWaterMessageId, 'highWaterMessageId') ? { highWaterMessageId: parseRequiredText(input.highWaterMessageId ?? '', 'highWaterMessageId') } : {}),
      ...(normalizeInstant(input.processedStartedAt, 'processedStartedAt') ? { processedStartedAt: normalizeInstant(input.processedStartedAt, 'processedStartedAt') } : {}),
      ...(normalizeInstant(input.processedEndedAt, 'processedEndedAt') ? { processedEndedAt: normalizeInstant(input.processedEndedAt, 'processedEndedAt') } : {}),
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

    this.db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        processor = excluded.processor,
        channel_id = excluded.channel_id,
        thread_id = excluded.thread_id,
        session_id = excluded.session_id,
        source_ref = excluded.source_ref,
        high_water_turn_id = excluded.high_water_turn_id,
        high_water_message_id = excluded.high_water_message_id,
        processed_started_at = excluded.processed_started_at,
        processed_ended_at = excluded.processed_ended_at,
        previous_watermark_json = excluded.previous_watermark_json,
        next_watermark_json = excluded.next_watermark_json,
        status = excluded.status,
        reconciliation_status = excluded.reconciliation_status,
        artifacts_json = excluded.artifacts_json,
        last_processed_at = excluded.last_processed_at,
        updated_at = excluded.updated_at
    `).run(
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
    );

    return watermark;
  }

  writeEpisodeCandidateDecision(input: EpisodeCandidateDecisionWriteInput): EpisodeCandidateDecision {
    const now = this.now().toISOString();
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
      ...(normalizeInstant(input.startedAt, 'startedAt') ? { startedAt: normalizeInstant(input.startedAt, 'startedAt') } : {}),
      ...(normalizeInstant(input.endedAt, 'endedAt') ? { endedAt: normalizeInstant(input.endedAt, 'endedAt') } : {}),
      ...(normalizeOptionalUnit(input.overlapScore, 'overlapScore') !== undefined
        ? { overlapScore: normalizeOptionalUnit(input.overlapScore, 'overlapScore') }
        : {}),
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

    this.db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        candidate_episode_id = excluded.candidate_episode_id,
        canonical_episode_id = excluded.canonical_episode_id,
        merged_into_episode_id = excluded.merged_into_episode_id,
        superseded_by_episode_id = excluded.superseded_by_episode_id,
        source_watermark_id = excluded.source_watermark_id,
        status = excluded.status,
        channel_id = excluded.channel_id,
        thread_id = excluded.thread_id,
        session_id = excluded.session_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        overlap_score = excluded.overlap_score,
        confidence = excluded.confidence,
        reason = excluded.reason,
        candidate_json = excluded.candidate_json,
        artifact_refs = excluded.artifact_refs,
        provenance_refs = excluded.provenance_refs,
        updated_at = excluded.updated_at
    `).run(
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
    );

    return decision;
  }

  listEpisodeCandidateDecisions(options: EpisodeCandidateDecisionListOptions = {}): EpisodeCandidateDecision[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.sourceWatermarkId !== undefined) {
      where.push('source_watermark_id = ?');
      params.push(parseRequiredText(options.sourceWatermarkId, 'sourceWatermarkId'));
    }
    if (options.canonicalEpisodeId !== undefined) {
      where.push('canonical_episode_id = ?');
      params.push(parseRequiredText(options.canonicalEpisodeId, 'canonicalEpisodeId'));
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT *
      FROM l01_episode_candidates
      ${whereClause}
      ORDER BY created_at ASC, id ASC
      LIMIT ?
    `).all(...params, normalizeLimit(options.limit)) as EpisodeCandidateDecisionRow[];
    return rows.map(mapCandidateDecisionRow);
  }

  writeEpisodeLineage(input: EpisodeLineageWriteInput): EpisodeLineage {
    this.assertEpisodeExists(input.sourceEpisodeId, 'lineage.sourceEpisodeId');
    this.assertEpisodeExists(input.targetEpisodeId, 'lineage.targetEpisodeId');
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

    this.db.prepare(`
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_episode_id = excluded.source_episode_id,
        target_episode_id = excluded.target_episode_id,
        relation = excluded.relation,
        confidence = excluded.confidence,
        reason = excluded.reason,
        source_ref = excluded.source_ref,
        provenance_refs = excluded.provenance_refs,
        lineage_json = excluded.lineage_json,
        created_at = excluded.created_at
    `).run(
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
    );

    return lineage;
  }

  claimEpisodeMessages(input: EpisodeMessageClaimWriteInput): EpisodeMessageClaim[] {
    const normalized = normalizeEpisodeMessageClaimWriteInput(input);
    const claimedAt = normalizeInstant(normalized.claimedAt, 'claimedAt') ?? this.now().toISOString();
    this.assertEpisodeExists(normalized.episodeId, 'claim.episodeId');

    const claimKeys = normalized.claims.map(claim => claim.claimKey);
    const write = this.db.transaction(() => {
      const placeholders = claimKeys.map(() => '?').join(', ');
      const activeRows = this.db.prepare(`
        SELECT * FROM l01_episode_message_claims
        WHERE status = 'active' AND claim_key IN (${placeholders})
      `).all(...claimKeys) as EpisodeMessageClaimRow[];
      const activeByKey = new Map(activeRows.map(row => [row.claim_key, row]));
      for (const row of activeRows) {
        if (row.episode_id !== normalized.episodeId) {
          throw new Error(
            `source message "${row.claim_key}" is already claimed by episode "${row.episode_id}"; `
            + `refusing to claim it for episode "${normalized.episodeId}"`,
          );
        }
      }

      const insert = this.db.prepare(`
        INSERT INTO l01_episode_message_claims (
          episode_id, claim_key, turn_id, channel_id, session_id, status, claimed_at
        )
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `);
      for (const claim of normalized.claims) {
        if (activeByKey.has(claim.claimKey)) continue;
        insert.run(
          normalized.episodeId,
          claim.claimKey,
          claim.turnId ?? null,
          claim.channelId ?? null,
          normalized.sessionId ?? null,
          claimedAt,
        );
      }
    });
    write();

    return this.listEpisodeMessageClaims({
      episodeId: normalized.episodeId,
      claimKeys,
      status: 'active',
      limit: Math.min(MAX_LIMIT, claimKeys.length),
    });
  }

  listEpisodeMessageClaims(options: EpisodeMessageClaimListOptions = {}): EpisodeMessageClaim[] {
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (options.episodeId !== undefined) {
      where.push('episode_id = ?');
      params.push(parseRequiredText(options.episodeId, 'episodeId'));
    }
    if (options.claimKeys !== undefined) {
      const claimKeys = normalizeRequiredTextList(options.claimKeys, 'claimKeys');
      if (claimKeys.length === 0) return [];
      where.push(`claim_key IN (${claimKeys.map(() => '?').join(', ')})`);
      params.push(...claimKeys);
    }
    if (options.status !== undefined) {
      if (!MESSAGE_CLAIM_STATUSES.has(options.status)) {
        throw new Error(`episode message claim status is not supported: ${options.status}`);
      }
      where.push('status = ?');
      params.push(options.status);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT *
      FROM l01_episode_message_claims
      ${whereClause}
      ORDER BY claimed_at ASC, episode_id ASC, claim_key ASC
      LIMIT ?
    `).all(...params, normalizeLimit(options.limit)) as EpisodeMessageClaimRow[];
    return rows.map(mapMessageClaimRow);
  }

  transferEpisodeMessageClaims(input: EpisodeClaimTransferInput): EpisodeClaimTransferResult {
    const normalized = normalizeEpisodeClaimTransferInput(input);
    const transferredAt = normalizeInstant(normalized.transferredAt, 'transferredAt') ?? this.now().toISOString();

    const transfer = this.db.transaction(() => {
      this.assertLiveEpisode(normalized.targetEpisodeId, 'transfer.targetEpisodeId');
      for (const sourceEpisodeId of normalized.sourceEpisodeIds) {
        this.assertLiveEpisode(sourceEpisodeId, 'transfer.sourceEpisodeIds');
      }

      const sourcePlaceholders = normalized.sourceEpisodeIds.map(() => '?').join(', ');
      const activeClaims = this.db.prepare(`
        SELECT * FROM l01_episode_message_claims
        WHERE status = 'active' AND episode_id IN (${sourcePlaceholders})
      `).all(...normalized.sourceEpisodeIds) as EpisodeMessageClaimRow[];

      this.db.prepare(`
        UPDATE l01_episode_message_claims
        SET status = 'transferred', transferred_to_episode_id = ?, transferred_at = ?, reason = ?
        WHERE status = 'active' AND episode_id IN (${sourcePlaceholders})
      `).run(normalized.targetEpisodeId, transferredAt, normalized.reason, ...normalized.sourceEpisodeIds);

      const insert = this.db.prepare(`
        INSERT INTO l01_episode_message_claims (
          episode_id, claim_key, turn_id, channel_id, session_id, status, claimed_at, reason
        )
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?)
      `);
      for (const claim of activeClaims) {
        insert.run(
          normalized.targetEpisodeId,
          claim.claim_key,
          claim.turn_id,
          claim.channel_id,
          claim.session_id,
          transferredAt,
          normalized.reason,
        );
      }

      this.db.prepare(`
        UPDATE l01_episodes
        SET status = 'superseded', superseded_by_episode_id = ?, updated_at = ?
        WHERE id IN (${sourcePlaceholders})
      `).run(normalized.targetEpisodeId, transferredAt, ...normalized.sourceEpisodeIds);

      // Superseded sources must not keep live arc memberships: re-point
      // every arc onto the consolidated target in the same transaction.
      const repointAudit: EpisodeArcMutationAudit = {
        actor: 'consolidation_repoint',
        reason: normalized.reason,
      };
      const repointedArcIds: string[] = [];
      const removedArcIds: string[] = [];
      for (const sourceEpisodeId of normalized.sourceEpisodeIds) {
        const repointed = this.repointArcsForEpisode(
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
    const { transferredClaimKeys, repointedArcIds, removedArcIds } = transfer();

    const transferredClaims = transferredClaimKeys.length > 0
      ? this.listEpisodeMessageClaims({
        episodeId: normalized.targetEpisodeId,
        claimKeys: transferredClaimKeys,
        status: 'active',
        limit: Math.min(MAX_LIMIT, transferredClaimKeys.length),
      })
      : [];
    return {
      targetEpisodeId: normalized.targetEpisodeId,
      supersededEpisodeIds: normalized.sourceEpisodeIds,
      transferredClaims,
      repointedArcIds,
      removedArcIds,
    };
  }

  getMaintenanceDiagnostics(
    options: EpisodicMaintenanceDiagnosticsOptions = {},
  ): EpisodicMaintenanceDiagnostics {
    const decisions = this.listEpisodeCandidateDecisions({ limit: MAX_LIMIT });
    const watermarks = this.db.prepare(`
      SELECT *
      FROM l01_processing_watermarks
      ORDER BY updated_at ASC, id ASC
      LIMIT ?
    `).all(MAX_LIMIT) as ProcessingWatermarkRow[];
    return summarizeEpisodicMaintenanceDiagnostics({
      decisions,
      watermarks: watermarks.map(mapWatermarkRow),
      now: normalizeEpisodicDiagnosticsNow(options.now),
    });
  }

  private assertEpisodeExists(id: string, field: string): void {
    const normalizedId = parseRequiredText(id, field);
    const row = this.db.prepare(`
      SELECT id
      FROM l01_episodes
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as { id: string } | undefined;
    if (!row) {
      throw new Error(`${field} references unknown episode "${normalizedId}"`);
    }
  }

  private assertLiveEpisode(id: string, field: string): void {
    const normalizedId = parseRequiredText(id, field);
    const row = this.db.prepare(`
      SELECT id, merged_into_episode_id, superseded_by_episode_id
      FROM l01_episodes
      WHERE id = ?
      LIMIT 1
    `).get(normalizedId) as {
      id: string;
      merged_into_episode_id: string | null;
      superseded_by_episode_id: string | null;
    } | undefined;
    if (!row) {
      throw new Error(`${field} references unknown episode "${normalizedId}"`);
    }
    if (row.merged_into_episode_id !== null || row.superseded_by_episode_id !== null) {
      throw new Error(`${field} references episode "${normalizedId}" which is no longer live`);
    }
  }
}
