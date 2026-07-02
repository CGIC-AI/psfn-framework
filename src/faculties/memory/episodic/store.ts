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
  type EpisodeArcKind,
  type EpisodeArtifactRef,
  type EpisodeProvenanceRef,
} from '../../../shared/contracts/episodic-memory.js';

export type EpisodeCreateInput = Omit<
  Episode,
  'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type EpisodeUpdateInput = Omit<
  Episode,
  'schemaVersion' | 'createdAt' | 'updatedAt'
> & {
  updatedAt?: string;
};

export type EpisodeArcWriteInput = Omit<
  EpisodeArc,
  'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export type EpisodicProcessingWatermarkStatus = 'active' | 'reconciling' | 'blocked' | 'complete';
export type EpisodicReconciliationStatus = 'pending' | 'clean' | 'needs_review' | 'blocked';

export interface EpisodicProcessingWatermarkScope {
  processor: string;
  sourceRef: string;
  channelId?: string;
  threadId?: string;
  sessionId?: string;
}

export interface EpisodicProcessingWatermark extends EpisodicProcessingWatermarkScope {
  id: string;
  highWaterTurnId?: string;
  highWaterMessageId?: string;
  processedStartedAt?: string;
  processedEndedAt?: string;
  previousWatermarkJson: Record<string, unknown>;
  nextWatermarkJson: Record<string, unknown>;
  status: EpisodicProcessingWatermarkStatus;
  reconciliationStatus: EpisodicReconciliationStatus;
  artifactsJson: Record<string, unknown>;
  lastProcessedAt: string;
  updatedAt: string;
}

export type EpisodicProcessingWatermarkWriteInput = EpisodicProcessingWatermarkScope & {
  id?: string;
  highWaterTurnId?: string;
  highWaterMessageId?: string;
  processedStartedAt?: string;
  processedEndedAt?: string;
  previousWatermarkJson?: Record<string, unknown>;
  nextWatermarkJson?: Record<string, unknown>;
  status?: EpisodicProcessingWatermarkStatus;
  reconciliationStatus?: EpisodicReconciliationStatus;
  artifactsJson?: Record<string, unknown>;
  lastProcessedAt?: string;
  updatedAt?: string;
};

export type EpisodeCandidateDecisionStatus =
  | 'pending'
  | 'accepted'
  | 'canonical'
  | 'merged'
  | 'superseded'
  | 'rejected'
  | 'needs_review';

export interface EpisodeCandidateDecision {
  id: string;
  candidateEpisodeId?: string;
  canonicalEpisodeId?: string;
  mergedIntoEpisodeId?: string;
  supersededByEpisodeId?: string;
  sourceWatermarkId?: string;
  status: EpisodeCandidateDecisionStatus;
  channelId?: string;
  threadId?: string;
  sessionId?: string;
  startedAt?: string;
  endedAt?: string;
  overlapScore?: number;
  confidence: number;
  reason?: string;
  candidateJson: unknown;
  artifactRefs: EpisodeArtifactRef[];
  provenanceRefs: EpisodeProvenanceRef[];
  createdAt: string;
  updatedAt: string;
}

export type EpisodeCandidateDecisionWriteInput = Omit<
  EpisodeCandidateDecision,
  'id' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
};

export interface EpisodeCandidateDecisionListOptions {
  sourceWatermarkId?: string;
  canonicalEpisodeId?: string;
  limit?: number;
}

export interface EpisodicMaintenanceDiagnosticsOptions {
  now?: string | Date | number;
}

export interface EpisodicMaintenanceDiagnostics {
  candidateDecisionCount: number;
  decisionCountsByStatus: Record<string, number>;
  canonicalDecisionCount: number;
  duplicateCandidateCount: number;
  duplicateEpisodeRate: number;
  mergeDecisionCount: number;
  supersessionDecisionCount: number;
  rejectedDecisionCount: number;
  reviewDecisionCount: number;
  watermarkCount: number;
  pendingWatermarkCount: number;
  oldestQueueAgeMs: number;
  averageQueueAgeMs: number;
  averageProcessingLatencyMs: number;
  latestProcessedAt?: string;
}

export type EpisodeLineageRelation =
  | 'canonicalizes'
  | 'merges'
  | 'supersedes'
  | 'splits_from'
  | 'derived_from'
  | 'conflicts_with'
  | 'updates';

export interface EpisodeLineage {
  id: string;
  sourceEpisodeId: string;
  targetEpisodeId: string;
  relation: EpisodeLineageRelation;
  confidence: number;
  reason?: string;
  sourceRef?: string;
  provenanceRefs: EpisodeProvenanceRef[];
  lineageJson: Record<string, unknown>;
  createdAt: string;
}

export type EpisodeLineageWriteInput = Omit<EpisodeLineage, 'id' | 'createdAt'> & {
  id?: string;
  createdAt?: string;
};

export type EpisodeMessageClaimStatus = 'active' | 'transferred';

/**
 * A hard claim by an episode on one source message (L0 session entry).
 * At most one ACTIVE claim may exist per claim key across all episodes; the
 * database enforces this with a partial unique index. Transferred claims are
 * retained forever as history — claims are never deleted.
 */
export interface EpisodeMessageClaim {
  episodeId: string;
  claimKey: string;
  turnId?: string;
  channelId?: string;
  sessionId?: string;
  status: EpisodeMessageClaimStatus;
  claimedAt: string;
  transferredToEpisodeId?: string;
  transferredAt?: string;
  reason?: string;
}

export interface EpisodeMessageClaimEntryInput {
  claimKey: string;
  turnId?: string;
  channelId?: string;
}

export interface EpisodeMessageClaimWriteInput {
  episodeId: string;
  sessionId?: string;
  claimedAt?: string;
  claims: readonly EpisodeMessageClaimEntryInput[];
}

export interface EpisodeMessageClaimListOptions {
  episodeId?: string;
  claimKeys?: readonly string[];
  status?: EpisodeMessageClaimStatus;
  limit?: number;
}

export interface EpisodeClaimTransferInput {
  sourceEpisodeIds: readonly string[];
  targetEpisodeId: string;
  reason: string;
  transferredAt?: string;
}

export interface EpisodeClaimTransferResult {
  targetEpisodeId: string;
  supersededEpisodeIds: string[];
  transferredClaims: EpisodeMessageClaim[];
}

export interface EpisodeListOptions {
  limit?: number;
  offset?: number;
}

export interface EpisodeTimeSearchOptions extends EpisodeListOptions {
  from?: string;
  to?: string;
}

export interface EpisodeArcListOptions {
  direction?: 'incoming' | 'outgoing' | 'both';
  arcKind?: EpisodeArcKind;
  limit?: number;
}

export interface EpisodicStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export type EpisodicStoreResult<T> = T | Promise<T>;

export interface EpisodicStorePort {
  createEpisode(input: EpisodeCreateInput): EpisodicStoreResult<Episode>;
  updateEpisode(input: EpisodeUpdateInput): EpisodicStoreResult<Episode>;
  /** Folds an episode into a canonical target: it stops appearing in list/search results but remains retrievable by id. */
  markEpisodeMerged(episodeId: string, mergedIntoEpisodeId: string): EpisodicStoreResult<void>;
  getEpisode(id: string): EpisodicStoreResult<Episode | undefined>;
  getEpisodesByIds(ids: readonly string[]): EpisodicStoreResult<Episode[]>;
  listEpisodes(options?: EpisodeListOptions): EpisodicStoreResult<Episode[]>;
  searchByTime(options?: EpisodeTimeSearchOptions): EpisodicStoreResult<Episode[]>;
  searchByThread(threadId: string, options?: EpisodeListOptions): EpisodicStoreResult<Episode[]>;
  writeEpisodeArc(input: EpisodeArcWriteInput): EpisodicStoreResult<EpisodeArc>;
  listEpisodeArcsForEpisode(
    episodeId: string,
    options?: EpisodeArcListOptions,
  ): EpisodicStoreResult<EpisodeArc[]>;
  listEpisodeArcsForEpisodes(
    episodeIds: readonly string[],
    options?: EpisodeArcListOptions,
  ): EpisodicStoreResult<EpisodeArc[]>;
  getProcessingWatermark(
    scope: EpisodicProcessingWatermarkScope,
  ): EpisodicStoreResult<EpisodicProcessingWatermark | undefined>;
  upsertProcessingWatermark(
    input: EpisodicProcessingWatermarkWriteInput,
  ): EpisodicStoreResult<EpisodicProcessingWatermark>;
  writeEpisodeCandidateDecision(input: EpisodeCandidateDecisionWriteInput): EpisodicStoreResult<EpisodeCandidateDecision>;
  listEpisodeCandidateDecisions(options?: EpisodeCandidateDecisionListOptions): EpisodicStoreResult<EpisodeCandidateDecision[]>;
  writeEpisodeLineage(input: EpisodeLineageWriteInput): EpisodicStoreResult<EpisodeLineage>;
  /**
   * Claims source messages for an episode. Fails closed if any message is
   * already actively claimed by a different episode; re-claiming for the same
   * episode is idempotent.
   */
  claimEpisodeMessages(input: EpisodeMessageClaimWriteInput): EpisodicStoreResult<EpisodeMessageClaim[]>;
  listEpisodeMessageClaims(options?: EpisodeMessageClaimListOptions): EpisodicStoreResult<EpisodeMessageClaim[]>;
  /**
   * Nightly-consolidation claim restructuring: atomically moves every active
   * claim held by the source candidate episodes onto the consolidated target
   * episode and marks the sources superseded (never deleted). Superseded
   * candidates keep their transferred claim rows as history.
   */
  transferEpisodeMessageClaims(input: EpisodeClaimTransferInput): EpisodicStoreResult<EpisodeClaimTransferResult>;
  getMaintenanceDiagnostics(options?: EpisodicMaintenanceDiagnosticsOptions): EpisodicStoreResult<EpisodicMaintenanceDiagnostics>;
}

interface EpisodeRow {
  id: string;
  episode_json: string;
}

interface EpisodeArcRow {
  id: string;
  arc_json: string;
}

interface ProcessingWatermarkRow {
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
  previous_watermark_json: string;
  next_watermark_json: string;
  status: string;
  reconciliation_status: string;
  artifacts_json: string;
  last_processed_at: string;
  updated_at: string;
}

interface EpisodeMessageClaimRow {
  episode_id: string;
  claim_key: string;
  turn_id: string | null;
  channel_id: string | null;
  session_id: string | null;
  status: string;
  claimed_at: string;
  transferred_to_episode_id: string | null;
  transferred_at: string | null;
  reason: string | null;
}

interface EpisodeCandidateDecisionRow {
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
  candidate_json: string;
  artifact_refs: string;
  provenance_refs: string;
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
const MESSAGE_CLAIM_STATUSES = new Set<EpisodeMessageClaimStatus>(['active', 'transferred']);
const EPISODE_LINEAGE_RELATIONS = new Set<EpisodeLineageRelation>([
  'canonicalizes',
  'merges',
  'supersedes',
  'splits_from',
  'derived_from',
  'conflicts_with',
  'updates',
]);

function isCanonicalIsoInstant(value: string): boolean {
  return ISO_INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function createEpisodicSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS l01_episodes (
      id TEXT PRIMARY KEY,
      thread_id TEXT,
      channel_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      salience_score REAL NOT NULL,
      status TEXT,
      merged_into_episode_id TEXT,
      superseded_by_episode_id TEXT,
      episode_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_started_at
      ON l01_episodes(started_at, ended_at);
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_thread
      ON l01_episodes(thread_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_channel
      ON l01_episodes(channel_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_l01_episodes_salience
      ON l01_episodes(salience_score DESC, started_at DESC);

    CREATE TABLE IF NOT EXISTS l01_episode_arcs (
      id TEXT PRIMARY KEY,
      source_episode_id TEXT NOT NULL,
      target_episode_id TEXT NOT NULL,
      arc_kind TEXT NOT NULL,
      salience_score REAL NOT NULL,
      confidence REAL NOT NULL,
      arc_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      CHECK (source_episode_id <> target_episode_id),
      FOREIGN KEY (source_episode_id) REFERENCES l01_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_episode_id) REFERENCES l01_episodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_source
      ON l01_episode_arcs(source_episode_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_target
      ON l01_episode_arcs(target_episode_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l01_episode_arcs_kind
      ON l01_episode_arcs(arc_kind, updated_at DESC);

    CREATE TABLE IF NOT EXISTS l01_processing_watermarks (
      id TEXT PRIMARY KEY,
      processor TEXT NOT NULL,
      channel_id TEXT,
      thread_id TEXT,
      session_id TEXT,
      source_ref TEXT NOT NULL,
      high_water_turn_id TEXT,
      high_water_message_id TEXT,
      processed_started_at TEXT,
      processed_ended_at TEXT,
      previous_watermark_json TEXT NOT NULL,
      next_watermark_json TEXT NOT NULL,
      status TEXT NOT NULL,
      reconciliation_status TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      last_processed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_l01_processing_watermarks_unique_scope
      ON l01_processing_watermarks(processor, source_ref, COALESCE(channel_id, ''), COALESCE(thread_id, ''), COALESCE(session_id, ''));

    CREATE TABLE IF NOT EXISTS l01_episode_candidates (
      id TEXT PRIMARY KEY,
      candidate_episode_id TEXT,
      canonical_episode_id TEXT,
      merged_into_episode_id TEXT,
      superseded_by_episode_id TEXT,
      source_watermark_id TEXT,
      status TEXT NOT NULL,
      channel_id TEXT,
      thread_id TEXT,
      session_id TEXT,
      started_at TEXT,
      ended_at TEXT,
      overlap_score REAL,
      confidence REAL NOT NULL,
      reason TEXT,
      candidate_json TEXT NOT NULL,
      artifact_refs TEXT NOT NULL,
      provenance_refs TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (source_watermark_id) REFERENCES l01_processing_watermarks(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_watermark
      ON l01_episode_candidates(source_watermark_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l01_episode_candidates_canonical
      ON l01_episode_candidates(canonical_episode_id, status);

    CREATE TABLE IF NOT EXISTS l01_episode_lineage (
      id TEXT PRIMARY KEY,
      source_episode_id TEXT NOT NULL,
      target_episode_id TEXT NOT NULL,
      relation TEXT NOT NULL,
      confidence REAL NOT NULL,
      reason TEXT,
      source_ref TEXT,
      provenance_refs TEXT NOT NULL,
      lineage_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (source_episode_id <> target_episode_id),
      FOREIGN KEY (source_episode_id) REFERENCES l01_episodes(id) ON DELETE CASCADE,
      FOREIGN KEY (target_episode_id) REFERENCES l01_episodes(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_source
      ON l01_episode_lineage(source_episode_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_l01_episode_lineage_target
      ON l01_episode_lineage(target_episode_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS l01_episode_message_claims (
      episode_id TEXT NOT NULL,
      claim_key TEXT NOT NULL,
      turn_id TEXT,
      channel_id TEXT,
      session_id TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      claimed_at TEXT NOT NULL,
      transferred_to_episode_id TEXT,
      transferred_at TEXT,
      reason TEXT,
      PRIMARY KEY (episode_id, claim_key),
      CHECK (status IN ('active', 'transferred')),
      FOREIGN KEY (episode_id) REFERENCES l01_episodes(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_l01_episode_message_claims_active_key
      ON l01_episode_message_claims(claim_key) WHERE status = 'active';
    CREATE INDEX IF NOT EXISTS idx_l01_episode_message_claims_episode
      ON l01_episode_message_claims(episode_id, status);
  `);
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

function parseEpisodeJson(raw: string, id: string): Episode {
  try {
    return parseEpisode(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`malformed persisted episode "${id}": ${String(error)}`);
  }
}

function parseArcJson(raw: string, id: string): EpisodeArc {
  try {
    return parseEpisodeArc(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`malformed persisted episode arc "${id}": ${String(error)}`);
  }
}

function parseJsonPayload(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} JSON is not parseable: ${String(error)}`);
  }
}

function parseRecordJson(raw: string, label: string): Record<string, unknown> {
  const parsed = parseJsonPayload(raw, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

function parseArrayJson<T>(raw: string, label: string): T[] {
  const parsed = parseJsonPayload(raw, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed as T[];
}

function mapEpisodeRow(row: EpisodeRow): Episode {
  const episode = parseEpisodeJson(row.episode_json, row.id);
  if (episode.id !== row.id) {
    throw new Error(`malformed persisted episode "${row.id}": JSON id mismatch`);
  }
  return episode;
}

function mapArcRow(row: EpisodeArcRow): EpisodeArc {
  const arc = parseArcJson(row.arc_json, row.id);
  if (arc.id !== row.id) {
    throw new Error(`malformed persisted episode arc "${row.id}": JSON id mismatch`);
  }
  return arc;
}

function mapWatermarkRow(row: ProcessingWatermarkRow): EpisodicProcessingWatermark {
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
    ...(row.processed_started_at ? { processedStartedAt: row.processed_started_at } : {}),
    ...(row.processed_ended_at ? { processedEndedAt: row.processed_ended_at } : {}),
    previousWatermarkJson: parseRecordJson(row.previous_watermark_json, `processing watermark "${row.id}" previousWatermarkJson`),
    nextWatermarkJson: parseRecordJson(row.next_watermark_json, `processing watermark "${row.id}" nextWatermarkJson`),
    status,
    reconciliationStatus,
    artifactsJson: parseRecordJson(row.artifacts_json, `processing watermark "${row.id}" artifactsJson`),
    lastProcessedAt: row.last_processed_at,
    updatedAt: row.updated_at,
  };
}

function mapCandidateDecisionRow(row: EpisodeCandidateDecisionRow): EpisodeCandidateDecision {
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
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    ...(row.overlap_score !== null ? { overlapScore: row.overlap_score } : {}),
    confidence: row.confidence,
    ...(row.reason ? { reason: row.reason } : {}),
    candidateJson: parseJsonPayload(row.candidate_json, `episode candidate "${row.id}" candidateJson`),
    artifactRefs: parseArrayJson<EpisodeArtifactRef>(row.artifact_refs, `episode candidate "${row.id}" artifactRefs`),
    provenanceRefs: parseArrayJson<EpisodeProvenanceRef>(row.provenance_refs, `episode candidate "${row.id}" provenanceRefs`),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMessageClaimRow(row: EpisodeMessageClaimRow): EpisodeMessageClaim {
  const status = row.status as EpisodeMessageClaimStatus;
  if (!MESSAGE_CLAIM_STATUSES.has(status)) {
    throw new Error(`malformed persisted episode message claim "${row.episode_id}:${row.claim_key}": unsupported status`);
  }
  return {
    episodeId: row.episode_id,
    claimKey: row.claim_key,
    ...(row.turn_id ? { turnId: row.turn_id } : {}),
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    status,
    claimedAt: row.claimed_at,
    ...(row.transferred_to_episode_id ? { transferredToEpisodeId: row.transferred_to_episode_id } : {}),
    ...(row.transferred_at ? { transferredAt: row.transferred_at } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

function parseRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

function parseOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseRequiredText(value, field);
}

function normalizeRequiredTextList(values: readonly string[], field: string): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const item = parseRequiredText(value, field);
    if (seen.has(item)) continue;
    seen.add(item);
    normalized.push(item);
  }
  return normalized;
}

function normalizeUnit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

export function normalizeEpisodicDiagnosticsNow(value: string | Date | number | undefined): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && isCanonicalIsoInstant(value)) return Date.parse(value);
  return Date.now();
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function parseOptionalInstantMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function summarizeEpisodicMaintenanceDiagnostics(input: {
  decisions: readonly EpisodeCandidateDecision[];
  watermarks: readonly EpisodicProcessingWatermark[];
  now: number;
}): EpisodicMaintenanceDiagnostics {
  const decisionCountsByStatus: Record<string, number> = {};
  let canonicalDecisionCount = 0;
  let duplicateCandidateCount = 0;
  let mergeDecisionCount = 0;
  let supersessionDecisionCount = 0;
  let rejectedDecisionCount = 0;
  let reviewDecisionCount = 0;
  const queueAges: number[] = [];
  const processingLatencies: number[] = [];
  let latestProcessedAt: string | undefined;

  for (const decision of input.decisions) {
    increment(decisionCountsByStatus, decision.status);
    if (decision.status === 'canonical' || decision.status === 'accepted') canonicalDecisionCount += 1;
    if (decision.status === 'merged') {
      duplicateCandidateCount += 1;
      mergeDecisionCount += 1;
    }
    if (decision.status === 'superseded') {
      duplicateCandidateCount += 1;
      supersessionDecisionCount += 1;
    }
    if (decision.status === 'rejected') {
      duplicateCandidateCount += 1;
      rejectedDecisionCount += 1;
    }
    if (decision.status === 'needs_review') {
      reviewDecisionCount += 1;
      queueAges.push(Math.max(0, input.now - Date.parse(decision.createdAt)));
    }
  }

  let pendingWatermarkCount = 0;
  for (const watermark of input.watermarks) {
    if (watermark.status !== 'complete' || watermark.reconciliationStatus !== 'clean') {
      pendingWatermarkCount += 1;
      queueAges.push(Math.max(0, input.now - Date.parse(watermark.updatedAt)));
    }
    const processedEndedAtMs = parseOptionalInstantMs(watermark.processedEndedAt);
    const updatedAtMs = parseOptionalInstantMs(watermark.updatedAt);
    if (processedEndedAtMs !== undefined && updatedAtMs !== undefined) {
      processingLatencies.push(Math.max(0, updatedAtMs - processedEndedAtMs));
    }
    if (!latestProcessedAt || watermark.lastProcessedAt > latestProcessedAt) {
      latestProcessedAt = watermark.lastProcessedAt;
    }
  }

  const queueAgeTotal = queueAges.reduce((sum, age) => sum + age, 0);
  const processingLatencyTotal = processingLatencies.reduce((sum, latency) => sum + latency, 0);
  return {
    candidateDecisionCount: input.decisions.length,
    decisionCountsByStatus,
    canonicalDecisionCount,
    duplicateCandidateCount,
    duplicateEpisodeRate: input.decisions.length > 0
      ? duplicateCandidateCount / input.decisions.length
      : 0,
    mergeDecisionCount,
    supersessionDecisionCount,
    rejectedDecisionCount,
    reviewDecisionCount,
    watermarkCount: input.watermarks.length,
    pendingWatermarkCount,
    oldestQueueAgeMs: queueAges.length > 0 ? Math.max(...queueAges) : 0,
    averageQueueAgeMs: queueAges.length > 0 ? queueAgeTotal / queueAges.length : 0,
    averageProcessingLatencyMs: processingLatencies.length > 0
      ? processingLatencyTotal / processingLatencies.length
      : 0,
    ...(latestProcessedAt ? { latestProcessedAt } : {}),
  };
}

function normalizeOptionalUnit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  return normalizeUnit(value, field);
}

export interface NormalizedEpisodeMessageClaimWriteInput {
  episodeId: string;
  sessionId?: string;
  claimedAt?: string;
  claims: EpisodeMessageClaimEntryInput[];
}

export function normalizeEpisodeMessageClaimWriteInput(
  input: EpisodeMessageClaimWriteInput,
): NormalizedEpisodeMessageClaimWriteInput {
  const episodeId = parseRequiredText(input.episodeId, 'episodeId');
  const sessionId = parseOptionalText(input.sessionId, 'sessionId');
  if (input.claims.length === 0) {
    throw new Error('claimEpisodeMessages requires at least one source message claim');
  }
  const byKey = new Map<string, EpisodeMessageClaimEntryInput>();
  for (const claim of input.claims) {
    const claimKey = parseRequiredText(claim.claimKey, 'claims[].claimKey');
    if (byKey.has(claimKey)) {
      throw new Error(`duplicate source message claim key "${claimKey}" in claim input`);
    }
    const turnId = parseOptionalText(claim.turnId, 'claims[].turnId');
    const channelId = parseOptionalText(claim.channelId, 'claims[].channelId');
    byKey.set(claimKey, {
      claimKey,
      ...(turnId ? { turnId } : {}),
      ...(channelId ? { channelId } : {}),
    });
  }
  return {
    episodeId,
    ...(sessionId ? { sessionId } : {}),
    ...(input.claimedAt !== undefined ? { claimedAt: input.claimedAt } : {}),
    claims: [...byKey.values()],
  };
}

export interface NormalizedEpisodeClaimTransferInput {
  sourceEpisodeIds: string[];
  targetEpisodeId: string;
  reason: string;
  transferredAt?: string;
}

export function normalizeEpisodeClaimTransferInput(
  input: EpisodeClaimTransferInput,
): NormalizedEpisodeClaimTransferInput {
  const targetEpisodeId = parseRequiredText(input.targetEpisodeId, 'targetEpisodeId');
  const reason = parseRequiredText(input.reason, 'reason');
  const sourceEpisodeIds = normalizeRequiredTextList(input.sourceEpisodeIds, 'sourceEpisodeIds');
  if (sourceEpisodeIds.length === 0) {
    throw new Error('transferEpisodeMessageClaims requires at least one source episode');
  }
  if (sourceEpisodeIds.includes(targetEpisodeId)) {
    throw new Error('an episode cannot receive claims transferred from itself');
  }
  return {
    sourceEpisodeIds,
    targetEpisodeId,
    reason,
    ...(input.transferredAt !== undefined ? { transferredAt: input.transferredAt } : {}),
  };
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

function json(value: unknown): string {
  return JSON.stringify(value);
}

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
    const result = this.db.prepare(`
      UPDATE l01_episodes
      SET status = 'merged', merged_into_episode_id = ?, updated_at = ?
      WHERE id = ?
    `).run(targetId, this.now().toISOString(), sourceId);
    if (result.changes === 0) {
      throw new Error(`episode "${sourceId}" does not exist`);
    }
  }

  createEpisode(input: EpisodeCreateInput): Episode {
    const now = this.now().toISOString();
    const episode = parseEpisode({
      ...input,
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
        episode_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      episode.id,
      episode.threadId ?? null,
      episode.channelId ?? null,
      episode.startedAt,
      episode.endedAt,
      episode.salience.score,
      serializeEpisode(episode),
      episode.createdAt,
      episode.updatedAt,
    );

    return episode;
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
    if (from !== undefined) {
      where.push('ended_at >= ?');
      params.push(from);
    }
    if (to !== undefined) {
      where.push('started_at <= ?');
      params.push(to);
    }

    const rows = this.db.prepare(`
      SELECT id, episode_json
      FROM l01_episodes
      WHERE ${where.join(' AND ')}
      ORDER BY started_at ASC, id ASC
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

    const now = this.now().toISOString();
    const arc = parseEpisodeArc({
      ...input,
      schemaVersion: EPISODIC_CONTRACT_VERSION,
      id: input.id ?? this.idFactory(),
      createdAt: input.createdAt ?? now,
      updatedAt: input.updatedAt ?? input.createdAt ?? now,
    });

    this.db.prepare(`
      INSERT INTO l01_episode_arcs (
        id,
        source_episode_id,
        target_episode_id,
        arc_kind,
        salience_score,
        confidence,
        arc_json,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source_episode_id = excluded.source_episode_id,
        target_episode_id = excluded.target_episode_id,
        arc_kind = excluded.arc_kind,
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

    return arc;
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

    const where: string[] = [];
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

    const where: string[] = [];
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

      return activeClaims.map(claim => claim.claim_key).sort();
    });
    const transferredClaimKeys = transfer();

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
