import {
  ACTIVE_CONCERN_OWNERS,
  ACTIVE_CONCERN_SENSITIVITIES,
  normalizeConcernEvidenceRefs,
  normalizeConcernStatus,
  normalizeOptionalConcernIcpRootInitiationId,
  type ActiveConcern,
  type ActiveConcernEvidenceRef,
  type ActiveConcernOwner,
  type ActiveConcernSensitivity,
} from '../concerns.js';
import { normalizeOptionalIcpRootInitiationId } from '../pending-follow-up-normalization.js';
import { CHANNEL_TYPES as RUNTIME_CHANNEL_TYPES, type ChannelType } from '../../../shared/contracts/runtime.js';
export { clampListLimit, MAX_LIST_LIMIT } from '../list-limit.js';

export interface ActiveConcernPgRow {
  id: string;
  text: string;
  priority: string;
  source: string;
  status: string | null;
  created_at: string;
  expires_at: string;
  salience: number | string | null;
  sensitivity: string | null;
  owner: string | null;
  evidence_refs: unknown;
  resolution_evidence_refs: unknown;
  resolved_at: string | null;
  resolution_outcome: string | null;
  contact_id: string | null;
  formation_vad: unknown;
  resolution_vad: unknown;
  resolution_generation_id: string | null;
  last_reviewed_at: string | null;
  next_review_at: string | null;
  merged_from_ids: unknown;
  split_from_id: string | null;
  origin_icp_root_initiation_id: string | null;
  candidate_review_snapshot: unknown;
}

export interface PendingFollowUpRow {
  id: string;
  content: string;
  priority: string;
  timing: string;
  created_at: string;
  channel_id: string;
  channel_type: string;
  author_id: string;
  author_name: string;
  due_at: string | null;
  contact_id: string | null;
  source_message_id: string | null;
  context_summary: string | null;
  wake_conditions: string | null;
  activated_at: string | null;
  activation_reason: string | null;
  dampened_at: string | null;
  dampening_reason: string | null;
  origin_icp_root_initiation_id: string | null;
  formation_vad: unknown;
  completion_vad: unknown;
}

export interface BehavioralPatternRow {
  id: string;
  contact_id: string;
  source_message_id: string;
  strategy: string;
  response_excerpt: string;
  created_at: string;
  outcome_score: number | null;
  outcome_observed_at: string | null;
  outcome_source_message_id: string | null;
  promoted_at: string | null;
  promoted_memory_id: string | null;
}

export interface BehavioralPatternSummaryRow {
  strategy: string;
  sample_count: number;
  resolved_count: number;
  pending_count: number;
  average_outcome: number | null;
  positive_count: number;
  negative_count: number;
  last_outcome_at: string | null;
}

export const ACTIVE_CONCERN_PRIORITIES = ['high', 'medium', 'low'] as const;
export const ACTIVE_CONCERN_SOURCES = ['appraisal', 'agent', 'heartbeat'] as const;
export const PENDING_FOLLOW_UP_PRIORITIES = ['low', 'medium', 'high'] as const;
export const PENDING_FOLLOW_UP_TIMINGS = ['immediate', 'soon', 'scheduled'] as const;
export const PENDING_FOLLOW_UP_WAKE_CONDITIONS = [
  'next_user_turn',
  'background_recheck',
  'sustained_negative_mood',
] as const;
type SharedPendingFollowUpWakeCondition = typeof PENDING_FOLLOW_UP_WAKE_CONDITIONS[number];
export const CHANNEL_TYPES = RUNTIME_CHANNEL_TYPES;
export const BEHAVIORAL_RESPONSE_STRATEGIES = [
  'empathy',
  'humor',
  'technical',
  'redirect',
  'validation',
  'questioning',
  'direct',
  'supportive',
] as const;

export const MAX_CONCERN_TEXT_CHARS = 500;
export const MAX_CONCERN_RESOLUTION_CHARS = 400;
export const MAX_PENDING_TEXT_CHARS = 500;
export const MAX_PENDING_ID_CHARS = 128;
export const MAX_PENDING_REASON_CHARS = 240;
export const MAX_PENDING_SUMMARY_CHARS = 320;
export const MAX_CONTACT_ID_CHARS = 160;
export const MAX_MESSAGE_ID_CHARS = 200;
export const MAX_RESPONSE_EXCERPT_CHARS = 240;
export const MAX_PROMOTION_MEMORY_ID_CHARS = 128;
export const DEFAULT_CONCERN_LIST_LIMIT = 32;
export const DEFAULT_PENDING_LIST_LIMIT = 32;
export const DEFAULT_RECENT_RESOLUTION_WINDOW_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_RECENT_RESOLUTION_LIMIT = 8;
export const DEFAULT_BEHAVIORAL_LIST_LIMIT = 50;
export const DEFAULT_BEHAVIORAL_SUMMARY_LIMIT = 4;
export const MAX_BEHAVIORAL_SUMMARY_LIMIT = 12;
export const DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION = 3;
export const DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION = 0.2;
export const CONCERN_DUPLICATE_SIMILARITY_THRESHOLD = 0.72;
export function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Field "${fieldName}" is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Field "${fieldName}" exceeds max length (${maxChars})`);
  }
  return normalized;
}

export function normalizeOptionalText(
  value: string | undefined | null,
  fieldName: string,
  maxChars: number,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  const normalized = compactWhitespace(value);
  if (!normalized) return undefined;
  if (normalized.length > maxChars) {
    throw new Error(`Field "${fieldName}" exceeds max length (${maxChars})`);
  }
  return normalized;
}

export function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, 128);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Field "${fieldName}" must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

export function normalizePriority(value: string): 'high' | 'medium' | 'low' {
  if (!ACTIVE_CONCERN_PRIORITIES.includes(value as (typeof ACTIVE_CONCERN_PRIORITIES)[number])) {
    throw new Error(`Unsupported active concern priority: ${value}`);
  }
  return value as 'high' | 'medium' | 'low';
}

export function normalizeSource(value: string): 'appraisal' | 'agent' | 'heartbeat' {
  if (!ACTIVE_CONCERN_SOURCES.includes(value as (typeof ACTIVE_CONCERN_SOURCES)[number])) {
    throw new Error(`Unsupported active concern source: ${value}`);
  }
  return value as 'appraisal' | 'agent' | 'heartbeat';
}

export function normalizeStatus(value: string | null | undefined) {
  return normalizeConcernStatus(value ?? 'active');
}

export function normalizeSensitivity(value: string | null | undefined): ActiveConcernSensitivity {
  const normalized = value ?? 'personal';
  if (!ACTIVE_CONCERN_SENSITIVITIES.includes(normalized as ActiveConcernSensitivity)) {
    throw new Error(`Unsupported active concern sensitivity: ${String(value)}`);
  }
  return normalized as ActiveConcernSensitivity;
}

export function normalizeOwner(value: string | null | undefined): ActiveConcernOwner {
  const normalized = value ?? 'companion';
  if (!ACTIVE_CONCERN_OWNERS.includes(normalized as ActiveConcernOwner)) {
    throw new Error(`Unsupported active concern owner: ${String(value)}`);
  }
  return normalized as ActiveConcernOwner;
}

export function normalizeSalience(value: unknown): number {
  const parsed = toNumber(value ?? 0.5);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Unsupported active concern salience: ${String(value)}`);
  }
  return parsed;
}

export function normalizePendingPriority(value: string): 'low' | 'medium' | 'high' {
  if (!PENDING_FOLLOW_UP_PRIORITIES.includes(value as (typeof PENDING_FOLLOW_UP_PRIORITIES)[number])) {
    throw new Error(`Unsupported pending follow-up priority: ${value}`);
  }
  return value as 'low' | 'medium' | 'high';
}

export function normalizeTiming(value: string): 'immediate' | 'soon' | 'scheduled' {
  if (!PENDING_FOLLOW_UP_TIMINGS.includes(value as (typeof PENDING_FOLLOW_UP_TIMINGS)[number])) {
    throw new Error(`Unsupported pending follow-up timing: ${value}`);
  }
  return value as 'immediate' | 'soon' | 'scheduled';
}

export function normalizeWakeCondition(value: string): SharedPendingFollowUpWakeCondition {
  if (!PENDING_FOLLOW_UP_WAKE_CONDITIONS.includes(value as SharedPendingFollowUpWakeCondition)) {
    throw new Error(`Unsupported pending follow-up wake condition: ${value}`);
  }
  return value as SharedPendingFollowUpWakeCondition;
}

export function normalizeWakeConditions(
  value: readonly SharedPendingFollowUpWakeCondition[] | undefined,
): SharedPendingFollowUpWakeCondition[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = [...new Set(
    value
      .filter((condition): condition is SharedPendingFollowUpWakeCondition => typeof condition === 'string')
      .map(condition => normalizeWakeCondition(condition)),
  )];
  if (normalized.length === 0) {
    return undefined;
  }
  return PENDING_FOLLOW_UP_WAKE_CONDITIONS.filter(condition => normalized.includes(condition));
}

export function encodeWakeConditions(
  value: readonly SharedPendingFollowUpWakeCondition[] | undefined,
): string | null {
  const normalized = normalizeWakeConditions(value);
  return normalized ? JSON.stringify(normalized) : null;
}

export function decodeWakeConditions(
  value: string | null,
  fieldName: string,
): SharedPendingFollowUpWakeCondition[] | undefined {
  if (value === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Field "${fieldName}" must be valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Field "${fieldName}" must be a JSON array`);
  }
  return normalizeWakeConditions(parsed as SharedPendingFollowUpWakeCondition[]);
}

export function normalizeChannelType(value: string): ChannelType {
  if (!CHANNEL_TYPES.includes(value as ChannelType)) {
    throw new Error(`Unsupported pending follow-up channel type: ${value}`);
  }
  return value as ChannelType;
}

export function normalizeStrategy(value: string): (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number] {
  const normalized = compactWhitespace(value).toLowerCase();
  if (!BEHAVIORAL_RESPONSE_STRATEGIES.includes(normalized as (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number])) {
    throw new Error(`Unsupported behavioral response strategy: ${value}`);
  }
  return normalized as (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number];
}

export function normalizeOutcomeScore(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Behavioral pattern outcome must be finite, received ${String(value)}`);
  }
  return Math.max(-1, Math.min(1, value));
}

export function clampSummaryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_BEHAVIORAL_SUMMARY_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_BEHAVIORAL_SUMMARY_LIMIT);
}

export function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return Number.NaN;
}

function normalizePersistedConcernVADAxis(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Field "${fieldName}" must be a finite number`);
  }
  if (value < -1 || value > 1) {
    throw new Error(`Field "${fieldName}" must be between -1 and 1`);
  }
  return value;
}

function normalizeConcernVAD(
  value: { valence: number; arousal: number; dominance: number } | undefined,
  fieldName: string,
): { valence: number; arousal: number; dominance: number } | undefined {
  if (!value) return undefined;
  return {
    valence: normalizePersistedConcernVADAxis(value.valence, `${fieldName}.valence`),
    arousal: normalizePersistedConcernVADAxis(value.arousal, `${fieldName}.arousal`),
    dominance: normalizePersistedConcernVADAxis(value.dominance, `${fieldName}.dominance`),
  };
}

function serializeConcernVAD(
  value: { valence: number; arousal: number; dominance: number } | undefined,
  fieldName: string,
): string | null {
  const normalized = normalizeConcernVAD(value, fieldName);
  return normalized ? JSON.stringify(normalized) : null;
}

function parseConcernVAD(
  value: unknown,
  fieldName: string,
): { valence: number; arousal: number; dominance: number } | undefined {
  // Real Postgres returns JSONB as a parsed object; test/fake pools may hand
  // back the raw JSON string. Tolerate both (matches parseJsonValue behavior).
  const resolved = typeof value === 'string' ? parseOptionalJsonValue(value, fieldName) : value;
  if (resolved === null || resolved === undefined) return undefined;
  if (typeof resolved !== 'object' || Array.isArray(resolved)) {
    throw new Error(`Field "${fieldName}" must be a VAD object`);
  }
  return normalizeConcernVAD(
    resolved as { valence: number; arousal: number; dominance: number },
    fieldName,
  );
}

export function serializeFormationVAD(value: { valence: number; arousal: number; dominance: number } | undefined): string | null {
  return serializeConcernVAD(value, 'formation_vad');
}

/**
 * Serialize a pending-follow-up formation/completion VAD to a JSONB string (bead
 * vw3w.3). Reuses the concern VAD normalization so both surfaces validate axes
 * identically; the field name only labels error messages.
 */
export function serializeFollowUpVAD(
  value: { valence: number; arousal: number; dominance: number } | undefined,
  fieldName: string,
): string | null {
  return serializeConcernVAD(value, fieldName);
}

/** Parse a persisted pending-follow-up VAD column (bead vw3w.3). */
export function parseFollowUpVAD(
  value: unknown,
  fieldName: string,
): { valence: number; arousal: number; dominance: number } | undefined {
  return parseConcernVAD(value, fieldName);
}

export function parseFormationVAD(value: unknown): { valence: number; arousal: number; dominance: number } | undefined {
  return parseConcernVAD(value, 'formation_vad');
}

export function serializeResolutionVAD(value: { valence: number; arousal: number; dominance: number } | undefined): string | null {
  return serializeConcernVAD(value, 'resolution_vad');
}

export function parseResolutionVAD(value: unknown): { valence: number; arousal: number; dominance: number } | undefined {
  return parseConcernVAD(value, 'resolution_vad');
}

function parseJsonValue(value: unknown, fieldName: string): unknown {
  if (typeof value !== 'string') {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Field "${fieldName}" must be valid JSON: ${String(error)}`);
  }
}

export function parseOptionalJsonValue(value: unknown, fieldName: string): unknown {
  if (value === null || value === undefined) return undefined;
  return parseJsonValue(value, fieldName);
}

export function parseConcernEvidenceRefs(
  value: unknown,
  fieldName: string,
): ActiveConcernEvidenceRef[] {
  if (value === null || value === undefined) {
    return [];
  }
  return normalizeConcernEvidenceRefs(
    parseJsonValue(value, fieldName) as ActiveConcernEvidenceRef[],
    fieldName,
  );
}

export function serializeConcernEvidenceRefs(value: readonly ActiveConcernEvidenceRef[] | undefined): string {
  return JSON.stringify(normalizeConcernEvidenceRefs(value));
}

export function parseStringList(value: unknown, fieldName: string): string[] {
  if (value === null || value === undefined) {
    return [];
  }
  const parsed = parseJsonValue(value, fieldName);
  if (!Array.isArray(parsed)) {
    throw new Error(`Field "${fieldName}" must be a JSON array`);
  }
  const normalized = parsed.map((item, index) => {
    if (typeof item !== 'string') {
      throw new Error(`Field "${fieldName}[${index}]" must be a string`);
    }
    return normalizeRequiredText(item, `${fieldName}[${index}]`, 128);
  });
  return [...new Set(normalized)];
}

export function serializeStringList(value: readonly string[] | undefined): string {
  if (value === undefined) {
    return JSON.stringify([]);
  }
  const normalized = value.map((item, index) => (
    normalizeRequiredText(item, `ids[${index}]`, 128)
  ));
  return JSON.stringify([...new Set(normalized)]);
}

export function normalizeContactId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function concernSimilarityText(value: string): string {
  return compactWhitespace(value.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

export function tokenizeConcernSimilarityText(value: string): string[] {
  const normalized = concernSimilarityText(value);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter(token => token.length >= 3)));
}

export function scoreConcernSimilarity(left: string, right: string): number {
  const normalizedLeft = concernSimilarityText(left);
  const normalizedRight = concernSimilarityText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const leftTokens = tokenizeConcernSimilarityText(normalizedLeft);
  const rightTokens = tokenizeConcernSimilarityText(normalizedRight);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) intersection += 1;
  }
  if (intersection === 0) return 0;
  return (2 * intersection) / (leftTokens.length + rightTokens.length);
}

export function mapActiveConcernRow(row: ActiveConcernPgRow): ActiveConcern {
  const resolvedAt = row.resolved_at === null ? undefined : normalizeIsoTimestamp(row.resolved_at, 'resolved_at');
  const resolutionOutcome = row.resolution_outcome === null
    ? undefined
    : normalizeOptionalText(row.resolution_outcome, 'resolution_outcome', MAX_CONCERN_RESOLUTION_CHARS);
  const contactId = row.contact_id === null ? undefined : normalizeContactId(row.contact_id);
  const formationVAD = parseFormationVAD(row.formation_vad);
  const resolutionVAD = parseResolutionVAD(row.resolution_vad);
  const resolutionGenerationId = row.resolution_generation_id === null
    ? undefined
    : normalizeRequiredText(row.resolution_generation_id, 'resolution_generation_id', 128);
  const lastReviewedAt = row.last_reviewed_at === null
    ? undefined
    : normalizeIsoTimestamp(row.last_reviewed_at, 'last_reviewed_at');
  const nextReviewAt = row.next_review_at === null
    ? undefined
    : normalizeIsoTimestamp(row.next_review_at, 'next_review_at');
  const mergedFromIds = parseStringList(row.merged_from_ids, 'merged_from_ids');
  const splitFromId = row.split_from_id === null ? undefined : normalizeContactId(row.split_from_id);
  const originIcpRootInitiationId = normalizeOptionalConcernIcpRootInitiationId(
    row.origin_icp_root_initiation_id,
  );
  const candidateReviewSnapshot = parseOptionalJsonValue(
    row.candidate_review_snapshot,
    'candidate_review_snapshot',
  );
  return {
    id: row.id,
    text: row.text,
    priority: normalizePriority(row.priority),
    source: normalizeSource(row.source),
    status: normalizeStatus(row.status),
    createdAt: normalizeIsoTimestamp(row.created_at, 'created_at'),
    expiresAt: normalizeIsoTimestamp(row.expires_at, 'expires_at'),
    salience: normalizeSalience(row.salience),
    sensitivity: normalizeSensitivity(row.sensitivity),
    owner: normalizeOwner(row.owner),
    evidenceRefs: parseConcernEvidenceRefs(row.evidence_refs, 'evidence_refs'),
    resolutionEvidenceRefs: parseConcernEvidenceRefs(
      row.resolution_evidence_refs,
      'resolution_evidence_refs',
    ),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolutionOutcome ? { resolutionOutcome } : {}),
    ...(contactId ? { contactId } : {}),
    ...(formationVAD ? { formationVAD } : {}),
    ...(resolutionVAD ? { resolutionVAD } : {}),
    ...(resolutionGenerationId ? { resolutionGenerationId } : {}),
    ...(lastReviewedAt ? { lastReviewedAt } : {}),
    ...(nextReviewAt ? { nextReviewAt } : {}),
    ...(mergedFromIds.length > 0 ? { mergedFromIds } : {}),
    ...(splitFromId ? { splitFromId } : {}),
    ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
    ...(candidateReviewSnapshot !== undefined ? { candidateReviewSnapshot } : {}),
  };
}

export function mapPendingFollowUpRow(row: PendingFollowUpRow) {
  const dueAt = row.due_at === null ? undefined : normalizeIsoTimestamp(row.due_at, 'due_at');
  const contactId = row.contact_id === null ? undefined : normalizeContactId(row.contact_id);
  const sourceMessageId = row.source_message_id === null ? undefined : normalizeContactId(row.source_message_id);
  const contextSummary = row.context_summary === null
    ? undefined
    : normalizeOptionalText(row.context_summary, 'context_summary', MAX_PENDING_SUMMARY_CHARS);
  const wakeConditions = decodeWakeConditions(row.wake_conditions, 'wake_conditions');
  const activatedAt = row.activated_at === null ? undefined : normalizeIsoTimestamp(row.activated_at, 'activated_at');
  const activationReason = row.activation_reason === null
    ? undefined
    : normalizeOptionalText(row.activation_reason, 'activation_reason', MAX_PENDING_REASON_CHARS);
  const dampenedAt = row.dampened_at === null
    ? undefined
    : normalizeIsoTimestamp(row.dampened_at, 'dampened_at');
  const dampeningReason = row.dampening_reason === null
    ? undefined
    : normalizeOptionalText(row.dampening_reason, 'dampening_reason', MAX_PENDING_REASON_CHARS);
  if ((dampenedAt === undefined) !== (dampeningReason === undefined)) {
    throw new Error('Pending follow-up dampening timestamp and reason must be written together');
  }
  if (activatedAt && dampenedAt) {
    throw new Error('Pending follow-up cannot be both activated and dampened');
  }
  const originIcpRootInitiationId = normalizeOptionalIcpRootInitiationId(
    row.origin_icp_root_initiation_id,
  );
  const formationVAD = parseFollowUpVAD(row.formation_vad, 'formation_vad');
  const completionVAD = parseFollowUpVAD(row.completion_vad, 'completion_vad');
  return {
    id: normalizeRequiredText(row.id, 'id', MAX_PENDING_ID_CHARS),
    content: normalizeRequiredText(row.content, 'content', MAX_PENDING_TEXT_CHARS),
    priority: normalizePendingPriority(row.priority),
    timing: normalizeTiming(row.timing),
    createdAt: normalizeIsoTimestamp(row.created_at, 'created_at'),
    channelId: normalizeRequiredText(row.channel_id, 'channel_id', MAX_PENDING_ID_CHARS),
    channelType: normalizeChannelType(row.channel_type),
    authorId: normalizeRequiredText(row.author_id, 'author_id', MAX_PENDING_ID_CHARS),
    authorName: normalizeRequiredText(row.author_name, 'author_name', MAX_PENDING_ID_CHARS),
    ...(dueAt ? { dueAt } : {}),
    ...(contactId ? { contactId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    ...(wakeConditions ? { wakeConditions } : {}),
    ...(activatedAt ? { activatedAt } : {}),
    ...(activationReason ? { activationReason } : {}),
    ...(dampenedAt ? { dampenedAt } : {}),
    ...(dampeningReason ? { dampeningReason } : {}),
    ...(originIcpRootInitiationId ? { originIcpRootInitiationId } : {}),
    ...(formationVAD ? { formationVAD } : {}),
    ...(completionVAD ? { completionVAD } : {}),
  };
}

export function mapBehavioralPatternRow(row: BehavioralPatternRow) {
  const outcomeScore = row.outcome_score === null ? undefined : normalizeOutcomeScore(row.outcome_score);
  const outcomeObservedAt = row.outcome_observed_at === null
    ? undefined
    : normalizeIsoTimestamp(row.outcome_observed_at, 'outcome_observed_at');
  const outcomeSourceMessageId = row.outcome_source_message_id === null
    ? undefined
    : normalizeOptionalText(row.outcome_source_message_id, 'outcome_source_message_id', MAX_MESSAGE_ID_CHARS);
  const promotedAt = row.promoted_at === null ? undefined : normalizeIsoTimestamp(row.promoted_at, 'promoted_at');
  const promotedMemoryId = row.promoted_memory_id === null
    ? undefined
    : normalizeOptionalText(row.promoted_memory_id, 'promoted_memory_id', MAX_PROMOTION_MEMORY_ID_CHARS);
  return {
    id: row.id,
    contactId: normalizeRequiredText(row.contact_id, 'contact_id', MAX_CONTACT_ID_CHARS),
    sourceMessageId: normalizeRequiredText(row.source_message_id, 'source_message_id', MAX_MESSAGE_ID_CHARS),
    strategy: normalizeStrategy(row.strategy),
    responseExcerpt: normalizeRequiredText(row.response_excerpt, 'response_excerpt', MAX_RESPONSE_EXCERPT_CHARS),
    createdAt: normalizeIsoTimestamp(row.created_at, 'created_at'),
    ...(outcomeScore !== undefined ? { outcomeScore } : {}),
    ...(outcomeObservedAt ? { outcomeObservedAt } : {}),
    ...(outcomeSourceMessageId ? { outcomeSourceMessageId } : {}),
    ...(promotedAt ? { promotedAt } : {}),
    ...(promotedMemoryId ? { promotedMemoryId } : {}),
  };
}

export function mapBehavioralStrategySummaryRow(row: BehavioralPatternSummaryRow) {
  const lastOutcomeAt = row.last_outcome_at === null ? undefined : normalizeIsoTimestamp(row.last_outcome_at, 'last_outcome_at');
  return {
    strategy: normalizeStrategy(row.strategy),
    sampleCount: Math.max(0, Math.floor(toNumber(row.sample_count))),
    resolvedCount: Math.max(0, Math.floor(toNumber(row.resolved_count))),
    pendingCount: Math.max(0, Math.floor(toNumber(row.pending_count))),
    averageOutcome: row.average_outcome === null ? 0 : normalizeOutcomeScore(row.average_outcome),
    positiveCount: Math.max(0, Math.floor(toNumber(row.positive_count))),
    negativeCount: Math.max(0, Math.floor(toNumber(row.negative_count))),
    ...(lastOutcomeAt ? { lastOutcomeAt } : {}),
  };
}

export function formatSignedOutcome(value: number): string {
  const normalized = normalizeOutcomeScore(value);
  const fixed = normalized.toFixed(2);
  return normalized >= 0 ? `+${fixed}` : fixed;
}

export function toProceduralMemoryText(candidate: {
  strategy: string;
  averageOutcome: number;
  sampleCount: number;
  positiveRate: number;
}): string {
  return (
    `For this contact, ${candidate.strategy} responses trend beneficial `
    + `(avg emotional outcome ${formatSignedOutcome(candidate.averageOutcome)} `
    + `across ${candidate.sampleCount} observations; positive rate ${Math.round(candidate.positiveRate * 100)}%).`
  );
}

export function inferBehavioralResponseStrategy(responseContent: string): (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number] {
  const normalized = responseContent.trim();
  if (!normalized) {
    throw new Error('Behavioral pattern responseContent is required to infer strategy');
  }
  const lower = normalized.toLowerCase();

  if (/\b(i hear you|that sounds|i'm sorry|that must be|you are not alone|i can see)\b/.test(lower)) {
    return 'empathy';
  }
  if (/\b(haha|lol|joke|playful|lighten)\b/.test(lower)) {
    return 'humor';
  }
  if (
    normalized.includes('```')
    || /^\s*1\.\s/m.test(normalized)
    || /\b(step|steps|algorithm|implementation|debug)\b/.test(lower)
    || /\b(api|schema|typescript|function|compile|stack trace)\b/.test(lower)
  ) {
    return 'technical';
  }
  if (/\b(let's focus|let's return|come back to|for now|we can revisit)\b/.test(lower)) {
    return 'redirect';
  }
  if (/\b(that makes sense|valid|understandable|it's okay to)\b/.test(lower)) {
    return 'validation';
  }
  if (/\?\s*$/.test(normalized) || /\b(could you|would you|can you|what if)\b/.test(lower)) {
    return 'questioning';
  }
  if (/\b(do this|must|need to|stop|start)\b/.test(lower)) {
    return 'direct';
  }
  return 'supportive';
}

export function normalizeRecentResolutionWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RECENT_RESOLUTION_WINDOW_MS;
  const floored = Math.floor(value);
  if (floored < 1) {
    throw new Error('Active concern recent resolution window must be a positive number');
  }
  return floored;
}

export function normalizeMinimumSamplesForPromotion(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('Behavioral pattern minimumSamplesForPromotion must be a finite integer >= 1');
  }
  return Math.floor(value);
}

export function normalizeMinimumAverageOutcomeForPromotion(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION;
  return normalizeOutcomeScore(value);
}

export function formatSigned(value: number): string {
  const normalized = normalizeOutcomeScore(value);
  const fixed = normalized.toFixed(2);
  return normalized >= 0 ? `+${fixed}` : fixed;
}

export function toBehavioralNote(
  summary: ReturnType<typeof mapBehavioralStrategySummaryRow>,
): string {
  const positiveRate = summary.resolvedCount > 0
    ? Math.round((summary.positiveCount / summary.resolvedCount) * 100)
    : 0;
  return (
    `- ${summary.strategy}: avg ${formatSigned(summary.averageOutcome)} `
    + `over ${summary.resolvedCount} outcome sample(s), `
    + `${positiveRate}% positive`
    + (summary.pendingCount > 0 ? `, ${summary.pendingCount} pending` : '')
  );
}
