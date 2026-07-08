import {
  parseEpisode,
  parseEpisodeArc,
  type Episode,
  type EpisodeArc,
  type EpisodeArtifactRef,
  type EpisodeProvenanceRef,
} from '../../../../shared/contracts/episodic-memory.js';
import type {
  EpisodeArcAuditAction,
  EpisodeArcAuditEntry,
  EpisodeCandidateDecisionStatus,
  EpisodeCandidateDecision,
  EpisodeLineageRelation,
  EpisodeMessageClaimStatus,
  EpisodeMessageClaim,
  EpisodicProcessingWatermarkScope,
  EpisodicProcessingWatermark,
  EpisodicProcessingWatermarkStatus,
  EpisodicReconciliationStatus,
} from '../store-port.js';

export interface PostgresEpisodeRow {
  id: string;
  episode_json: unknown;
}

export interface PostgresEpisodeArcRow {
  id: string;
  arc_json: unknown;
}

export interface PostgresEpisodeArcStateRow extends PostgresEpisodeArcRow {
  source_episode_id: string;
  target_episode_id: string;
  status: string | null;
  superseded_by_arc_id: string | null;
}

export interface PostgresEpisodeArcAuditRow {
  id: string;
  arc_id: string;
  action: string;
  actor: string;
  reason: string;
  details_json: unknown;
  created_at: string;
}

export interface PostgresProcessingWatermarkRow {
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

export interface PostgresCandidateDecisionRow {
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

export interface PostgresEpisodeMessageClaimRow {
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

export const DEFAULT_LIMIT = 100;
export const MAX_LIMIT = 1000;
export const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
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
export const EPISODE_LINEAGE_RELATIONS = new Set<EpisodeLineageRelation>([
  'canonicalizes',
  'merges',
  'supersedes',
  'splits_from',
  'derived_from',
  'conflicts_with',
  'updates',
]);
export const MESSAGE_CLAIM_STATUSES = new Set<EpisodeMessageClaimStatus>(['active', 'transferred']);
// Candidate episodes are live memory (the only record of the day until the
// nightly sleep cycle consolidates or confirms them), so list/search surfaces
// include them alongside canonical episodes.
export const ACTIVE_CANONICAL_EPISODE_FILTER = `
  (status IS NULL OR status IN ('canonical', 'candidate'))
  AND (canonical_episode_id IS NULL OR canonical_episode_id = id)
  AND merged_into_episode_id IS NULL
  AND superseded_by_episode_id IS NULL
`;
export const ACTIVE_CANONICAL_ARC_FILTER = `
  (status IS NULL OR status = 'canonical')
  AND (canonical_arc_id IS NULL OR canonical_arc_id = id)
  AND merged_into_arc_id IS NULL
  AND superseded_by_arc_id IS NULL
`;
const ARC_AUDIT_ACTIONS = new Set<EpisodeArcAuditAction>(['written', 'repointed', 'removed']);

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

export function parseRequiredText(value: string, field: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must be non-empty`);
  }
  return trimmed;
}

export function parseOptionalText(value: string | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  return parseRequiredText(value, field);
}

export function normalizeRequiredTextList(values: readonly string[], field: string): string[] {
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

export function normalizeUnit(value: number, field: string): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${field} must be a finite number between 0 and 1`);
  }
  return value;
}

export function normalizeOptionalUnit(value: number | undefined, field: string): number | undefined {
  if (value === undefined) return undefined;
  return normalizeUnit(value, field);
}

export function parseJsonPayload(value: unknown, label: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${label} JSON is not parseable: ${String(error)}`);
  }
}

export function parseRecordPayload(value: unknown, label: string): Record<string, unknown> {
  const parsed = parseJsonPayload(value, label);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

export function parseArrayPayload<T>(value: unknown, label: string): T[] {
  const parsed = parseJsonPayload(value, label);
  if (!Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON array`);
  }
  return parsed as T[];
}

export function parseEpisodeJson(raw: unknown, id: string): Episode {
  try {
    return parseEpisode(parseJsonPayload(raw, `episode "${id}"`));
  } catch (error) {
    throw new Error(`malformed persisted episode "${id}": ${String(error)}`);
  }
}

export function parseArcJson(raw: unknown, id: string): EpisodeArc {
  try {
    return parseEpisodeArc(parseJsonPayload(raw, `episode arc "${id}"`));
  } catch (error) {
    throw new Error(`malformed persisted episode arc "${id}": ${String(error)}`);
  }
}

export function mapEpisodeRow(row: PostgresEpisodeRow): Episode {
  const episode = parseEpisodeJson(row.episode_json, row.id);
  if (episode.id !== row.id) {
    throw new Error(`malformed persisted episode "${row.id}": JSON id mismatch`);
  }
  return episode;
}

export function mapArcRow(row: PostgresEpisodeArcRow): EpisodeArc {
  const arc = parseArcJson(row.arc_json, row.id);
  if (arc.id !== row.id) {
    throw new Error(`malformed persisted episode arc "${row.id}": JSON id mismatch`);
  }
  return arc;
}

export function mapWatermarkRow(row: PostgresProcessingWatermarkRow): EpisodicProcessingWatermark {
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

export function mapCandidateDecisionRow(row: PostgresCandidateDecisionRow): EpisodeCandidateDecision {
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

export function mapMessageClaimRow(row: PostgresEpisodeMessageClaimRow): EpisodeMessageClaim {
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
    claimedAt: new Date(row.claimed_at).toISOString(),
    ...(row.transferred_to_episode_id ? { transferredToEpisodeId: row.transferred_to_episode_id } : {}),
    ...(row.transferred_at ? { transferredAt: new Date(row.transferred_at).toISOString() } : {}),
    ...(row.reason ? { reason: row.reason } : {}),
  };
}

export function json(value: unknown): string {
  return JSON.stringify(value);
}

export function mapArcAuditRow(row: PostgresEpisodeArcAuditRow): EpisodeArcAuditEntry {
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
    detailsJson: parseRecordPayload(row.details_json, `episode arc audit "${row.id}" detailsJson`),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

export function isActivePostgresArcRow(row: Pick<PostgresEpisodeArcStateRow, 'status' | 'superseded_by_arc_id'>): boolean {
  return (row.status === null || row.status === 'canonical') && row.superseded_by_arc_id === null;
}

export function normalizeWatermarkScope(
  scope: EpisodicProcessingWatermarkScope,
): EpisodicProcessingWatermarkScope {
  return {
    processor: parseRequiredText(scope.processor, 'processor'),
    sourceRef: parseRequiredText(scope.sourceRef, 'sourceRef'),
    ...(scope.channelId !== undefined ? { channelId: parseRequiredText(scope.channelId, 'channelId') } : {}),
    ...(scope.threadId !== undefined ? { threadId: parseRequiredText(scope.threadId, 'threadId') } : {}),
    ...(scope.sessionId !== undefined ? { sessionId: parseRequiredText(scope.sessionId, 'sessionId') } : {}),
  };
}
