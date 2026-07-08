import type { EmotionStateSnapshot } from '../emotion/state.js';
import type { MemoryWriter } from '../../faculties/memory/writer.js';

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

export type BehavioralResponseStrategy = typeof BEHAVIORAL_RESPONSE_STRATEGIES[number];

export interface BehavioralPatternSample {
  id: string;
  contactId: string;
  sourceMessageId: string;
  strategy: BehavioralResponseStrategy;
  responseExcerpt: string;
  createdAt: string;
  outcomeScore?: number;
  outcomeObservedAt?: string;
  outcomeSourceMessageId?: string;
  promotedAt?: string;
  promotedMemoryId?: string;
}

export interface BehavioralStrategySummary {
  strategy: BehavioralResponseStrategy;
  sampleCount: number;
  resolvedCount: number;
  pendingCount: number;
  averageOutcome: number;
  positiveCount: number;
  negativeCount: number;
  lastOutcomeAt?: string;
}

export interface BehavioralPatternRecordInput {
  contactId: string;
  sourceMessageId: string;
  responseContent: string;
  strategy?: BehavioralResponseStrategy;
  createdAt?: string;
}

export interface BehavioralPatternOutcomeInput {
  contactId: string;
  outcomeScore: number;
  observedAt?: string;
  sourceMessageId?: string;
  strategy?: BehavioralResponseStrategy;
  outcomeSourceMessageId?: string;
}

export interface BehavioralPatternListOptions {
  contactId: string;
  includePending?: boolean;
  limit?: number;
}

export interface BehavioralPatternSummaryOptions {
  limit?: number;
  minResolvedCount?: number;
}

export interface BehavioralPatternPromotionCandidate {
  contactId: string;
  strategy: BehavioralResponseStrategy;
  sampleCount: number;
  averageOutcome: number;
  positiveRate: number;
  proceduralMemoryText: string;
}

export interface BehavioralPatternPromotionResult {
  memoryId?: string;
}

export type BehavioralPatternPromotionHook = (
  candidate: BehavioralPatternPromotionCandidate,
) => Promise<BehavioralPatternPromotionResult | void> | BehavioralPatternPromotionResult | void;

export interface BehavioralPatternTrackerOptions {
  now?: () => Date;
  idFactory?: () => string;
  promotionHook?: BehavioralPatternPromotionHook;
  minimumSamplesForPromotion?: number;
  minimumAverageOutcomeForPromotion?: number;
}

export interface BehavioralPatternContextProvider {
  getBehavioralNotes(contactId?: string, limit?: number): string;
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

export const MAX_CONTACT_ID_CHARS = 160;
export const MAX_MESSAGE_ID_CHARS = 200;
export const MAX_RESPONSE_EXCERPT_CHARS = 240;
export const MAX_PROMOTION_MEMORY_ID_CHARS = 128;
export const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
export const DEFAULT_SUMMARY_LIMIT = 4;
const MAX_SUMMARY_LIMIT = 12;
const DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION = 3;
const DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION = 0.2;
export const STRATEGY_CHECK_SQL = BEHAVIORAL_RESPONSE_STRATEGIES
  .map(strategy => `'${strategy}'`)
  .join(', ');

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function clampSigned(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Behavioral pattern outcome must be finite, received ${String(value)}`);
  }
  return Math.max(-1, Math.min(1, value));
}

export function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Behavioral pattern ${fieldName} is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Behavioral pattern ${fieldName} exceeds max length (${maxChars})`);
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
    throw new Error(`Behavioral pattern ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

export function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, 80);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Behavioral pattern ${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

export function normalizeStrategy(value: BehavioralResponseStrategy | string): BehavioralResponseStrategy {
  const normalized = compactWhitespace(String(value)).toLowerCase();
  if (!BEHAVIORAL_RESPONSE_STRATEGIES.includes(normalized as BehavioralResponseStrategy)) {
    throw new Error(`Unsupported behavioral response strategy: ${String(value)}`);
  }
  return normalized as BehavioralResponseStrategy;
}

export function normalizeOutcomeScore(value: number): number {
  return clampSigned(value);
}

export function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

export function clampSummaryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SUMMARY_LIMIT;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_SUMMARY_LIMIT);
}

export function normalizePromotionMinimumSamples(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('Behavioral pattern minimumSamplesForPromotion must be a finite integer >= 1');
  }
  return Math.floor(value);
}

export function normalizePromotionMinimumOutcome(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION;
  return clampSigned(value);
}

export function mapRow(row: BehavioralPatternRow): BehavioralPatternSample {
  const strategy = normalizeStrategy(row.strategy);
  const contactId = normalizeRequiredText(row.contact_id, 'contact_id', MAX_CONTACT_ID_CHARS);
  const sourceMessageId = normalizeRequiredText(row.source_message_id, 'source_message_id', MAX_MESSAGE_ID_CHARS);
  const responseExcerpt = normalizeRequiredText(row.response_excerpt, 'response_excerpt', MAX_RESPONSE_EXCERPT_CHARS);
  const createdAt = normalizeIsoTimestamp(row.created_at, 'created_at');
  const outcomeScore = row.outcome_score === null ? undefined : normalizeOutcomeScore(row.outcome_score);
  const outcomeObservedAt = row.outcome_observed_at === null
    ? undefined
    : normalizeIsoTimestamp(row.outcome_observed_at, 'outcome_observed_at');
  const outcomeSourceMessageId = normalizeOptionalText(
    row.outcome_source_message_id,
    'outcome_source_message_id',
    MAX_MESSAGE_ID_CHARS,
  );
  const promotedAt = row.promoted_at === null ? undefined : normalizeIsoTimestamp(row.promoted_at, 'promoted_at');
  const promotedMemoryId = normalizeOptionalText(
    row.promoted_memory_id,
    'promoted_memory_id',
    MAX_PROMOTION_MEMORY_ID_CHARS,
  );
  return {
    id: row.id,
    contactId,
    sourceMessageId,
    strategy,
    responseExcerpt,
    createdAt,
    ...(outcomeScore !== undefined ? { outcomeScore } : {}),
    ...(outcomeObservedAt ? { outcomeObservedAt } : {}),
    ...(outcomeSourceMessageId ? { outcomeSourceMessageId } : {}),
    ...(promotedAt ? { promotedAt } : {}),
    ...(promotedMemoryId ? { promotedMemoryId } : {}),
  };
}

export function mapSummaryRow(row: BehavioralPatternSummaryRow): BehavioralStrategySummary {
  const strategy = normalizeStrategy(row.strategy);
  const sampleCount = Math.max(0, Math.floor(row.sample_count));
  const resolvedCount = Math.max(0, Math.floor(row.resolved_count));
  const pendingCount = Math.max(0, Math.floor(row.pending_count));
  const averageOutcome = row.average_outcome === null ? 0 : normalizeOutcomeScore(row.average_outcome);
  const positiveCount = Math.max(0, Math.floor(row.positive_count));
  const negativeCount = Math.max(0, Math.floor(row.negative_count));
  const lastOutcomeAt = row.last_outcome_at === null
    ? undefined
    : normalizeIsoTimestamp(row.last_outcome_at, 'last_outcome_at');
  return {
    strategy,
    sampleCount,
    resolvedCount,
    pendingCount,
    averageOutcome,
    positiveCount,
    negativeCount,
    ...(lastOutcomeAt ? { lastOutcomeAt } : {}),
  };
}

function hasCodeBlock(content: string): boolean {
  return content.includes('```');
}

function hasOrderedSteps(content: string): boolean {
  return /^\s*1\.\s/m.test(content) || /\b(step|steps|algorithm|implementation|debug)\b/.test(content);
}

export function inferBehavioralResponseStrategy(responseContent: string): BehavioralResponseStrategy {
  const normalized = responseContent.trim();
  if (!normalized) {
    throw new Error('Behavioral pattern responseContent is required to infer strategy');
  }
  const lower = normalized.toLowerCase();

  if (
    /\b(i hear you|that sounds|i'm sorry|that must be|you are not alone|i can see)\b/.test(lower)
  ) {
    return 'empathy';
  }
  if (
    /\b(haha|lol|joke|playful|lighten)\b/.test(lower)
  ) {
    return 'humor';
  }
  if (
    hasCodeBlock(normalized)
    || hasOrderedSteps(lower)
    || /\b(api|schema|typescript|function|compile|stack trace)\b/.test(lower)
  ) {
    return 'technical';
  }
  if (
    /\b(let's focus|let's return|come back to|for now|we can revisit)\b/.test(lower)
  ) {
    return 'redirect';
  }
  if (
    /\b(that makes sense|valid|understandable|it's okay to)\b/.test(lower)
  ) {
    return 'validation';
  }
  if (/\?\s*$/.test(normalized) || /\b(could you|would you|can you|what if)\b/.test(lower)) {
    return 'questioning';
  }
  if (
    /\b(do this|must|need to|stop|start)\b/.test(lower)
  ) {
    return 'direct';
  }
  return 'supportive';
}

export function scoreBehavioralOutcomeFromEmotion(snapshot: EmotionStateSnapshot): number {
  const combined = (snapshot.vad.valence * 0.65) + (snapshot.mood.valence * 0.35);
  return normalizeOutcomeScore(combined);
}

function formatSigned(value: number): string {
  const normalized = normalizeOutcomeScore(value);
  const fixed = normalized.toFixed(2);
  return normalized >= 0 ? `+${fixed}` : fixed;
}

export function toBehavioralNote(summary: BehavioralStrategySummary): string {
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

export function toProceduralMemoryText(candidate: {
  strategy: BehavioralResponseStrategy;
  averageOutcome: number;
  sampleCount: number;
  positiveRate: number;
}): string {
  return (
    `For this contact, ${candidate.strategy} responses trend beneficial `
    + `(avg emotional outcome ${formatSigned(candidate.averageOutcome)} `
    + `across ${candidate.sampleCount} observations; positive rate ${Math.round(candidate.positiveRate * 100)}%).`
  );
}


export function createBehavioralPatternMemoryPromotionHook(
  memoryWriter: Pick<MemoryWriter, 'write'>,
): BehavioralPatternPromotionHook {
  return async (candidate) => {
    const result = await memoryWriter.write({
      text: candidate.proceduralMemoryText,
      type: 'procedural',
      importance: 0.72,
      salience: 0.8,
      confidence: 0.82,
      tags: [
        'behavioral_pattern',
        `response_strategy:${candidate.strategy}`,
      ],
      sourceRef: 'intention:behavioral_pattern_tracker',
      sensitivity: 'personal',
      contactId: candidate.contactId,
    });
    return { memoryId: result.memory.id };
  };
}
