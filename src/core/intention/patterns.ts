import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type { MemoryWriter } from '../../faculties/memory/writer.js';
import { wrapPromptSectionXml } from '../identity/prompt-sections.js';

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

interface BehavioralPatternRow {
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

interface BehavioralPatternSummaryRow {
  strategy: string;
  sample_count: number;
  resolved_count: number;
  pending_count: number;
  average_outcome: number | null;
  positive_count: number;
  negative_count: number;
  last_outcome_at: string | null;
}

const MAX_CONTACT_ID_CHARS = 160;
const MAX_MESSAGE_ID_CHARS = 200;
const MAX_RESPONSE_EXCERPT_CHARS = 240;
const MAX_PROMOTION_MEMORY_ID_CHARS = 128;
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;
const DEFAULT_SUMMARY_LIMIT = 4;
const MAX_SUMMARY_LIMIT = 12;
const DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION = 3;
const DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION = 0.2;
const STRATEGY_CHECK_SQL = BEHAVIORAL_RESPONSE_STRATEGIES
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

function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Behavioral pattern ${fieldName} is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Behavioral pattern ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

function normalizeOptionalText(
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

function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, 80);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Behavioral pattern ${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeStrategy(value: BehavioralResponseStrategy | string): BehavioralResponseStrategy {
  const normalized = compactWhitespace(String(value)).toLowerCase();
  if (!BEHAVIORAL_RESPONSE_STRATEGIES.includes(normalized as BehavioralResponseStrategy)) {
    throw new Error(`Unsupported behavioral response strategy: ${String(value)}`);
  }
  return normalized as BehavioralResponseStrategy;
}

function normalizeOutcomeScore(value: number): number {
  return clampSigned(value);
}

function clampLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

function clampSummaryLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_SUMMARY_LIMIT;
  const floored = Math.floor(value);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_SUMMARY_LIMIT);
}

function normalizePromotionMinimumSamples(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('Behavioral pattern minimumSamplesForPromotion must be a finite integer >= 1');
  }
  return Math.floor(value);
}

function normalizePromotionMinimumOutcome(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION;
  return clampSigned(value);
}

function mapRow(row: BehavioralPatternRow): BehavioralPatternSample {
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

function mapSummaryRow(row: BehavioralPatternSummaryRow): BehavioralStrategySummary {
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

function toBehavioralNote(summary: BehavioralStrategySummary): string {
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

function toProceduralMemoryText(candidate: {
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

export class BehavioralPatternTracker implements BehavioralPatternContextProvider {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private promotionHook: BehavioralPatternPromotionHook | null;
  private readonly minimumSamplesForPromotion: number;
  private readonly minimumAverageOutcomeForPromotion: number;

  constructor(db: Database.Database, options: BehavioralPatternTrackerOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.promotionHook = options.promotionHook ?? null;
    this.minimumSamplesForPromotion = normalizePromotionMinimumSamples(options.minimumSamplesForPromotion);
    this.minimumAverageOutcomeForPromotion = normalizePromotionMinimumOutcome(
      options.minimumAverageOutcomeForPromotion,
    );
    this.initializeSchema();
  }

  setPromotionHook(hook: BehavioralPatternPromotionHook | null): void {
    this.promotionHook = hook;
  }

  recordResponseStrategy(input: BehavioralPatternRecordInput): BehavioralPatternSample {
    const contactId = normalizeRequiredText(input.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const sourceMessageId = normalizeRequiredText(
      input.sourceMessageId,
      'sourceMessageId',
      MAX_MESSAGE_ID_CHARS,
    );
    const normalizedResponse = normalizeRequiredText(
      input.responseContent,
      'responseContent',
      20_000,
    );
    const strategy = input.strategy
      ? normalizeStrategy(input.strategy)
      : inferBehavioralResponseStrategy(normalizedResponse);
    const createdAt = input.createdAt
      ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
      : this.now().toISOString();
    const responseExcerpt = normalizedResponse.length > MAX_RESPONSE_EXCERPT_CHARS
      ? `${normalizedResponse.slice(0, MAX_RESPONSE_EXCERPT_CHARS - 3)}...`
      : normalizedResponse;
    const id = normalizeRequiredText(this.idFactory(), 'id', 128);

    this.db.prepare(`
      INSERT INTO behavioral_pattern_events (
        id,
        contact_id,
        source_message_id,
        strategy,
        response_excerpt,
        created_at
      ) VALUES (
        @id,
        @contact_id,
        @source_message_id,
        @strategy,
        @response_excerpt,
        @created_at
      )
      ON CONFLICT(contact_id, source_message_id, strategy)
      DO UPDATE SET response_excerpt = excluded.response_excerpt
    `).run({
      id,
      contact_id: contactId,
      source_message_id: sourceMessageId,
      strategy,
      response_excerpt: responseExcerpt,
      created_at: createdAt,
    });

    return this.requireByUnique(contactId, sourceMessageId, strategy);
  }

  async recordOutcomeForSample(
    input: BehavioralPatternOutcomeInput,
  ): Promise<BehavioralPatternSample> {
    const contactId = normalizeRequiredText(input.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const outcomeScore = normalizeOutcomeScore(input.outcomeScore);
    const observedAt = input.observedAt
      ? normalizeIsoTimestamp(input.observedAt, 'observedAt')
      : this.now().toISOString();
    const normalizedSourceMessageId = input.sourceMessageId
      ? normalizeRequiredText(input.sourceMessageId, 'sourceMessageId', MAX_MESSAGE_ID_CHARS)
      : undefined;
    const normalizedStrategy = input.strategy ? normalizeStrategy(input.strategy) : undefined;
    const outcomeSourceMessageId = normalizeOptionalText(
      input.outcomeSourceMessageId,
      'outcomeSourceMessageId',
      MAX_MESSAGE_ID_CHARS,
    );

    const target = this.resolveOutcomeTarget({
      contactId,
      sourceMessageId: normalizedSourceMessageId,
      strategy: normalizedStrategy,
    });
    if (!target) {
      throw new Error('Behavioral pattern outcome target was not found');
    }

    this.db.prepare(`
      UPDATE behavioral_pattern_events
      SET
        outcome_score = @outcome_score,
        outcome_observed_at = @outcome_observed_at,
        outcome_source_message_id = @outcome_source_message_id
      WHERE id = @id
    `).run({
      id: target.id,
      outcome_score: outcomeScore,
      outcome_observed_at: observedAt,
      outcome_source_message_id: outcomeSourceMessageId ?? null,
    });

    const updated = this.requireById(target.id);
    await this.maybePromoteStrategy(updated.contactId, updated.strategy);
    return updated;
  }

  async tryRecordOutcomeForLatestPending(
    input: {
      contactId: string;
      outcomeScore: number;
      observedAt?: string;
      strategy?: BehavioralResponseStrategy;
      outcomeSourceMessageId?: string;
    },
  ): Promise<BehavioralPatternSample | null> {
    const contactId = normalizeRequiredText(input.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const strategy = input.strategy ? normalizeStrategy(input.strategy) : undefined;
    const row = this.db.prepare(`
      SELECT
        id,
        contact_id,
        source_message_id,
        strategy,
        response_excerpt,
        created_at,
        outcome_score,
        outcome_observed_at,
        outcome_source_message_id,
        promoted_at,
        promoted_memory_id
      FROM behavioral_pattern_events
      WHERE
        contact_id = @contact_id
        AND outcome_score IS NULL
        ${strategy ? 'AND strategy = @strategy' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get({
      contact_id: contactId,
      strategy,
    }) as BehavioralPatternRow | undefined;

    if (!row) {
      return null;
    }

    return this.recordOutcomeForSample({
      contactId,
      sourceMessageId: row.source_message_id,
      strategy: normalizeStrategy(row.strategy),
      outcomeScore: input.outcomeScore,
      observedAt: input.observedAt,
      outcomeSourceMessageId: input.outcomeSourceMessageId,
    });
  }

  listSamples(options: BehavioralPatternListOptions): BehavioralPatternSample[] {
    const contactId = normalizeRequiredText(options.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const includePending = options.includePending === true;
    const limit = clampLimit(options.limit, DEFAULT_LIST_LIMIT);
    const rows = this.db.prepare(`
      SELECT
        id,
        contact_id,
        source_message_id,
        strategy,
        response_excerpt,
        created_at,
        outcome_score,
        outcome_observed_at,
        outcome_source_message_id,
        promoted_at,
        promoted_memory_id
      FROM behavioral_pattern_events
      WHERE
        contact_id = @contact_id
        ${includePending ? '' : 'AND outcome_score IS NOT NULL'}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit
    `).all({
      contact_id: contactId,
      limit,
    }) as BehavioralPatternRow[];

    return rows.map(row => mapRow(row));
  }

  listStrategySummaries(
    contactId: string,
    options: BehavioralPatternSummaryOptions = {},
  ): BehavioralStrategySummary[] {
    const normalizedContactId = normalizeRequiredText(contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const limit = clampSummaryLimit(options.limit);
    const minResolvedCount = options.minResolvedCount === undefined
      ? 1
      : Math.max(1, Math.floor(options.minResolvedCount));

    const rows = this.db.prepare(`
      SELECT
        strategy,
        COUNT(*) AS sample_count,
        SUM(CASE WHEN outcome_score IS NOT NULL THEN 1 ELSE 0 END) AS resolved_count,
        SUM(CASE WHEN outcome_score IS NULL THEN 1 ELSE 0 END) AS pending_count,
        AVG(outcome_score) AS average_outcome,
        SUM(CASE WHEN outcome_score > 0.1 THEN 1 ELSE 0 END) AS positive_count,
        SUM(CASE WHEN outcome_score < -0.1 THEN 1 ELSE 0 END) AS negative_count,
        MAX(outcome_observed_at) AS last_outcome_at
      FROM behavioral_pattern_events
      WHERE contact_id = @contact_id
      GROUP BY strategy
      HAVING resolved_count >= @min_resolved_count
      ORDER BY average_outcome DESC, resolved_count DESC, strategy ASC
      LIMIT @limit
    `).all({
      contact_id: normalizedContactId,
      min_resolved_count: minResolvedCount,
      limit,
    }) as BehavioralPatternSummaryRow[];

    return rows.map(row => mapSummaryRow(row));
  }

  getBehavioralNotes(contactId?: string, limit = DEFAULT_SUMMARY_LIMIT): string {
    if (!contactId) {
      return '';
    }
    const normalizedContactId = normalizeRequiredText(contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const summaries = this.listStrategySummaries(normalizedContactId, {
      limit,
      minResolvedCount: 1,
    });
    if (summaries.length === 0) {
      return '';
    }

    const lines: string[] = [];
    for (const summary of summaries) {
      lines.push(toBehavioralNote(summary));
    }
    return wrapPromptSectionXml({
      id: 'behavioral_notes',
      content: lines.join('\n'),
    });
  }

  private resolveOutcomeTarget(
    input: {
      contactId: string;
      sourceMessageId?: string;
      strategy?: BehavioralResponseStrategy;
    },
  ): BehavioralPatternSample | null {
    if (input.sourceMessageId) {
      const rows = this.db.prepare(`
        SELECT
          id,
          contact_id,
          source_message_id,
          strategy,
          response_excerpt,
          created_at,
          outcome_score,
          outcome_observed_at,
          outcome_source_message_id,
          promoted_at,
          promoted_memory_id
        FROM behavioral_pattern_events
        WHERE
          contact_id = @contact_id
          AND source_message_id = @source_message_id
          ${input.strategy ? 'AND strategy = @strategy' : ''}
      `).all({
        contact_id: input.contactId,
        source_message_id: input.sourceMessageId,
        strategy: input.strategy,
      }) as BehavioralPatternRow[];

      if (rows.length === 0) {
        return null;
      }
      if (rows.length > 1) {
        throw new Error('Behavioral pattern outcome target is ambiguous; provide an explicit strategy');
      }
      return mapRow(rows[0]!);
    }

    const row = this.db.prepare(`
      SELECT
        id,
        contact_id,
        source_message_id,
        strategy,
        response_excerpt,
        created_at,
        outcome_score,
        outcome_observed_at,
        outcome_source_message_id,
        promoted_at,
        promoted_memory_id
      FROM behavioral_pattern_events
      WHERE
        contact_id = @contact_id
        AND outcome_score IS NULL
        ${input.strategy ? 'AND strategy = @strategy' : ''}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `).get({
      contact_id: input.contactId,
      strategy: input.strategy,
    }) as BehavioralPatternRow | undefined;

    return row ? mapRow(row) : null;
  }

  private requireById(id: string): BehavioralPatternSample {
    const row = this.db.prepare(`
      SELECT
        id,
        contact_id,
        source_message_id,
        strategy,
        response_excerpt,
        created_at,
        outcome_score,
        outcome_observed_at,
        outcome_source_message_id,
        promoted_at,
        promoted_memory_id
      FROM behavioral_pattern_events
      WHERE id = @id
    `).get({ id }) as BehavioralPatternRow | undefined;
    if (!row) {
      throw new Error(`Behavioral pattern event "${id}" is missing after write`);
    }
    return mapRow(row);
  }

  private requireByUnique(
    contactId: string,
    sourceMessageId: string,
    strategy: BehavioralResponseStrategy,
  ): BehavioralPatternSample {
    const row = this.db.prepare(`
      SELECT
        id,
        contact_id,
        source_message_id,
        strategy,
        response_excerpt,
        created_at,
        outcome_score,
        outcome_observed_at,
        outcome_source_message_id,
        promoted_at,
        promoted_memory_id
      FROM behavioral_pattern_events
      WHERE
        contact_id = @contact_id
        AND source_message_id = @source_message_id
        AND strategy = @strategy
    `).get({
      contact_id: contactId,
      source_message_id: sourceMessageId,
      strategy,
    }) as BehavioralPatternRow | undefined;
    if (!row) {
      throw new Error('Behavioral pattern event is missing after upsert');
    }
    return mapRow(row);
  }

  private async maybePromoteStrategy(
    contactId: string,
    strategy: BehavioralResponseStrategy,
  ): Promise<void> {
    if (!this.promotionHook) return;

    const existingPromotion = this.db.prepare(`
      SELECT promoted_memory_id
      FROM behavioral_pattern_events
      WHERE
        contact_id = @contact_id
        AND strategy = @strategy
        AND promoted_at IS NOT NULL
      ORDER BY promoted_at ASC
      LIMIT 1
    `).get({
      contact_id: contactId,
      strategy,
    }) as { promoted_memory_id: string | null } | undefined;
    if (existingPromotion) {
      this.db.prepare(`
        UPDATE behavioral_pattern_events
        SET
          promoted_at = @promoted_at,
          promoted_memory_id = COALESCE(promoted_memory_id, @promoted_memory_id)
        WHERE
          contact_id = @contact_id
          AND strategy = @strategy
          AND promoted_at IS NULL
          AND outcome_score IS NOT NULL
      `).run({
        promoted_at: this.now().toISOString(),
        promoted_memory_id: existingPromotion.promoted_memory_id,
        contact_id: contactId,
        strategy,
      });
      return;
    }

    const summary = this.getStrategySummary(contactId, strategy);
    if (!summary) {
      return;
    }
    if (summary.resolvedCount < this.minimumSamplesForPromotion) {
      return;
    }
    if (summary.averageOutcome < this.minimumAverageOutcomeForPromotion) {
      return;
    }

    const positiveRate = summary.resolvedCount > 0
      ? summary.positiveCount / summary.resolvedCount
      : 0;
    const candidate: BehavioralPatternPromotionCandidate = {
      contactId,
      strategy,
      sampleCount: summary.resolvedCount,
      averageOutcome: summary.averageOutcome,
      positiveRate,
      proceduralMemoryText: toProceduralMemoryText({
        strategy,
        averageOutcome: summary.averageOutcome,
        sampleCount: summary.resolvedCount,
        positiveRate,
      }),
    };
    const promotion = await this.promotionHook(candidate);
    const promotedMemoryId = normalizeOptionalText(
      promotion?.memoryId,
      'promotionMemoryId',
      MAX_PROMOTION_MEMORY_ID_CHARS,
    );
    this.db.prepare(`
      UPDATE behavioral_pattern_events
      SET
        promoted_at = @promoted_at,
        promoted_memory_id = @promoted_memory_id
      WHERE
        contact_id = @contact_id
        AND strategy = @strategy
        AND promoted_at IS NULL
        AND outcome_score IS NOT NULL
    `).run({
      promoted_at: this.now().toISOString(),
      promoted_memory_id: promotedMemoryId ?? null,
      contact_id: contactId,
      strategy,
    });
  }

  private getStrategySummary(
    contactId: string,
    strategy: BehavioralResponseStrategy,
  ): BehavioralStrategySummary | null {
    const row = this.db.prepare(`
      SELECT
        strategy,
        COUNT(*) AS sample_count,
        SUM(CASE WHEN outcome_score IS NOT NULL THEN 1 ELSE 0 END) AS resolved_count,
        SUM(CASE WHEN outcome_score IS NULL THEN 1 ELSE 0 END) AS pending_count,
        AVG(outcome_score) AS average_outcome,
        SUM(CASE WHEN outcome_score > 0.1 THEN 1 ELSE 0 END) AS positive_count,
        SUM(CASE WHEN outcome_score < -0.1 THEN 1 ELSE 0 END) AS negative_count,
        MAX(outcome_observed_at) AS last_outcome_at
      FROM behavioral_pattern_events
      WHERE
        contact_id = @contact_id
        AND strategy = @strategy
      GROUP BY strategy
    `).get({
      contact_id: contactId,
      strategy,
    }) as BehavioralPatternSummaryRow | undefined;
    return row ? mapSummaryRow(row) : null;
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS behavioral_pattern_events (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        source_message_id TEXT NOT NULL,
        strategy TEXT NOT NULL,
        response_excerpt TEXT NOT NULL,
        created_at TEXT NOT NULL,
        outcome_score REAL,
        outcome_observed_at TEXT,
        outcome_source_message_id TEXT,
        promoted_at TEXT,
        promoted_memory_id TEXT,
        CHECK (strategy IN (${STRATEGY_CHECK_SQL})),
        CHECK (
          outcome_score IS NULL
          OR (outcome_score >= -1 AND outcome_score <= 1)
        )
      );

      CREATE UNIQUE INDEX IF NOT EXISTS idx_behavioral_pattern_unique_turn
      ON behavioral_pattern_events (contact_id, source_message_id, strategy);

      CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_contact_created
      ON behavioral_pattern_events (contact_id, created_at DESC, id DESC);

      CREATE INDEX IF NOT EXISTS idx_behavioral_pattern_pending
      ON behavioral_pattern_events (contact_id, strategy, outcome_score, created_at DESC);
    `);

    const columns = this.db.prepare('PRAGMA table_info(behavioral_pattern_events)')
      .all() as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'outcome_source_message_id')) {
      this.db.exec('ALTER TABLE behavioral_pattern_events ADD COLUMN outcome_source_message_id TEXT');
    }
    if (!columns.some(column => column.name === 'promoted_at')) {
      this.db.exec('ALTER TABLE behavioral_pattern_events ADD COLUMN promoted_at TEXT');
    }
    if (!columns.some(column => column.name === 'promoted_memory_id')) {
      this.db.exec('ALTER TABLE behavioral_pattern_events ADD COLUMN promoted_memory_id TEXT');
    }
  }
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
