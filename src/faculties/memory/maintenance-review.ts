import { isRecord } from '../../shared/utils/types.js';
import { createHash } from 'node:crypto';
import type {
  MemoryMaintenanceRecommendedAction,
  MemoryMaintenanceReview,
  MemoryMaintenanceReviewCandidate,
  MemoryMaintenanceReviewInput,
  MemoryMaintenanceReviewKind,
  MemoryMaintenanceReviewListOptions,
  MemoryMaintenanceReviewState,
  MemoryMaintenanceReviewStatus,
  MemorySearchResult,
  MemoryStorePort,
} from './memory-store-port.js';
import {
  DEDUP_THRESHOLD,
  type PurrMemory,
} from './types.js';
import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('MemoryMaintenanceReview');

export const MEMORY_MAINTENANCE_REVIEW_SCHEMA_VERSION = 1;
export const NEAR_DUPLICATE_REVIEW_MARGIN = 0.08;
export const PROVENANCE_CONFIDENCE_REVIEW_THRESHOLD = 0.5;
export const PROVENANCE_CONFIDENCE_REVIEW_EVIDENCE_LIMIT = 1;

const VALID_REVIEW_KINDS = new Set<MemoryMaintenanceReviewKind>([
  'near_duplicate',
  'provenance_confidence',
  'high_impact_low_confidence',
  'stale_memory',
  'conflicting_memory',
]);
const VALID_REVIEW_STATUSES = new Set<MemoryMaintenanceReviewStatus>([
  'pending',
  'quarantined',
  'resolved',
  'dismissed',
]);
const VALID_RECOMMENDED_ACTIONS = new Set<MemoryMaintenanceRecommendedAction>([
  'review',
  'merge_candidate',
  'corroborate_or_dismiss',
  'verify_or_supersede',
  'resolve_conflict',
]);

const UNIQUE_DETAIL_STOP_WORDS = new Set([
  'about',
  'after',
  'again',
  'also',
  'because',
  'before',
  'being',
  'cannot',
  'could',
  'does',
  'from',
  'have',
  'into',
  'like',
  'likes',
  'memory',
  'more',
  'only',
  'over',
  'said',
  'says',
  'that',
  'their',
  'there',
  'they',
  'this',
  'user',
  'with',
  'would',
]);

const HIGH_IMPACT_MEMORY_TYPES = new Set<PurrMemory['type']>(['boundary', 'emotional', 'relational']);
const HIGH_IMPACT_TAG_HINTS = new Set([
  'boundary',
  'consent',
  'contact',
  'contact_profile',
  'core_profile',
  'core_relationship',
  'emotion',
  'emotional',
  'family',
  'feeling',
  'identity',
  'partner',
  'profile',
  'relationship',
  'relationship_core',
]);
const HIGH_IMPACT_TEXT_HINT = /\b(identity|profile|partner|family|boundary|consent|feeling|emotion|contact)\b/i;
const CONFLICT_TEXT_HINT = /\b(no longer|not|never|doesn't|does not|isn't|is not|aren't|are not|must not|should not|cannot|can't|won't|changed|opposite|conflict)\b/i;
const HIGH_IMPACT_LOW_CONFIDENCE_THRESHOLD = 0.65;
const STALE_MEMORY_CONFIDENCE_THRESHOLD = 0.58;
const DEFAULT_STALE_MEMORY_AGE_MS = 90 * 24 * 60 * 60 * 1000;

export interface MemoryMaintenanceReviewStore {
  upsertMemoryMaintenanceReview(input: MemoryMaintenanceReviewInput): Promise<MemoryMaintenanceReview>;
  listMemoryMaintenanceReviews(options?: MemoryMaintenanceReviewListOptions): Promise<MemoryMaintenanceReview[]>;
  getMemoryMaintenanceReview(id: string): Promise<MemoryMaintenanceReview | undefined>;
}

export interface MemoryMaintenanceSchedulerOptions {
  schedule?: (task: () => Promise<void>) => void;
  now?: () => number;
  onError?: (error: unknown) => void;
}

export interface PostWriteMaintenanceInput {
  memory: PurrMemory;
  candidates: MemorySearchResult[];
}

export interface UncertainMemoryReviewSubject {
  memoryId: string;
  text: string;
  sourceRef: string;
  provenanceRefs?: readonly string[];
  confidence: number;
  type?: PurrMemory['type'];
  tags?: readonly string[];
  sensitivity?: PurrMemory['sensitivity'];
  extractedAt?: number;
  lastAccessed?: number;
}

export interface StoredMemoryMaintenanceReviewRow {
  id: string;
  kind: string;
  status: string;
  subjectMemoryId: string;
  candidateMemoryIdsJson: string | null;
  stateJson: string | null;
  quarantineReason?: string | null;
  createdAt: number;
  updatedAt: number;
}

export class MemoryMaintenanceReviewStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MemoryMaintenanceReviewStateError';
  }
}

function normalizeReviewText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase();
}

function previewText(text: string, maxLength = 240): string {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1)}...`;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== 'string') continue;
    const normalized = entry.trim();
    if (normalized.length > 0) out.add(normalized);
  }
  return [...out];
}

function parseStoredStringArray(value: string | null): string[] {
  try {
    return normalizeStringArray(JSON.parse(value ?? '[]'));
  } catch {
    return [];
  }
}


function isReviewKind(value: unknown): value is MemoryMaintenanceReviewKind {
  return typeof value === 'string' && VALID_REVIEW_KINDS.has(value as MemoryMaintenanceReviewKind);
}

function isReviewStatus(value: unknown): value is MemoryMaintenanceReviewStatus {
  return typeof value === 'string' && VALID_REVIEW_STATUSES.has(value as MemoryMaintenanceReviewStatus);
}

function isRecommendedAction(value: unknown): value is MemoryMaintenanceRecommendedAction {
  return typeof value === 'string'
    && VALID_RECOMMENDED_ACTIONS.has(value as MemoryMaintenanceRecommendedAction);
}

function coerceReviewKind(value: unknown): MemoryMaintenanceReviewKind {
  return isReviewKind(value) ? value : 'provenance_confidence';
}

function coerceSubjectMemoryId(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : 'unknown';
}

function validateNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new MemoryMaintenanceReviewStateError(`${field} must be a finite number`);
  }
  return value;
}

function validateCandidate(value: unknown): MemoryMaintenanceReviewCandidate {
  if (!isRecord(value)) {
    throw new MemoryMaintenanceReviewStateError('candidate must be an object');
  }
  const memoryId = coerceSubjectMemoryId(value.memoryId);
  if (memoryId === 'unknown') {
    throw new MemoryMaintenanceReviewStateError('candidate memoryId is required');
  }
  if (typeof value.text !== 'string' || value.text.trim().length === 0) {
    throw new MemoryMaintenanceReviewStateError(`candidate ${memoryId} text is required`);
  }
  if (typeof value.textPreview !== 'string' || value.textPreview.trim().length === 0) {
    throw new MemoryMaintenanceReviewStateError(`candidate ${memoryId} textPreview is required`);
  }
  if (typeof value.sourceRef !== 'string' || value.sourceRef.trim().length === 0) {
    throw new MemoryMaintenanceReviewStateError(`candidate ${memoryId} sourceRef is required`);
  }
  const candidate: MemoryMaintenanceReviewCandidate = {
    memoryId,
    text: value.text,
    textPreview: value.textPreview,
    sourceRef: value.sourceRef.trim(),
    provenanceRefs: normalizeStringArray(value.provenanceRefs),
    confidence: validateNumber(value.confidence, `candidate ${memoryId} confidence`),
    uniqueDetails: normalizeStringArray(value.uniqueDetails),
  };
  if (value.similarity !== undefined) {
    candidate.similarity = validateNumber(value.similarity, `candidate ${memoryId} similarity`);
  }
  return candidate;
}

function validateUniqueDetails(value: unknown): Record<string, string[]> {
  if (!isRecord(value)) {
    throw new MemoryMaintenanceReviewStateError('uniqueDetails must be an object');
  }
  const out: Record<string, string[]> = {};
  for (const [memoryId, rawDetails] of Object.entries(value)) {
    const normalizedId = memoryId.trim();
    if (!normalizedId) {
      throw new MemoryMaintenanceReviewStateError('uniqueDetails contains an empty memory id');
    }
    out[normalizedId] = normalizeStringArray(rawDetails);
  }
  return out;
}

export function validateMemoryMaintenanceReviewState(value: unknown): MemoryMaintenanceReviewState {
  if (!isRecord(value)) {
    throw new MemoryMaintenanceReviewStateError('review state must be an object');
  }
  if (value.schemaVersion !== MEMORY_MAINTENANCE_REVIEW_SCHEMA_VERSION) {
    throw new MemoryMaintenanceReviewStateError('unsupported review state schemaVersion');
  }
  if (!isReviewKind(value.kind)) {
    throw new MemoryMaintenanceReviewStateError('review state kind is invalid');
  }
  if (!isReviewStatus(value.status)) {
    throw new MemoryMaintenanceReviewStateError('review state status is invalid');
  }
  const subjectMemoryId = coerceSubjectMemoryId(value.subjectMemoryId);
  if (subjectMemoryId === 'unknown') {
    throw new MemoryMaintenanceReviewStateError('review state subjectMemoryId is required');
  }
  if (typeof value.reason !== 'string' || value.reason.trim().length === 0) {
    throw new MemoryMaintenanceReviewStateError('review state reason is required');
  }
  if (!isRecommendedAction(value.recommendedAction)) {
    throw new MemoryMaintenanceReviewStateError('review state recommendedAction is invalid');
  }
  if (value.createdBy !== 'memory_maintenance') {
    throw new MemoryMaintenanceReviewStateError('review state createdBy is invalid');
  }
  if (!Array.isArray(value.candidates)) {
    throw new MemoryMaintenanceReviewStateError('review state candidates must be an array');
  }
  const candidates = value.candidates.map(validateCandidate);
  const candidateMemoryIds = normalizeStringArray(value.candidateMemoryIds);
  const candidateIdSet = new Set(candidates.map(candidate => candidate.memoryId));
  if (!candidateIdSet.has(subjectMemoryId)) {
    throw new MemoryMaintenanceReviewStateError('review state candidates must include the subject memory');
  }
  for (const candidateId of candidateMemoryIds) {
    if (!candidateIdSet.has(candidateId)) {
      throw new MemoryMaintenanceReviewStateError(`review state candidate ${candidateId} is missing details`);
    }
  }

  return {
    schemaVersion: MEMORY_MAINTENANCE_REVIEW_SCHEMA_VERSION,
    kind: value.kind,
    status: value.status,
    subjectMemoryId,
    candidateMemoryIds,
    reason: value.reason.trim(),
    recommendedAction: value.recommendedAction,
    sourceRefs: normalizeStringArray(value.sourceRefs),
    provenanceRefs: normalizeStringArray(value.provenanceRefs),
    uniqueDetails: validateUniqueDetails(value.uniqueDetails),
    candidates,
    createdBy: 'memory_maintenance',
    ...(isRecord(value.metadata) ? { metadata: { ...value.metadata } } : {}),
  };
}

export function buildQuarantinedMemoryMaintenanceReview(input: {
  id?: string;
  kind?: unknown;
  subjectMemoryId?: unknown;
  candidateMemoryIds?: unknown;
  createdAt?: number;
  updatedAt?: number;
  quarantineReason: string;
}): MemoryMaintenanceReview {
  const now = Date.now();
  const kind = coerceReviewKind(input.kind);
  const subjectMemoryId = coerceSubjectMemoryId(input.subjectMemoryId);
  const candidateMemoryIds = normalizeStringArray(input.candidateMemoryIds);
  const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : now;
  const updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : createdAt;
  const id = typeof input.id === 'string' && input.id.trim().length > 0
    ? input.id.trim()
    : createReviewId(kind, subjectMemoryId, candidateMemoryIds);
  const state: MemoryMaintenanceReviewState = {
    schemaVersion: MEMORY_MAINTENANCE_REVIEW_SCHEMA_VERSION,
    kind,
    status: 'quarantined',
    subjectMemoryId,
    candidateMemoryIds,
    reason: 'Malformed memory maintenance review state was quarantined.',
    recommendedAction: 'review',
    sourceRefs: [],
    provenanceRefs: [],
    uniqueDetails: {},
    candidates: [],
    createdBy: 'memory_maintenance',
    metadata: {
      quarantineReason: input.quarantineReason,
    },
  };
  return {
    id,
    kind,
    status: 'quarantined',
    subjectMemoryId,
    candidateMemoryIds,
    state,
    createdAt,
    updatedAt,
    quarantineReason: input.quarantineReason,
  };
}

export function normalizeMemoryMaintenanceReviewInput(
  input: MemoryMaintenanceReviewInput,
): MemoryMaintenanceReview {
  const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : Date.now();
  const updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : createdAt;
  try {
    const state = validateMemoryMaintenanceReviewState(input.state);
    if (state.kind !== input.kind) {
      throw new MemoryMaintenanceReviewStateError('review input kind does not match state kind');
    }
    if (state.subjectMemoryId !== input.subjectMemoryId.trim()) {
      throw new MemoryMaintenanceReviewStateError('review input subjectMemoryId does not match state');
    }
    const candidateMemoryIds = normalizeStringArray(input.candidateMemoryIds ?? state.candidateMemoryIds);
    if (candidateMemoryIds.length !== state.candidateMemoryIds.length) {
      throw new MemoryMaintenanceReviewStateError('review input candidate ids do not match state');
    }
    for (const candidateId of candidateMemoryIds) {
      if (!state.candidateMemoryIds.includes(candidateId)) {
        throw new MemoryMaintenanceReviewStateError('review input candidate ids do not match state');
      }
    }
    return {
      id: input.id?.trim() || createReviewId(input.kind, state.subjectMemoryId, state.candidateMemoryIds),
      kind: state.kind,
      status: state.status,
      subjectMemoryId: state.subjectMemoryId,
      candidateMemoryIds: state.candidateMemoryIds,
      state,
      createdAt,
      updatedAt,
      ...(state.status === 'quarantined' && typeof state.metadata?.quarantineReason === 'string'
        ? { quarantineReason: state.metadata.quarantineReason }
        : {}),
    };
  } catch (error) {
    const quarantineReason = error instanceof Error ? error.message : 'unknown malformed review state';
    return buildQuarantinedMemoryMaintenanceReview({
      id: input.id,
      kind: input.kind,
      subjectMemoryId: input.subjectMemoryId,
      candidateMemoryIds: input.candidateMemoryIds,
      createdAt,
      updatedAt,
      quarantineReason,
    });
  }
}

export function mapStoredMemoryMaintenanceReviewRow(
  row: StoredMemoryMaintenanceReviewRow,
): MemoryMaintenanceReview {
  const candidateMemoryIds = parseStoredStringArray(row.candidateMemoryIdsJson);
  try {
    const parsedState = JSON.parse(row.stateJson ?? '{}');
    const state = validateMemoryMaintenanceReviewState(parsedState);
    if (!isReviewKind(row.kind) || row.kind !== state.kind) {
      throw new MemoryMaintenanceReviewStateError('stored review kind does not match state');
    }
    if (!isReviewStatus(row.status) || row.status !== state.status) {
      throw new MemoryMaintenanceReviewStateError('stored review status does not match state');
    }
    if (row.subjectMemoryId !== state.subjectMemoryId) {
      throw new MemoryMaintenanceReviewStateError('stored review subject does not match state');
    }
    if (
      candidateMemoryIds.length !== state.candidateMemoryIds.length
      || candidateMemoryIds.some(candidateId => !state.candidateMemoryIds.includes(candidateId))
    ) {
      throw new MemoryMaintenanceReviewStateError('stored review candidates do not match state');
    }
    return {
      id: row.id,
      kind: state.kind,
      status: state.status,
      subjectMemoryId: state.subjectMemoryId,
      candidateMemoryIds: state.candidateMemoryIds,
      state,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      ...(row.quarantineReason ? { quarantineReason: row.quarantineReason } : {}),
    };
  } catch (error) {
    const quarantineReason = row.quarantineReason
      ?? (error instanceof Error ? error.message : 'stored review state is malformed');
    return buildQuarantinedMemoryMaintenanceReview({
      id: row.id,
      kind: row.kind,
      subjectMemoryId: row.subjectMemoryId,
      candidateMemoryIds,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      quarantineReason,
    });
  }
}

export function createReviewId(
  kind: MemoryMaintenanceReviewKind,
  subjectMemoryId: string,
  candidateMemoryIds: readonly string[],
): string {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({
      kind,
      subjectMemoryId,
      candidateMemoryIds: [...candidateMemoryIds].sort(),
    }))
    .digest('hex')
    .slice(0, 24);
  return `memory-maintenance:${kind}:${fingerprint}`;
}

export function collectMemoryProvenanceRefs(memory: Pick<PurrMemory, 'sourceRef' | 'provenanceRefs'>): string[] {
  return normalizeStringArray([
    memory.sourceRef,
    ...(memory.provenanceRefs ?? []),
  ]);
}

function sourceRefsForMemories(memories: readonly Pick<PurrMemory, 'sourceRef'>[]): string[] {
  return normalizeStringArray(memories.map(memory => memory.sourceRef));
}

function tokenizeForUniqueDetails(text: string): Array<{ normalized: string; original: string }> {
  const matches = text.match(/[A-Za-z0-9][A-Za-z0-9_-]{2,}/g) ?? [];
  return matches.map(original => ({
    original,
    normalized: original.toLowerCase(),
  }));
}

export function extractUniqueDetails(
  text: string,
  comparedTexts: readonly string[],
): string[] {
  const comparisonTokens = new Set(
    comparedTexts.flatMap(compared => tokenizeForUniqueDetails(compared).map(token => token.normalized)),
  );
  const details: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenizeForUniqueDetails(text)) {
    if (UNIQUE_DETAIL_STOP_WORDS.has(token.normalized)) continue;
    if (comparisonTokens.has(token.normalized)) continue;
    if (seen.has(token.normalized)) continue;
    seen.add(token.normalized);
    details.push(token.original);
    if (details.length >= 8) break;
  }
  return details.length > 0 ? details : [previewText(text, 120)];
}

function buildCandidateSummary(
  memory: PurrMemory,
  comparedTexts: readonly string[],
  similarity?: number,
): MemoryMaintenanceReviewCandidate {
  return {
    memoryId: memory.id,
    text: memory.text,
    textPreview: previewText(memory.text),
    sourceRef: memory.sourceRef,
    provenanceRefs: collectMemoryProvenanceRefs(memory),
    confidence: memory.confidence,
    uniqueDetails: extractUniqueDetails(memory.text, comparedTexts),
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

function buildUncertainCandidateSummary(
  subject: UncertainMemoryReviewSubject,
  comparedTexts: readonly string[] = [],
  similarity?: number,
): MemoryMaintenanceReviewCandidate {
  return {
    memoryId: coerceSubjectMemoryId(subject.memoryId),
    text: subject.text,
    textPreview: previewText(subject.text),
    sourceRef: subject.sourceRef,
    provenanceRefs: normalizeStringArray([
      subject.sourceRef,
      ...(subject.provenanceRefs ?? []),
    ]),
    confidence: subject.confidence,
    uniqueDetails: extractUniqueDetails(subject.text, comparedTexts),
    ...(similarity !== undefined ? { similarity } : {}),
  };
}

function buildUncertainReviewState(input: {
  kind: MemoryMaintenanceReviewKind;
  subject: UncertainMemoryReviewSubject;
  candidates?: readonly UncertainMemoryReviewSubject[];
  reason: string;
  recommendedAction: MemoryMaintenanceRecommendedAction;
  metadata?: Record<string, unknown>;
}): MemoryMaintenanceReviewState {
  const candidates = input.candidates ?? [];
  const allSubjects = [input.subject, ...candidates];
  const allTexts = allSubjects.map(subject => subject.text);
  const candidateSummaries = allSubjects.map(subject => buildUncertainCandidateSummary(
    subject,
    allTexts.filter(text => text !== subject.text),
  ));
  const uniqueDetails: Record<string, string[]> = {};
  for (const candidate of candidateSummaries) {
    uniqueDetails[candidate.memoryId] = candidate.uniqueDetails;
  }
  return {
    schemaVersion: MEMORY_MAINTENANCE_REVIEW_SCHEMA_VERSION,
    kind: input.kind,
    status: 'pending',
    subjectMemoryId: coerceSubjectMemoryId(input.subject.memoryId),
    candidateMemoryIds: candidates.map(candidate => coerceSubjectMemoryId(candidate.memoryId)),
    reason: input.reason,
    recommendedAction: input.recommendedAction,
    sourceRefs: normalizeStringArray(allSubjects.map(subject => subject.sourceRef)),
    provenanceRefs: normalizeStringArray(allSubjects.flatMap(subject => [
      subject.sourceRef,
      ...(subject.provenanceRefs ?? []),
    ])),
    uniqueDetails,
    candidates: candidateSummaries,
    createdBy: 'memory_maintenance',
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function buildReviewState(input: {
  kind: MemoryMaintenanceReviewKind;
  status?: MemoryMaintenanceReviewStatus;
  subject: PurrMemory;
  candidates: MemorySearchResult[];
  reason: string;
  recommendedAction: MemoryMaintenanceRecommendedAction;
  metadata?: Record<string, unknown>;
}): MemoryMaintenanceReviewState {
  const allMemories = [input.subject, ...input.candidates];
  const allTexts = allMemories.map(memory => memory.text);
  const candidateSummaries = [
    buildCandidateSummary(input.subject, allTexts.filter(text => text !== input.subject.text)),
    ...input.candidates.map(candidate => (
      buildCandidateSummary(candidate, allTexts.filter(text => text !== candidate.text), candidate.similarity)
    )),
  ];
  const candidateMemoryIds = input.candidates.map(candidate => candidate.id);
  const uniqueDetails: Record<string, string[]> = {};
  for (const candidate of candidateSummaries) {
    uniqueDetails[candidate.memoryId] = candidate.uniqueDetails;
  }
  return {
    schemaVersion: MEMORY_MAINTENANCE_REVIEW_SCHEMA_VERSION,
    kind: input.kind,
    status: input.status ?? 'pending',
    subjectMemoryId: input.subject.id,
    candidateMemoryIds,
    reason: input.reason,
    recommendedAction: input.recommendedAction,
    sourceRefs: sourceRefsForMemories(allMemories),
    provenanceRefs: normalizeStringArray(allMemories.flatMap(collectMemoryProvenanceRefs)),
    uniqueDetails,
    candidates: candidateSummaries,
    createdBy: 'memory_maintenance',
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

export function selectNearDuplicateReviewCandidates(
  subject: PurrMemory,
  candidates: readonly MemorySearchResult[],
): MemorySearchResult[] {
  const minSimilarity = Math.max(0, DEDUP_THRESHOLD[subject.type] - NEAR_DUPLICATE_REVIEW_MARGIN);
  const subjectText = normalizeReviewText(subject.text);
  const out: MemorySearchResult[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (candidate.id === subject.id) continue;
    if (candidate.type !== subject.type) continue;
    if (candidate.similarity < minSimilarity) continue;
    if (normalizeReviewText(candidate.text) === subjectText) continue;
    if (subject.contactId && candidate.contactId !== subject.contactId) continue;
    if (
      subject.scopeRef
      && (
        candidate.scopeRef?.kind !== subject.scopeRef.kind
        || candidate.scopeRef.id !== subject.scopeRef.id
      )
    ) {
      continue;
    }
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
    if (out.length >= 5) break;
  }
  return out;
}

export function buildNearDuplicateReviewInput(
  subject: PurrMemory,
  candidates: readonly MemorySearchResult[],
  now: number = Date.now(),
): MemoryMaintenanceReviewInput | null {
  const selected = selectNearDuplicateReviewCandidates(subject, candidates);
  if (selected.length === 0) return null;
  const state = buildReviewState({
    kind: 'near_duplicate',
    subject,
    candidates: selected,
    reason: 'Near-duplicate memory candidates need human or maintenance review before merge.',
    recommendedAction: 'merge_candidate',
    metadata: {
      minSimilarity: Math.max(0, DEDUP_THRESHOLD[subject.type] - NEAR_DUPLICATE_REVIEW_MARGIN),
    },
  });
  return {
    id: createReviewId('near_duplicate', subject.id, state.candidateMemoryIds),
    kind: 'near_duplicate',
    subjectMemoryId: subject.id,
    candidateMemoryIds: state.candidateMemoryIds,
    state,
    createdAt: now,
    updatedAt: now,
  };
}

export function shouldQueueProvenanceConfidenceReview(memory: PurrMemory): boolean {
  if (memory.confidence >= PROVENANCE_CONFIDENCE_REVIEW_THRESHOLD) return false;
  return collectMemoryProvenanceRefs(memory).length <= PROVENANCE_CONFIDENCE_REVIEW_EVIDENCE_LIMIT;
}

export function buildProvenanceConfidenceReviewInput(
  memory: PurrMemory,
  now: number = Date.now(),
): MemoryMaintenanceReviewInput | null {
  if (!shouldQueueProvenanceConfidenceReview(memory)) return null;
  const state = buildReviewState({
    kind: 'provenance_confidence',
    subject: memory,
    candidates: [],
    reason: 'Low-confidence memory has insufficient independent provenance.',
    recommendedAction: 'corroborate_or_dismiss',
    metadata: {
      confidence: memory.confidence,
      provenanceEvidenceCount: collectMemoryProvenanceRefs(memory).length,
      confidenceThreshold: PROVENANCE_CONFIDENCE_REVIEW_THRESHOLD,
    },
  });
  return {
    id: createReviewId('provenance_confidence', memory.id, []),
    kind: 'provenance_confidence',
    subjectMemoryId: memory.id,
    candidateMemoryIds: [],
    state,
    createdAt: now,
    updatedAt: now,
  };
}

function normalizedTagsForImpact(tags: readonly string[] | undefined): string[] {
  return normalizeStringArray(tags).map(tag => tag.toLowerCase().replace(/[^a-z0-9]+/g, '_'));
}

export function isHighImpactMemorySubject(
  memory: Pick<PurrMemory, 'type' | 'tags' | 'text' | 'contactId'> | UncertainMemoryReviewSubject,
): boolean {
  const type = 'type' in memory ? memory.type : undefined;
  const tags = normalizedTagsForImpact('tags' in memory ? memory.tags : undefined);
  return (
    (type !== undefined && HIGH_IMPACT_MEMORY_TYPES.has(type))
    || ('contactId' in memory && typeof memory.contactId === 'string' && memory.contactId.trim().length > 0)
    || tags.some(tag => HIGH_IMPACT_TAG_HINTS.has(tag))
    || HIGH_IMPACT_TEXT_HINT.test(memory.text)
  );
}

export function shouldQueueHighImpactLowConfidenceReview(
  memory: Pick<PurrMemory, 'type' | 'tags' | 'text' | 'confidence' | 'contactId'> | UncertainMemoryReviewSubject,
): boolean {
  if (!isHighImpactMemorySubject(memory)) return false;
  return memory.confidence < HIGH_IMPACT_LOW_CONFIDENCE_THRESHOLD;
}

export function buildHighImpactLowConfidenceReviewInput(
  subject: UncertainMemoryReviewSubject,
  now: number = Date.now(),
): MemoryMaintenanceReviewInput | null {
  if (!shouldQueueHighImpactLowConfidenceReview(subject)) return null;
  const state = buildUncertainReviewState({
    kind: 'high_impact_low_confidence',
    subject,
    reason: 'High-impact memory candidate has low confidence and needs review before it becomes active memory.',
    recommendedAction: 'corroborate_or_dismiss',
    metadata: {
      confidence: subject.confidence,
      confidenceThreshold: HIGH_IMPACT_LOW_CONFIDENCE_THRESHOLD,
      type: subject.type,
      tags: normalizeStringArray(subject.tags),
      sensitivity: subject.sensitivity,
    },
  });
  return {
    id: createReviewId('high_impact_low_confidence', state.subjectMemoryId, []),
    kind: 'high_impact_low_confidence',
    subjectMemoryId: state.subjectMemoryId,
    candidateMemoryIds: [],
    state,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildStaleMemoryReviewInput(
  memory: PurrMemory,
  now: number = Date.now(),
  staleAgeMs: number = DEFAULT_STALE_MEMORY_AGE_MS,
): MemoryMaintenanceReviewInput | null {
  const recency = Math.max(memory.lastAccessed, memory.extractedAt);
  const ageMs = Math.max(0, now - recency);
  if (ageMs < staleAgeMs) return null;
  if (!isHighImpactMemorySubject(memory) && memory.confidence >= STALE_MEMORY_CONFIDENCE_THRESHOLD) return null;
  if (memory.confidence >= HIGH_IMPACT_LOW_CONFIDENCE_THRESHOLD && !isHighImpactMemorySubject(memory)) return null;
  const subject: UncertainMemoryReviewSubject = {
    memoryId: memory.id,
    text: memory.text,
    sourceRef: memory.sourceRef,
    provenanceRefs: collectMemoryProvenanceRefs(memory),
    confidence: memory.confidence,
    type: memory.type,
    tags: memory.tags,
    sensitivity: memory.sensitivity,
    extractedAt: memory.extractedAt,
    lastAccessed: memory.lastAccessed,
  };
  const state = buildUncertainReviewState({
    kind: 'stale_memory',
    subject,
    reason: 'Stale memory has high impact or low confidence and should be verified before use or supersession.',
    recommendedAction: 'verify_or_supersede',
    metadata: {
      ageMs,
      staleAgeMs,
      confidence: memory.confidence,
      lastAccessed: memory.lastAccessed,
      extractedAt: memory.extractedAt,
    },
  });
  return {
    id: createReviewId('stale_memory', memory.id, []),
    kind: 'stale_memory',
    subjectMemoryId: memory.id,
    candidateMemoryIds: [],
    state,
    createdAt: now,
    updatedAt: now,
  };
}

function memoryTextsConflict(left: string, right: string): boolean {
  return CONFLICT_TEXT_HINT.test(left) || CONFLICT_TEXT_HINT.test(right);
}

export function buildConflictingMemoryReviewInput(
  subject: PurrMemory,
  candidates: readonly PurrMemory[],
  now: number = Date.now(),
): MemoryMaintenanceReviewInput | null {
  const selected = candidates
    .filter(candidate => candidate.id !== subject.id)
    .filter(candidate => candidate.type === subject.type)
    .filter(candidate => (
      isHighImpactMemorySubject(subject)
      || isHighImpactMemorySubject(candidate)
      || memoryTextsConflict(subject.text, candidate.text)
    ))
    .slice(0, 5);
  if (selected.length === 0) return null;
  const subjectInput: UncertainMemoryReviewSubject = {
    memoryId: subject.id,
    text: subject.text,
    sourceRef: subject.sourceRef,
    provenanceRefs: collectMemoryProvenanceRefs(subject),
    confidence: subject.confidence,
    type: subject.type,
    tags: subject.tags,
    sensitivity: subject.sensitivity,
  };
  const candidateInputs = selected.map<UncertainMemoryReviewSubject>(candidate => ({
    memoryId: candidate.id,
    text: candidate.text,
    sourceRef: candidate.sourceRef,
    provenanceRefs: collectMemoryProvenanceRefs(candidate),
    confidence: candidate.confidence,
    type: candidate.type,
    tags: candidate.tags,
    sensitivity: candidate.sensitivity,
  }));
  const state = buildUncertainReviewState({
    kind: 'conflicting_memory',
    subject: subjectInput,
    candidates: candidateInputs,
    reason: 'Potentially conflicting memories need explicit review before destructive reconciliation.',
    recommendedAction: 'resolve_conflict',
    metadata: {
      candidateCount: selected.length,
      subjectConfidence: subject.confidence,
    },
  });
  return {
    id: createReviewId('conflicting_memory', subject.id, state.candidateMemoryIds),
    kind: 'conflicting_memory',
    subjectMemoryId: subject.id,
    candidateMemoryIds: state.candidateMemoryIds,
    state,
    createdAt: now,
    updatedAt: now,
  };
}

export function hasMemoryMaintenanceReviewStore(
  store: MemoryStorePort,
): store is MemoryStorePort & MemoryMaintenanceReviewStore {
  return typeof store.upsertMemoryMaintenanceReview === 'function'
    && typeof store.listMemoryMaintenanceReviews === 'function'
    && typeof store.getMemoryMaintenanceReview === 'function';
}

function defaultSchedule(task: () => Promise<void>): void {
  setTimeout(() => {
    void task();
  }, 0);
}

export class MemoryMaintenanceScheduler {
  private readonly schedule: (task: () => Promise<void>) => void;
  private readonly now: () => number;
  private readonly onError: (error: unknown) => void;

  constructor(
    private readonly store: MemoryStorePort,
    options: MemoryMaintenanceSchedulerOptions = {},
  ) {
    this.schedule = options.schedule ?? defaultSchedule;
    this.now = options.now ?? Date.now;
    this.onError = options.onError ?? ((error) => {
      log.warn('Memory maintenance review task failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  queuePostWriteReview(input: PostWriteMaintenanceInput): void {
    if (!hasMemoryMaintenanceReviewStore(this.store)) return;
    this.schedule(async () => {
      try {
        await this.runPostWriteReview(input);
      } catch (error) {
        this.onError(error);
      }
    });
  }

  async runPostWriteReview(input: PostWriteMaintenanceInput): Promise<void> {
    if (!hasMemoryMaintenanceReviewStore(this.store)) return;
    const now = this.now();
    const nearDuplicateReview = buildNearDuplicateReviewInput(input.memory, input.candidates, now);
    if (nearDuplicateReview) {
      await this.store.upsertMemoryMaintenanceReview(nearDuplicateReview);
    }
    const provenanceReview = buildProvenanceConfidenceReviewInput(input.memory, now);
    if (provenanceReview) {
      await this.store.upsertMemoryMaintenanceReview(provenanceReview);
    }
    const highImpactReview = buildHighImpactLowConfidenceReviewInput({
      memoryId: input.memory.id,
      text: input.memory.text,
      sourceRef: input.memory.sourceRef,
      provenanceRefs: collectMemoryProvenanceRefs(input.memory),
      confidence: input.memory.confidence,
      type: input.memory.type,
      tags: input.memory.tags,
      sensitivity: input.memory.sensitivity,
      extractedAt: input.memory.extractedAt,
      lastAccessed: input.memory.lastAccessed,
    }, now);
    if (highImpactReview) {
      await this.store.upsertMemoryMaintenanceReview(highImpactReview);
    }
    const conflictReview = buildConflictingMemoryReviewInput(input.memory, input.candidates, now);
    if (conflictReview) {
      await this.store.upsertMemoryMaintenanceReview(conflictReview);
    }
  }
}
