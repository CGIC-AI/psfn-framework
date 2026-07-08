import type {
  Episode,
  EpisodeArc,
  EpisodeArcKind,
  EpisodeArtifactRef,
  EpisodeProvenanceRef,
} from '../../../shared/contracts/episodic-memory.js';

/**
 * Episode lifecycle status for the candidate-then-consolidate model.
 *
 * - `candidate`: near-real-time synthesis output awaiting the nightly
 *   sleep-cycle pass. Candidates stay fully live for retrieval (they are the
 *   only record of the day until the sleep cycle runs).
 * - `canonical`: confirmed by a sleep cycle, produced by consolidation, or a
 *   legacy episode predating candidate tracking (stored as NULL).
 *
 * Merged/superseded episodes are tracked by their own columns and are never
 * live regardless of lifecycle status.
 */
export type EpisodeLifecycleStatus = 'candidate' | 'canonical';

export type EpisodeCreateInput = Omit<
  Episode,
  'schemaVersion' | 'id' | 'createdAt' | 'updatedAt'
> & {
  id?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Defaults to 'canonical'; near-real-time synthesis passes 'candidate'. */
  lifecycleStatus?: EpisodeLifecycleStatus;
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
  /**
   * Who/why for the arc-audit trail. Optional on write (legacy callers);
   * every mutation surface below requires it.
   */
  audit?: EpisodeArcMutationAudit;
};

/**
 * Arc-membership mutations are audited: who (a provenance actor string such
 * as 'arc_formation_pass' or 'consolidation_repoint'), when, and why.
 */
export interface EpisodeArcMutationAudit {
  actor: string;
  reason: string;
}

export type EpisodeArcAuditAction = 'written' | 'repointed' | 'removed';

export interface EpisodeArcAuditEntry {
  id: string;
  arcId: string;
  action: EpisodeArcAuditAction;
  actor: string;
  reason: string;
  detailsJson: Record<string, unknown>;
  createdAt: string;
}

export interface EpisodeArcAuditListOptions {
  arcId?: string;
  limit?: number;
}

export interface EpisodeArcRemoveInput {
  arcId: string;
  actor: string;
  reason: string;
}

export interface EpisodeArcRepointInput {
  /** Episode whose arc memberships move (typically a superseded/merged source). */
  fromEpisodeId: string;
  /** Live episode that takes over the memberships (typically the consolidated target). */
  toEpisodeId: string;
  actor: string;
  reason: string;
}

export interface EpisodeArcRepointResult {
  repointedArcIds: string[];
  /** Arcs retired because re-pointing made them self-loops or duplicates. */
  removedArcIds: string[];
}

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
  /** Arc memberships moved from superseded sources onto the target. */
  repointedArcIds: string[];
  /** Arcs retired during re-pointing (self-loops/duplicates); never deleted. */
  removedArcIds: string[];
}

export interface EpisodeListOptions {
  limit?: number;
  offset?: number;
}

export interface EpisodeTimeSearchOptions extends EpisodeListOptions {
  from?: string;
  to?: string;
  /**
   * Restrict to one lifecycle status. 'canonical' includes legacy episodes
   * stored without an explicit status. Omitted => all live episodes.
   */
  lifecycleStatus?: EpisodeLifecycleStatus;
  /**
   * Restrict to episodes belonging to one session. Episodes are scoped by
   * their threadId, which synthesis sets equal to the session id, so this
   * matches the episode's thread_id. Omitted => episodes from every session.
   */
  sessionId?: string;
  /**
   * Order results by start time. Defaults to 'asc' (oldest first). Use 'desc'
   * when a capped query must include the most recent episodes rather than
   * starving them behind an older backlog.
   */
  order?: 'asc' | 'desc';
}

export interface EpisodeArcListOptions {
  direction?: 'incoming' | 'outgoing' | 'both';
  arcKind?: EpisodeArcKind;
  limit?: number;
}

export interface EpisodicStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
  /** Optional per-companion Postgres schema; pins the pool's search_path. */
  schema?: string;
}

export type EpisodicStoreResult<T> = T | Promise<T>;

export interface EpisodicStorePort {
  createEpisode(input: EpisodeCreateInput): EpisodicStoreResult<Episode>;
  updateEpisode(input: EpisodeUpdateInput): EpisodicStoreResult<Episode>;
  /** Folds an episode into a canonical target: it stops appearing in list/search results but remains retrievable by id. */
  markEpisodeMerged(episodeId: string, mergedIntoEpisodeId: string): EpisodicStoreResult<void>;
  /**
   * Sleep-cycle confirmation: promotes a live candidate episode to canonical.
   * Idempotent for already-canonical live episodes; fails closed when the
   * episode does not exist or is no longer live (merged/superseded).
   */
  confirmEpisodeCanonical(episodeId: string): EpisodicStoreResult<void>;
  getEpisode(id: string): EpisodicStoreResult<Episode | undefined>;
  getEpisodesByIds(ids: readonly string[]): EpisodicStoreResult<Episode[]>;
  listEpisodes(options?: EpisodeListOptions): EpisodicStoreResult<Episode[]>;
  searchByTime(options?: EpisodeTimeSearchOptions): EpisodicStoreResult<Episode[]>;
  searchByThread(threadId: string, options?: EpisodeListOptions): EpisodicStoreResult<Episode[]>;
  writeEpisodeArc(input: EpisodeArcWriteInput): EpisodicStoreResult<EpisodeArc>;
  /**
   * Retires one active arc (an episode "leaves" the arc). The row is kept
   * with status 'superseded' plus an audit entry — never deleted. Fails
   * closed for unknown or already-retired arcs.
   */
  removeEpisodeArc(input: EpisodeArcRemoveInput): EpisodicStoreResult<void>;
  /**
   * Atomically moves every active arc membership of `fromEpisodeId` onto
   * `toEpisodeId` (consolidation supersession must not leave dangling arc
   * members). Re-pointed arcs that become self-loops or duplicates of an
   * existing active arc are retired instead. Every touched arc gets an
   * audit entry. The target episode must exist and be live.
   */
  repointEpisodeArcMemberships(input: EpisodeArcRepointInput): EpisodicStoreResult<EpisodeArcRepointResult>;
  listEpisodeArcAudit(options?: EpisodeArcAuditListOptions): EpisodicStoreResult<EpisodeArcAuditEntry[]>;
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

export const ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const EPISODE_LIFECYCLE_STATUSES = new Set<EpisodeLifecycleStatus>(['candidate', 'canonical']);

export function isCanonicalIsoInstant(value: string): boolean {
  return ISO_INSTANT_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}


export function normalizeEpisodeArcMutationAudit(
  audit: EpisodeArcMutationAudit,
  label: string,
): EpisodeArcMutationAudit {
  return {
    actor: parseRequiredText(audit.actor, `${label}.actor`),
    reason: parseRequiredText(audit.reason, `${label}.reason`),
  };
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

export function normalizeOptionalUnit(value: number | undefined, field: string): number | undefined {
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

export function normalizeEpisodeLifecycleStatus(
  value: EpisodeLifecycleStatus | undefined,
): EpisodeLifecycleStatus {
  if (value === undefined) return 'canonical';
  if (!EPISODE_LIFECYCLE_STATUSES.has(value)) {
    throw new Error(`episode lifecycleStatus is not supported: ${String(value)}`);
  }
  return value;
}

/**
 * SQL predicate for one lifecycle status. Legacy rows store NULL and count
 * as canonical; merged/superseded rows are excluded by the live filters.
 */
