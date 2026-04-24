import type { Pool } from 'pg';
import { wrapPromptSectionXml } from '../../identity/prompt-sections.js';
import { queryOne, queryRows } from './connection.js';
import type { PostgresIntentionPortOptions } from './types.js';
import type {
  BehavioralPatternPromotionHook,
  BehavioralPatternSample,
  BehavioralStrategySummary,
} from '../patterns.js';
import {
  BEHAVIORAL_RESPONSE_STRATEGIES,
  DEFAULT_BEHAVIORAL_LIST_LIMIT,
  DEFAULT_BEHAVIORAL_SUMMARY_LIMIT,
  DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION,
  DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION,
  MAX_CONTACT_ID_CHARS,
  MAX_MESSAGE_ID_CHARS,
  MAX_PROMOTION_MEMORY_ID_CHARS,
  MAX_RESPONSE_EXCERPT_CHARS,
  BehavioralPatternRow,
  BehavioralPatternSummaryRow,
  clampListLimit,
  clampSummaryLimit,
  mapBehavioralPatternRow,
  mapBehavioralStrategySummaryRow,
  normalizeContactId,
  normalizeIsoTimestamp,
  normalizeOptionalText,
  normalizeOutcomeScore,
  normalizeRequiredText,
  normalizeStrategy,
  toProceduralMemoryText,
} from './shared.js';

export class PostgresBehavioralPatternTracker {
  private promotionHook: BehavioralPatternPromotionHook | null;
  private sampleCache = new Map<string, BehavioralPatternSample>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
    options: Pick<PostgresIntentionPortOptions, 'promotionHook' | 'minimumSamplesForPromotion' | 'minimumAverageOutcomeForPromotion'> = {},
  ) {
    this.promotionHook = options.promotionHook ?? null;
    this.minimumSamplesForPromotion = normalizeMinimumSamplesForPromotion(options.minimumSamplesForPromotion);
    this.minimumAverageOutcomeForPromotion = normalizeMinimumAverageOutcomeForPromotion(options.minimumAverageOutcomeForPromotion);
  }

  private readonly minimumSamplesForPromotion: number;
  private readonly minimumAverageOutcomeForPromotion: number;

  setPromotionHook(hook: BehavioralPatternPromotionHook | null): void {
    this.promotionHook = hook;
  }

  async hydrateCache(): Promise<void> {
    const rows = await queryRows<BehavioralPatternRow>(
      this.pool,
      `
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
      `,
    );
    this.sampleCache = new Map(
      rows.map((row) => {
        const sample = mapBehavioralPatternRow(row);
        return [sample.id, sample] as const;
      }),
    );
  }

  snapshotBehavioralNotes(contactId?: string, limit = DEFAULT_BEHAVIORAL_SUMMARY_LIMIT): string {
    const normalizedContactId = normalizeContactId(contactId);
    if (!normalizedContactId) {
      return '';
    }
    const summaries = this.summarizeSamples(normalizedContactId, clampSummaryLimit(limit), 1);
    if (summaries.length === 0) {
      return '';
    }
    return wrapPromptSectionXml({
      id: 'behavioral_notes',
      content: summaries.map(summary => toBehavioralNote(summary)).join('\n'),
    });
  }

  private summarizeSamples(
    contactId: string,
    limit: number,
    minResolvedCount: number,
  ): BehavioralStrategySummary[] {
    const summaries = new Map<string, BehavioralStrategySummary>();
    for (const sample of this.sampleCache.values()) {
      if (sample.contactId !== contactId) continue;
      const existing = summaries.get(sample.strategy) ?? {
        strategy: sample.strategy,
        sampleCount: 0,
        resolvedCount: 0,
        pendingCount: 0,
        averageOutcome: 0,
        positiveCount: 0,
        negativeCount: 0,
      };
      existing.sampleCount += 1;
      if (sample.outcomeScore === undefined) {
        existing.pendingCount += 1;
      } else {
        existing.resolvedCount += 1;
        existing.averageOutcome += sample.outcomeScore;
        if (sample.outcomeScore > 0.1) existing.positiveCount += 1;
        if (sample.outcomeScore < -0.1) existing.negativeCount += 1;
        if (!existing.lastOutcomeAt || (sample.outcomeObservedAt && sample.outcomeObservedAt > existing.lastOutcomeAt)) {
          existing.lastOutcomeAt = sample.outcomeObservedAt;
        }
      }
      summaries.set(sample.strategy, existing);
    }

    return [...summaries.values()]
      .filter(summary => summary.resolvedCount >= minResolvedCount)
      .map(summary => ({
        ...summary,
        averageOutcome: summary.resolvedCount > 0
          ? summary.averageOutcome / summary.resolvedCount
          : 0,
      }))
      .sort((left, right) => (
        right.averageOutcome - left.averageOutcome
        || right.resolvedCount - left.resolvedCount
        || left.strategy.localeCompare(right.strategy)
      ))
      .slice(0, limit);
  }

  async recordResponseStrategy(input: {
    contactId: string;
    sourceMessageId: string;
    responseContent: string;
    strategy?: (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number];
    createdAt?: string;
  }): Promise<BehavioralPatternSample> {
    const contactId = normalizeRequiredText(input.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const sourceMessageId = normalizeRequiredText(input.sourceMessageId, 'sourceMessageId', MAX_MESSAGE_ID_CHARS);
    const responseContent = normalizeRequiredText(input.responseContent, 'responseContent', 20_000);
    const strategy = input.strategy ? normalizeStrategy(input.strategy) : inferBehavioralResponseStrategy(responseContent);
    const createdAt = input.createdAt ? normalizeIsoTimestamp(input.createdAt, 'createdAt') : this.now().toISOString();
    const responseExcerpt = responseContent.length > MAX_RESPONSE_EXCERPT_CHARS
      ? `${responseContent.slice(0, MAX_RESPONSE_EXCERPT_CHARS - 3)}...`
      : responseContent;
    const id = normalizeRequiredText(this.idFactory(), 'id', 128);

    const row = await queryOne<BehavioralPatternRow>(
      this.pool,
      `
        INSERT INTO behavioral_pattern_events (
          id, contact_id, source_message_id, strategy, response_excerpt, created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6
        )
        ON CONFLICT (contact_id, source_message_id, strategy)
        DO UPDATE SET response_excerpt = EXCLUDED.response_excerpt
        RETURNING
          id, contact_id, source_message_id, strategy, response_excerpt, created_at,
          outcome_score, outcome_observed_at, outcome_source_message_id, promoted_at, promoted_memory_id
      `,
      [id, contactId, sourceMessageId, strategy, responseExcerpt, createdAt],
    );
    if (!row) {
      throw new Error('Behavioral pattern event is missing after upsert');
    }
    const sample = mapBehavioralPatternRow(row);
    this.sampleCache.set(sample.id, sample);
    return sample;
  }

  async recordOutcomeForSample(input: {
    contactId: string;
    outcomeScore: number;
    observedAt?: string;
    sourceMessageId?: string;
    strategy?: (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number];
    outcomeSourceMessageId?: string;
  }): Promise<BehavioralPatternSample> {
    const contactId = normalizeRequiredText(input.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const outcomeScore = normalizeOutcomeScore(input.outcomeScore);
    const observedAt = input.observedAt ? normalizeIsoTimestamp(input.observedAt, 'observedAt') : this.now().toISOString();
    const normalizedSourceMessageId = input.sourceMessageId
      ? normalizeRequiredText(input.sourceMessageId, 'sourceMessageId', MAX_MESSAGE_ID_CHARS)
      : undefined;
    const normalizedStrategy = input.strategy ? normalizeStrategy(input.strategy) : undefined;
    const outcomeSourceMessageId = input.outcomeSourceMessageId
      ? normalizeOptionalText(input.outcomeSourceMessageId, 'outcomeSourceMessageId', MAX_MESSAGE_ID_CHARS)
      : undefined;

    const target = await this.resolveOutcomeTarget({
      contactId,
      sourceMessageId: normalizedSourceMessageId,
      strategy: normalizedStrategy,
    });
    if (!target) {
      throw new Error('Behavioral pattern outcome target was not found');
    }

    const row = await queryOne<BehavioralPatternRow>(
      this.pool,
      `
        UPDATE behavioral_pattern_events
        SET outcome_score = $2, outcome_observed_at = $3, outcome_source_message_id = $4
        WHERE id = $1
        RETURNING
          id, contact_id, source_message_id, strategy, response_excerpt, created_at,
          outcome_score, outcome_observed_at, outcome_source_message_id, promoted_at, promoted_memory_id
      `,
      [target.id, outcomeScore, observedAt, outcomeSourceMessageId ?? null],
    );
    if (!row) {
      throw new Error('Behavioral pattern outcome update failed');
    }

    const updated = mapBehavioralPatternRow(row);
    this.sampleCache.set(updated.id, updated);
    await this.maybePromoteStrategy(updated.contactId, updated.strategy);
    return updated;
  }

  async tryRecordOutcomeForLatestPending(input: {
    contactId: string;
    outcomeScore: number;
    observedAt?: string;
    strategy?: (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number];
    outcomeSourceMessageId?: string;
  }): Promise<BehavioralPatternSample | null> {
    const contactId = normalizeRequiredText(input.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const strategy = input.strategy ? normalizeStrategy(input.strategy) : undefined;
    const row = await queryOne<BehavioralPatternRow>(
      this.pool,
      `
        SELECT
          id, contact_id, source_message_id, strategy, response_excerpt, created_at,
          outcome_score, outcome_observed_at, outcome_source_message_id, promoted_at, promoted_memory_id
        FROM behavioral_pattern_events
        WHERE contact_id = $1 AND outcome_score IS NULL
        ${strategy ? 'AND strategy = $2' : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      strategy ? [contactId, strategy] : [contactId],
    );
    if (!row) {
      return null;
    }

    return await this.recordOutcomeForSample({
      contactId,
      sourceMessageId: row.source_message_id,
      strategy: normalizeStrategy(row.strategy),
      outcomeScore: input.outcomeScore,
      observedAt: input.observedAt,
      outcomeSourceMessageId: input.outcomeSourceMessageId,
    });
  }

  async listSamples(options: {
    contactId: string;
    includePending?: boolean;
    limit?: number;
  }): Promise<BehavioralPatternSample[]> {
    const contactId = normalizeRequiredText(options.contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const includePending = options.includePending === true;
    const limit = clampListLimit(options.limit, DEFAULT_BEHAVIORAL_LIST_LIMIT);
    const rows = await queryRows<BehavioralPatternRow>(
      this.pool,
      `
        SELECT
          id, contact_id, source_message_id, strategy, response_excerpt, created_at,
          outcome_score, outcome_observed_at, outcome_source_message_id, promoted_at, promoted_memory_id
        FROM behavioral_pattern_events
        WHERE contact_id = $1
        ${includePending ? '' : 'AND outcome_score IS NOT NULL'}
        ORDER BY created_at DESC, id DESC
        LIMIT $2
      `,
      [contactId, limit],
    );
    return rows.map(mapBehavioralPatternRow);
  }

  async listStrategySummaries(
    contactId: string,
    options: { limit?: number; minResolvedCount?: number } = {},
  ): Promise<BehavioralStrategySummary[]> {
    const normalizedContactId = normalizeRequiredText(contactId, 'contactId', MAX_CONTACT_ID_CHARS);
    const limit = clampSummaryLimit(options.limit);
    const minResolvedCount = options.minResolvedCount === undefined
      ? 1
      : Math.max(1, Math.floor(options.minResolvedCount));

    const rows = await queryRows<BehavioralPatternSummaryRow>(
      this.pool,
      `
        SELECT
          strategy,
          COUNT(*)::INTEGER AS sample_count,
          SUM(CASE WHEN outcome_score IS NOT NULL THEN 1 ELSE 0 END)::INTEGER AS resolved_count,
          SUM(CASE WHEN outcome_score IS NULL THEN 1 ELSE 0 END)::INTEGER AS pending_count,
          AVG(outcome_score) AS average_outcome,
          SUM(CASE WHEN outcome_score > 0.1 THEN 1 ELSE 0 END)::INTEGER AS positive_count,
          SUM(CASE WHEN outcome_score < -0.1 THEN 1 ELSE 0 END)::INTEGER AS negative_count,
          MAX(outcome_observed_at) AS last_outcome_at
        FROM behavioral_pattern_events
        WHERE contact_id = $1
        GROUP BY strategy
        HAVING SUM(CASE WHEN outcome_score IS NOT NULL THEN 1 ELSE 0 END) >= $2
        ORDER BY average_outcome DESC, resolved_count DESC, strategy ASC
        LIMIT $3
      `,
      [normalizedContactId, minResolvedCount, limit],
    );
    return rows.map(mapBehavioralStrategySummaryRow);
  }

  private async resolveOutcomeTarget(input: {
    contactId: string;
    sourceMessageId?: string;
    strategy?: (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number];
  }): Promise<BehavioralPatternRow | null> {
    if (input.sourceMessageId) {
      const rows = await queryRows<BehavioralPatternRow>(
        this.pool,
        `
          SELECT
            id, contact_id, source_message_id, strategy, response_excerpt, created_at,
            outcome_score, outcome_observed_at, outcome_source_message_id, promoted_at, promoted_memory_id
          FROM behavioral_pattern_events
          WHERE contact_id = $1 AND source_message_id = $2
          ${input.strategy ? 'AND strategy = $3' : ''}
        `,
        input.strategy ? [input.contactId, input.sourceMessageId, input.strategy] : [input.contactId, input.sourceMessageId],
      );

      if (rows.length === 0) return null;
      if (rows.length > 1) {
        throw new Error('Behavioral pattern outcome target is ambiguous; provide an explicit strategy');
      }
      return rows[0] ?? null;
    }

    return await queryOne<BehavioralPatternRow>(
      this.pool,
      `
        SELECT
          id, contact_id, source_message_id, strategy, response_excerpt, created_at,
          outcome_score, outcome_observed_at, outcome_source_message_id, promoted_at, promoted_memory_id
        FROM behavioral_pattern_events
        WHERE contact_id = $1 AND outcome_score IS NULL
        ${input.strategy ? 'AND strategy = $2' : ''}
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
      input.strategy ? [input.contactId, input.strategy] : [input.contactId],
    );
  }

  private async maybePromoteStrategy(contactId: string, strategy: string): Promise<void> {
    if (!this.promotionHook) return;

    const existingPromotion = await queryOne<{ promoted_memory_id: string | null }>(
      this.pool,
      `
        SELECT promoted_memory_id
        FROM behavioral_pattern_events
        WHERE contact_id = $1 AND strategy = $2 AND promoted_at IS NOT NULL
        ORDER BY promoted_at ASC
        LIMIT 1
      `,
      [contactId, strategy],
    );
    if (existingPromotion) {
      await this.pool.query(
        `
          UPDATE behavioral_pattern_events
          SET promoted_at = $1, promoted_memory_id = COALESCE(promoted_memory_id, $2)
          WHERE contact_id = $3 AND strategy = $4 AND promoted_at IS NULL AND outcome_score IS NOT NULL
        `,
        [this.now().toISOString(), existingPromotion.promoted_memory_id, contactId, strategy],
      );
      return;
    }

    const summary = await this.getStrategySummary(contactId, strategy);
    if (!summary) return;
    if (summary.resolvedCount < this.minimumSamplesForPromotion) return;
    if (summary.averageOutcome < this.minimumAverageOutcomeForPromotion) return;

    const positiveRate = summary.resolvedCount > 0 ? summary.positiveCount / summary.resolvedCount : 0;
    const candidate = {
      contactId,
      strategy: summary.strategy,
      sampleCount: summary.resolvedCount,
      averageOutcome: summary.averageOutcome,
      positiveRate,
      proceduralMemoryText: toProceduralMemoryText({
        strategy: summary.strategy,
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
    await this.pool.query(
      `
        UPDATE behavioral_pattern_events
        SET promoted_at = $1, promoted_memory_id = $2
        WHERE contact_id = $3 AND strategy = $4 AND promoted_at IS NULL AND outcome_score IS NOT NULL
      `,
      [this.now().toISOString(), promotedMemoryId ?? null, contactId, strategy],
    );
  }

  private async getStrategySummary(
    contactId: string,
    strategy: string,
  ): Promise<BehavioralStrategySummary | null> {
    const row = await queryOne<BehavioralPatternSummaryRow>(
      this.pool,
      `
        SELECT
          strategy,
          COUNT(*)::INTEGER AS sample_count,
          SUM(CASE WHEN outcome_score IS NOT NULL THEN 1 ELSE 0 END)::INTEGER AS resolved_count,
          SUM(CASE WHEN outcome_score IS NULL THEN 1 ELSE 0 END)::INTEGER AS pending_count,
          AVG(outcome_score) AS average_outcome,
          SUM(CASE WHEN outcome_score > 0.1 THEN 1 ELSE 0 END)::INTEGER AS positive_count,
          SUM(CASE WHEN outcome_score < -0.1 THEN 1 ELSE 0 END)::INTEGER AS negative_count,
          MAX(outcome_observed_at) AS last_outcome_at
        FROM behavioral_pattern_events
        WHERE contact_id = $1 AND strategy = $2
        GROUP BY strategy
      `,
      [contactId, strategy],
    );
    return row ? mapBehavioralStrategySummaryRow(row) : null;
  }
}

function inferBehavioralResponseStrategy(responseContent: string): (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number] {
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

function normalizeMinimumSamplesForPromotion(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION;
  if (!Number.isFinite(value) || value < 1) {
    throw new Error('Behavioral pattern minimumSamplesForPromotion must be a finite integer >= 1');
  }
  return Math.floor(value);
}

function normalizeMinimumAverageOutcomeForPromotion(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION;
  return normalizeOutcomeScore(value);
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
