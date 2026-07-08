import type Database from 'better-sqlite3';
import {
  parseEpisode,
  parseEpisodeArc,
  type Episode,
  type EpisodeArc,
  type EpisodeArtifactRef,
  type EpisodeProvenanceRef,
} from '../../../shared/contracts/episodic-memory.js';
import {
  ISO_INSTANT_PATTERN,
  parseRequiredText,
  type EpisodeArcAuditAction,
  type EpisodeArcAuditEntry,
  type EpisodeCandidateDecision,
  type EpisodeCandidateDecisionStatus,
  type EpisodeLifecycleStatus,
  type EpisodeMessageClaim,
  type EpisodeMessageClaimStatus,
  type EpisodicProcessingWatermark,
  type EpisodicProcessingWatermarkScope,
  type EpisodicProcessingWatermarkStatus,
  type EpisodicReconciliationStatus,
} from './store-port.js';

export interface EpisodeRow {
  id: string;
  episode_json: string;
}

export interface EpisodeArcRow {
  id: string;
  arc_json: string;
}

export interface EpisodeArcStateRow extends EpisodeArcRow {
  source_episode_id: string;
  target_episode_id: string;
  status: string | null;
  superseded_by_arc_id: string | null;
}

export interface EpisodeArcAuditRow {
  id: string;
  arc_id: string;
  action: string;
  actor: string;
  reason: string;
  details_json: string;
  created_at: string;
}

export interface ProcessingWatermarkRow {
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

export interface EpisodeMessageClaimRow {
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

export interface EpisodeCandidateDecisionRow {
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
export const MAX_LIMIT = 1000;
export const WATERMARK_STATUSES = new Set<EpisodicProcessingWatermarkStatus>(['active', 'reconciling', 'blocked', 'complete']);
export const RECONCILIATION_STATUSES = new Set<EpisodicReconciliationStatus>(['pending', 'clean', 'needs_review', 'blocked']);
export const CANDIDATE_DECISION_STATUSES = new Set<EpisodeCandidateDecisionStatus>([
  'pending',
  'accepted',
  'canonical',
  'merged',
  'superseded',
  'rejected',
  'needs_review',
]);
export const MESSAGE_CLAIM_STATUSES = new Set<EpisodeMessageClaimStatus>(['active', 'transferred']);
const ARC_AUDIT_ACTIONS = new Set<EpisodeArcAuditAction>(['written', 'repointed', 'removed']);
/**
 * SQL predicate for arcs that are live memberships. Legacy rows store NULL
 * status and count as canonical; retired arcs are kept but excluded.
 */
export const ACTIVE_ARC_PREDICATE = "(status IS NULL OR status = 'canonical') AND superseded_by_arc_id IS NULL";

export function createEpisodicSchema(db: Database.Database): void {
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
      status TEXT,
      superseded_by_arc_id TEXT,
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

    CREATE TABLE IF NOT EXISTS l01_episode_arc_audit (
      id TEXT PRIMARY KEY,
      arc_id TEXT NOT NULL,
      action TEXT NOT NULL,
      actor TEXT NOT NULL,
      reason TEXT NOT NULL,
      details_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (action IN ('written', 'repointed', 'removed')),
      FOREIGN KEY (arc_id) REFERENCES l01_episode_arcs(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_l01_episode_arc_audit_arc
      ON l01_episode_arc_audit(arc_id, created_at ASC);

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

export function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}`);
  }
  return limit;
}

export function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined) return 0;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error('offset must be a non-negative integer');
  }
  return offset;
}

export function normalizeInstant(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!ISO_INSTANT_PATTERN.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new Error(`${field} must be a canonical ISO-8601 UTC instant`);
  }
  return trimmed;
}

export function parseEpisodeJson(raw: string, id: string): Episode {
  try {
    return parseEpisode(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`malformed persisted episode "${id}": ${String(error)}`);
  }
}

export function parseArcJson(raw: string, id: string): EpisodeArc {
  try {
    return parseEpisodeArc(JSON.parse(raw) as unknown);
  } catch (error) {
    throw new Error(`malformed persisted episode arc "${id}": ${String(error)}`);
  }
}

export function parseJsonPayload(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} JSON is not parseable: ${String(error)}`);
  }
}

export function parseRecordJson(raw: string, label: string): Record<string, unknown> {
  const parsed = parseJsonPayload(raw, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseArrayJson<T>(raw: string, label: string): T[] {
  const parsed = parseJsonPayload(raw, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed as T[];
}

export function mapEpisodeRow(row: EpisodeRow): Episode {
  const episode = parseEpisodeJson(row.episode_json, row.id);
  if (episode.id !== row.id) {
    throw new Error(`malformed persisted episode "${row.id}": JSON id mismatch`);
  }
  return episode;
}

export function mapArcRow(row: EpisodeArcRow): EpisodeArc {
  const arc = parseArcJson(row.arc_json, row.id);
  if (arc.id !== row.id) {
    throw new Error(`malformed persisted episode arc "${row.id}": JSON id mismatch`);
  }
  return arc;
}

export function mapWatermarkRow(row: ProcessingWatermarkRow): EpisodicProcessingWatermark {
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

export function mapCandidateDecisionRow(row: EpisodeCandidateDecisionRow): EpisodeCandidateDecision {
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

export function mapMessageClaimRow(row: EpisodeMessageClaimRow): EpisodeMessageClaim {
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

export function mapArcAuditRow(row: EpisodeArcAuditRow): EpisodeArcAuditEntry {
  const action = row.action as EpisodeArcAuditAction;
  if (!ARC_AUDIT_ACTIONS.has(action)) {
    throw new Error(`malformed persisted episode arc audit "${row.id}": unsupported action`);
  }
  return {
    id: row.id,
    arcId: row.arc_id,
    action,
    actor: row.actor,
    reason: row.reason,
    detailsJson: parseRecordJson(row.details_json, `episode arc audit "${row.id}" detailsJson`),
    createdAt: row.created_at,
  };
}

export function isActiveArcStateRow(row: Pick<EpisodeArcStateRow, 'status' | 'superseded_by_arc_id'>): boolean {
  return (row.status === null || row.status === 'canonical') && row.superseded_by_arc_id === null;
}

export function lifecycleStatusPredicate(status: EpisodeLifecycleStatus): string {
  return status === 'candidate'
    ? "status = 'candidate'"
    : "(status IS NULL OR status = 'canonical')";
}

export function normalizeWatermarkScope(scope: EpisodicProcessingWatermarkScope): EpisodicProcessingWatermarkScope {
  return {
    processor: parseRequiredText(scope.processor, 'processor'),
    sourceRef: parseRequiredText(scope.sourceRef, 'sourceRef'),
    ...(scope.channelId !== undefined ? { channelId: parseRequiredText(scope.channelId, 'channelId') } : {}),
    ...(scope.threadId !== undefined ? { threadId: parseRequiredText(scope.threadId, 'threadId') } : {}),
    ...(scope.sessionId !== undefined ? { sessionId: parseRequiredText(scope.sessionId, 'sessionId') } : {}),
  };
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}
