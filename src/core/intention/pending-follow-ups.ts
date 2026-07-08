import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { channelsShareActiveSessionThread } from '../session/cross-channel-continuity-port.js';
import type { PendingFollowUpQuarantineRecord } from './pending-follow-up-store-port.js';

export {
  createPendingFollowUpStorePort,
} from './pending-follow-up-store-port.js';
export type {
  PendingFollowUpQuarantineInput,
  PendingFollowUpQuarantineListOptions,
  PendingFollowUpQuarantineRecord,
  PendingFollowUpStorePort,
} from './pending-follow-up-store-port.js';

export const PENDING_FOLLOW_UP_PRIORITIES = ['low', 'medium', 'high'] as const;
export type PendingFollowUpPriority = typeof PENDING_FOLLOW_UP_PRIORITIES[number];

export const PENDING_FOLLOW_UP_TIMINGS = ['immediate', 'soon', 'scheduled'] as const;
export type PendingFollowUpTiming = typeof PENDING_FOLLOW_UP_TIMINGS[number];

export const PENDING_FOLLOW_UP_WAKE_CONDITIONS = [
  'next_user_turn',
  'background_recheck',
  'sustained_negative_mood',
] as const;
export type PendingFollowUpWakeCondition = typeof PENDING_FOLLOW_UP_WAKE_CONDITIONS[number];

export const DEFAULT_PENDING_FOLLOW_UP_BACKLOG_CAP = 5;
export const DEFAULT_PENDING_FOLLOW_UP_ACTIVATION_DELAY_MS = 5 * 60_000;
export const PENDING_FOLLOW_UP_DEDUPE_SIMILARITY_THRESHOLD = 0.72;
export const PENDING_FOLLOW_UP_CAP_SUPERSEDE_SIMILARITY_THRESHOLD = 0.45;

export interface PendingFollowUp {
  id: string;
  content: string;
  priority: PendingFollowUpPriority;
  timing: PendingFollowUpTiming;
  createdAt: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  dueAt?: string;
  contactId?: string;
  sourceMessageId?: string;
  contextSummary?: string;
  wakeConditions?: PendingFollowUpWakeCondition[];
  activatedAt?: string;
  activationReason?: string;
}

export interface PendingFollowUpCreateInput {
  content: string;
  priority: PendingFollowUpPriority;
  timing: PendingFollowUpTiming;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  createdAt?: string;
  dueAt?: string;
  contactId?: string;
  sourceMessageId?: string;
  contextSummary?: string;
  wakeConditions?: readonly PendingFollowUpWakeCondition[];
}

export interface PendingFollowUpUpdateInput {
  content: string;
  priority: PendingFollowUpPriority;
  timing: PendingFollowUpTiming;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  dueAt?: string;
  contactId?: string;
  sourceMessageId?: string;
  contextSummary?: string;
  wakeConditions?: readonly PendingFollowUpWakeCondition[];
}

export interface PendingFollowUpActivateOptions {
  activatedAt?: string;
  activationReason?: string;
}

export interface PendingFollowUpListOptions {
  contactId?: string;
  includeActivated?: boolean;
  includeExpired?: boolean;
  asOf?: string;
  limit?: number;
}

export interface PendingFollowUpStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
  backlogCap?: number;
}

export interface PendingFollowUpContextProvider {
  getPendingFollowUps(contactId?: string): PendingFollowUp[];
}

export function filterPendingFollowUpsForActiveChannel(
  followUps: readonly PendingFollowUp[],
  activeChannelId?: string,
): PendingFollowUp[] {
  const normalizedActiveChannelId = normalizeOptionalId(activeChannelId);
  if (!normalizedActiveChannelId) {
    return [...followUps];
  }

  return followUps.filter(followUp => channelsShareActiveSessionThread(
    followUp.channelId,
    normalizedActiveChannelId,
  ));
}

export interface PendingFollowUpWakeContext {
  now: number;
  isBackgroundTurn: boolean;
  motivationSignals?: readonly string[];
  currentMoodValence?: number | null;
}

export interface PendingFollowUpWakeEvaluation {
  eligibleNow: boolean;
  dueAtReached: boolean;
  matchedWakeConditions: PendingFollowUpWakeCondition[];
}

export interface PendingFollowUpActivationEvaluation extends PendingFollowUpWakeEvaluation {
  timingDue: boolean;
}

export type PendingFollowUpEnqueueResolution =
  | { kind: 'insert'; backlogSize: number }
  | {
    kind: 'supersede';
    existing: PendingFollowUp;
    similarity: number;
    backlogSize: number;
    reason: 'dedupe' | 'backlog_cap';
  }
  | {
    kind: 'drop';
    closest?: PendingFollowUp;
    similarity: number;
    backlogSize: number;
    reason: 'backlog_cap';
  };

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
}

export interface PendingFollowUpQuarantineRow {
  id: string;
  follow_up_id: string | null;
  reason: string;
  source: string | null;
  raw_entry: string;
  quarantined_at: string;
}

export const MAX_TEXT_CHARS = 500;
export const MAX_ID_CHARS = 128;
export const MAX_SUMMARY_CHARS = 320;
export const MAX_REASON_CHARS = 240;
const MAX_QUARANTINE_REASON_CHARS = 1000;
export const MAX_QUARANTINE_SOURCE_CHARS = 128;
const DEFAULT_LIST_LIMIT = 32;
export const MAX_LIST_LIMIT = 200;
const NEGATIVE_MOOD_WAKE_THRESHOLD = -0.2;
export const PENDING_FOLLOW_UPS_TABLE = 'intention_pending_follow_ups';
export const PENDING_FOLLOW_UP_QUARANTINE_TABLE = 'intention_pending_follow_up_quarantine';
const PENDING_FOLLOW_UP_STALE_MS_BY_PRIORITY: Record<PendingFollowUpPriority, number> = {
  low: 8 * 60 * 60 * 1000,
  medium: 24 * 60 * 60 * 1000,
  high: 48 * 60 * 60 * 1000,
};
export const log = createComponentLogger('PendingFollowUps');

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Pending follow-up ${fieldName} is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Pending follow-up ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

export function normalizeOptionalText(
  value: string | undefined,
  fieldName: string,
  maxChars: number,
): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  if (!normalized) return undefined;
  if (normalized.length > maxChars) {
    throw new Error(`Pending follow-up ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

export function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, 128);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Pending follow-up ${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

export function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeOptionalIdOrNull(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return normalizeOptionalId(value);
}

export function normalizePriority(value: string): PendingFollowUpPriority {
  if (!PENDING_FOLLOW_UP_PRIORITIES.includes(value as PendingFollowUpPriority)) {
    throw new Error(`Unsupported pending follow-up priority: ${String(value)}`);
  }
  return value as PendingFollowUpPriority;
}

export function normalizeTiming(value: string): PendingFollowUpTiming {
  if (!PENDING_FOLLOW_UP_TIMINGS.includes(value as PendingFollowUpTiming)) {
    throw new Error(`Unsupported pending follow-up timing: ${String(value)}`);
  }
  return value as PendingFollowUpTiming;
}

export function normalizeChannelType(value: string): ChannelType {
  if (!CHANNEL_TYPES.includes(value as ChannelType)) {
    throw new Error(`Unsupported pending follow-up channel type: ${String(value)}`);
  }
  return value as ChannelType;
}

function normalizeWakeCondition(value: string): PendingFollowUpWakeCondition {
  if (!PENDING_FOLLOW_UP_WAKE_CONDITIONS.includes(value as PendingFollowUpWakeCondition)) {
    throw new Error(`Unsupported pending follow-up wake condition: ${String(value)}`);
  }
  return value as PendingFollowUpWakeCondition;
}

export function normalizeWakeConditions(
  value: readonly PendingFollowUpWakeCondition[] | undefined,
): PendingFollowUpWakeCondition[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = [...new Set(
    value
      .filter((condition): condition is PendingFollowUpWakeCondition => typeof condition === 'string')
      .map(condition => normalizeWakeCondition(condition)),
  )];
  if (normalized.length === 0) {
    return undefined;
  }
  return PENDING_FOLLOW_UP_WAKE_CONDITIONS.filter(condition => normalized.includes(condition));
}

function decodeWakeConditions(
  value: string | null,
  fieldName: string,
): PendingFollowUpWakeCondition[] | undefined {
  if (value === null) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Pending follow-up ${fieldName} must be valid JSON: ${String(error)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Pending follow-up ${fieldName} must be a JSON array`);
  }
  return normalizeWakeConditions(parsed as PendingFollowUpWakeCondition[]);
}

export function encodeWakeConditions(
  value: readonly PendingFollowUpWakeCondition[] | undefined,
): string | null {
  const normalized = normalizeWakeConditions(value);
  return normalized ? JSON.stringify(normalized) : null;
}

export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

export function normalizeBacklogCap(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_PENDING_FOLLOW_UP_BACKLOG_CAP;
  }
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return floored;
}

export function resolvePendingFollowUpDueAtForWrite(input: Pick<
  PendingFollowUpCreateInput,
  'timing' | 'createdAt' | 'dueAt'
>, now: Date): string {
  const timing = normalizeTiming(input.timing);
  if (input.dueAt) {
    return normalizeIsoTimestamp(input.dueAt, 'dueAt');
  }
  const createdAt = input.createdAt
    ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
    : now.toISOString();
  const createdAtMs = Date.parse(createdAt);
  const dueAtMs = timing === 'immediate'
    ? createdAtMs
    : createdAtMs + DEFAULT_PENDING_FOLLOW_UP_ACTIVATION_DELAY_MS;
  return new Date(dueAtMs).toISOString();
}

function normalizeSimilarityText(value: string): string {
  return compactWhitespace(value.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

function tokenizeSimilarityText(value: string): string[] {
  const normalized = normalizeSimilarityText(value);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter(token => token.length >= 3)));
}

export function scorePendingFollowUpContentSimilarity(left: string, right: string): number {
  const normalizedLeft = normalizeSimilarityText(left);
  const normalizedRight = normalizeSimilarityText(right);
  if (!normalizedLeft || !normalizedRight) return 0;
  if (normalizedLeft === normalizedRight) return 1;

  const leftTokens = tokenizeSimilarityText(normalizedLeft);
  const rightTokens = tokenizeSimilarityText(normalizedRight);
  if (leftTokens.length === 0 || rightTokens.length === 0) return 0;

  const rightSet = new Set(rightTokens);
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightSet.has(token)) {
      intersection += 1;
    }
  }
  if (intersection === 0) return 0;

  const dice = (2 * intersection) / (leftTokens.length + rightTokens.length);
  const containment = intersection / Math.min(leftTokens.length, rightTokens.length);
  return Math.max(dice, containment);
}

function normalizeEnqueueInputScope(input: Pick<
  PendingFollowUpCreateInput,
  'content' | 'timing' | 'channelId' | 'contactId'
>): {
  content: string;
  timing: PendingFollowUpTiming;
  channelId: string;
  contactId?: string;
} {
  const content = normalizeRequiredText(input.content, 'content', MAX_TEXT_CHARS);
  const timing = normalizeTiming(input.timing);
  const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_ID_CHARS);
  const contactId = normalizeOptionalId(input.contactId);
  return {
    content,
    timing,
    channelId,
    ...(contactId ? { contactId } : {}),
  };
}

export function resolvePendingFollowUpEnqueueResolution(
  input: Pick<PendingFollowUpCreateInput, 'content' | 'timing' | 'channelId' | 'contactId'>,
  existingFollowUps: readonly PendingFollowUp[],
  options: {
    backlogCap?: number;
    dedupeThreshold?: number;
    capSupersedeThreshold?: number;
  } = {},
): PendingFollowUpEnqueueResolution {
  const normalized = normalizeEnqueueInputScope(input);
  const backlogCap = normalizeBacklogCap(options.backlogCap);
  const dedupeThreshold = options.dedupeThreshold ?? PENDING_FOLLOW_UP_DEDUPE_SIMILARITY_THRESHOLD;
  const capSupersedeThreshold = options.capSupersedeThreshold
    ?? PENDING_FOLLOW_UP_CAP_SUPERSEDE_SIMILARITY_THRESHOLD;
  const scopedCandidates = existingFollowUps.filter(followUp => (
    !followUp.activatedAt
    && followUp.channelId === normalized.channelId
    && normalizeOptionalIdOrNull(followUp.contactId) === normalized.contactId
  ));
  const backlogSize = scopedCandidates.length;
  const scoredByTiming = scopedCandidates
    .filter(followUp => followUp.timing === normalized.timing)
    .map(followUp => ({
      followUp,
      similarity: scorePendingFollowUpContentSimilarity(normalized.content, followUp.content),
    }))
    .sort((left, right) => (
      right.similarity - left.similarity
      || Date.parse(left.followUp.createdAt) - Date.parse(right.followUp.createdAt)
      || left.followUp.id.localeCompare(right.followUp.id)
    ));
  const closestByTiming = scoredByTiming.at(0);

  if (closestByTiming && closestByTiming.similarity >= dedupeThreshold) {
    return {
      kind: 'supersede',
      existing: closestByTiming.followUp,
      similarity: closestByTiming.similarity,
      backlogSize,
      reason: 'dedupe',
    };
  }

  if (backlogSize >= backlogCap) {
    const closest = scopedCandidates
      .map(followUp => ({
        followUp,
        similarity: scorePendingFollowUpContentSimilarity(normalized.content, followUp.content),
      }))
      .sort((left, right) => (
        right.similarity - left.similarity
        || Date.parse(left.followUp.createdAt) - Date.parse(right.followUp.createdAt)
        || left.followUp.id.localeCompare(right.followUp.id)
      ))
      .at(0);
    if (closest && closest.similarity >= capSupersedeThreshold) {
      return {
        kind: 'supersede',
        existing: closest.followUp,
        similarity: closest.similarity,
        backlogSize,
        reason: 'backlog_cap',
      };
    }
    return {
      kind: 'drop',
      ...(closest ? { closest: closest.followUp } : {}),
      similarity: closest?.similarity ?? 0,
      backlogSize,
      reason: 'backlog_cap',
    };
  }

  return {
    kind: 'insert',
    backlogSize,
  };
}

export function normalizeQuarantineReason(value: string): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    return 'Invalid pending follow-up entry';
  }
  return normalized.length > MAX_QUARANTINE_REASON_CHARS
    ? normalized.slice(0, MAX_QUARANTINE_REASON_CHARS)
    : normalized;
}

export function serializeQuarantineRawEntry(value: unknown): string {
  try {
    const serialized = JSON.stringify(value ?? null);
    return typeof serialized === 'string' ? serialized : 'null';
  } catch (error) {
    return JSON.stringify({
      serializationError: String(error),
      value: String(value),
    });
  }
}

function deserializeQuarantineRawEntry(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function toQuarantineReason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function mapRow(row: PendingFollowUpRow): PendingFollowUp {
  const dueAt = row.due_at === null ? undefined : normalizeIsoTimestamp(row.due_at, 'due_at');
  const contactId = row.contact_id === null ? undefined : normalizeOptionalId(row.contact_id);
  const sourceMessageId = row.source_message_id === null
    ? undefined
    : normalizeOptionalId(row.source_message_id);
  const contextSummary = row.context_summary === null
    ? undefined
    : normalizeOptionalText(row.context_summary, 'context_summary', MAX_SUMMARY_CHARS);
  const wakeConditions = decodeWakeConditions(row.wake_conditions, 'wake_conditions');
  const activatedAt = row.activated_at === null
    ? undefined
    : normalizeIsoTimestamp(row.activated_at, 'activated_at');
  const activationReason = row.activation_reason === null
    ? undefined
    : normalizeOptionalText(row.activation_reason, 'activation_reason', MAX_REASON_CHARS);

  return {
    id: normalizeRequiredText(row.id, 'id', MAX_ID_CHARS),
    content: normalizeRequiredText(row.content, 'content', MAX_TEXT_CHARS),
    priority: normalizePriority(row.priority),
    timing: normalizeTiming(row.timing),
    createdAt: normalizeIsoTimestamp(row.created_at, 'created_at'),
    channelId: normalizeRequiredText(row.channel_id, 'channel_id', MAX_ID_CHARS),
    channelType: normalizeChannelType(row.channel_type),
    authorId: normalizeRequiredText(row.author_id, 'author_id', MAX_ID_CHARS),
    authorName: normalizeRequiredText(row.author_name, 'author_name', MAX_ID_CHARS),
    ...(dueAt ? { dueAt } : {}),
    ...(contactId ? { contactId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(contextSummary ? { contextSummary } : {}),
    ...(wakeConditions ? { wakeConditions } : {}),
    ...(activatedAt ? { activatedAt } : {}),
    ...(activationReason ? { activationReason } : {}),
  };
}

export function mapQuarantineRow(row: PendingFollowUpQuarantineRow): PendingFollowUpQuarantineRecord {
  const followUpId = row.follow_up_id === null ? undefined : normalizeOptionalId(row.follow_up_id);
  const source = row.source === null
    ? undefined
    : normalizeOptionalText(row.source, 'quarantine_source', MAX_QUARANTINE_SOURCE_CHARS);
  return {
    id: normalizeRequiredText(row.id, 'quarantine_id', MAX_ID_CHARS),
    reason: normalizeRequiredText(row.reason, 'quarantine_reason', MAX_QUARANTINE_REASON_CHARS),
    raw: deserializeQuarantineRawEntry(row.raw_entry),
    quarantinedAt: normalizeIsoTimestamp(row.quarantined_at, 'quarantined_at'),
    ...(followUpId ? { followUpId } : {}),
    ...(source ? { source } : {}),
  };
}

export function hasStateWakeConditions(followUp: Pick<PendingFollowUp, 'wakeConditions'>): boolean {
  return Array.isArray(followUp.wakeConditions) && followUp.wakeConditions.length > 0;
}

export function resolvePendingFollowUpExpiryMs(
  followUp: Pick<PendingFollowUp, 'priority' | 'createdAt' | 'dueAt'>,
): number | null {
  const createdAtMs = Date.parse(followUp.createdAt);
  if (!Number.isFinite(createdAtMs)) {
    return null;
  }
  const staleAfterMs = PENDING_FOLLOW_UP_STALE_MS_BY_PRIORITY[followUp.priority];
  const ageExpiryMs = createdAtMs + staleAfterMs;
  const dueAtMs = typeof followUp.dueAt === 'string' ? Date.parse(followUp.dueAt) : Number.NaN;
  if (!Number.isFinite(dueAtMs) || dueAtMs <= 0) {
    return ageExpiryMs;
  }
  return Math.max(ageExpiryMs, dueAtMs + staleAfterMs);
}

export function isPendingFollowUpExpired(
  followUp: Pick<PendingFollowUp, 'priority' | 'createdAt' | 'dueAt'>,
  asOfMs: number,
): boolean {
  const expiryMs = resolvePendingFollowUpExpiryMs(followUp);
  if (expiryMs === null || !Number.isFinite(asOfMs)) {
    return false;
  }
  return asOfMs >= expiryMs;
}

export function evaluatePendingFollowUpWakeState(
  followUp: Pick<PendingFollowUp, 'dueAt' | 'wakeConditions'>,
  context: PendingFollowUpWakeContext,
): PendingFollowUpWakeEvaluation {
  const dueAtMs = typeof followUp.dueAt === 'string' ? Date.parse(followUp.dueAt) : Number.NaN;
  const dueAtReached = Number.isFinite(dueAtMs) && dueAtMs > 0 && dueAtMs <= context.now;
  const motivationSignals = new Set(
    (context.motivationSignals ?? [])
      .filter(signal => typeof signal === 'string')
      .map(signal => signal.trim().toLowerCase())
      .filter(signal => signal.length > 0),
  );
  const matchedWakeConditions = (followUp.wakeConditions ?? []).filter((condition) => {
    switch (condition) {
      case 'next_user_turn':
        return context.isBackgroundTurn === false;
      case 'background_recheck':
        return context.isBackgroundTurn === true;
      case 'sustained_negative_mood':
        return motivationSignals.has('sustained_negative_valence')
          || (
            typeof context.currentMoodValence === 'number'
            && Number.isFinite(context.currentMoodValence)
            && context.currentMoodValence <= NEGATIVE_MOOD_WAKE_THRESHOLD
          );
      default:
        return false;
    }
  });

  return {
    eligibleNow: dueAtReached || matchedWakeConditions.length > 0,
    dueAtReached,
    matchedWakeConditions,
  };
}

export function evaluatePendingFollowUpActivationState(
  followUp: Pick<PendingFollowUp, 'timing' | 'dueAt' | 'wakeConditions'>,
  context: PendingFollowUpWakeContext,
): PendingFollowUpActivationEvaluation {
  const wakeState = evaluatePendingFollowUpWakeState(followUp, context);
  const timingDue = wakeState.dueAtReached || (!followUp.dueAt && followUp.timing === 'immediate');
  return {
    ...wakeState,
    timingDue,
    eligibleNow: timingDue || wakeState.matchedWakeConditions.length > 0,
  };
}

