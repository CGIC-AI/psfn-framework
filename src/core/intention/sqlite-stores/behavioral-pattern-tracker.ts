import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { wrapPromptSectionXml } from '../../identity/prompt-sections.js';
import {
  DEFAULT_LIST_LIMIT,
  DEFAULT_SUMMARY_LIMIT,
  MAX_CONTACT_ID_CHARS,
  MAX_MESSAGE_ID_CHARS,
  MAX_PROMOTION_MEMORY_ID_CHARS,
  MAX_RESPONSE_EXCERPT_CHARS,
  STRATEGY_CHECK_SQL,
  clampLimit,
  clampSummaryLimit,
  inferBehavioralResponseStrategy,
  mapRow,
  mapSummaryRow,
  normalizeIsoTimestamp,
  normalizeOptionalText,
  normalizeOutcomeScore,
  normalizePromotionMinimumOutcome,
  normalizePromotionMinimumSamples,
  normalizeRequiredText,
  normalizeStrategy,
  toBehavioralNote,
  toProceduralMemoryText,
} from '../patterns.js';
import type {
  BehavioralPatternContextProvider,
  BehavioralPatternListOptions,
  BehavioralPatternOutcomeInput,
  BehavioralPatternPromotionCandidate,
  BehavioralPatternPromotionHook,
  BehavioralPatternRecordInput,
  BehavioralPatternRow,
  BehavioralPatternSample,
  BehavioralPatternSummaryOptions,
  BehavioralPatternSummaryRow,
  BehavioralPatternTrackerOptions,
  BehavioralResponseStrategy,
  BehavioralStrategySummary,
} from '../patterns.js';

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
