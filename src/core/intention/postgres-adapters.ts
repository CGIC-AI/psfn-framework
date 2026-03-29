import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema, queryOne, queryRows } from '../../persistence/postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from '../../persistence/postgres/migrations.js';
import { wrapPromptSectionXml } from '../identity/prompt-sections.js';
import type { BehavioralPatternPromotionHook } from './patterns.js';
import {
  createBehavioralPatternStorePort,
  type BehavioralPatternContextProvider,
  type BehavioralPatternStorePort as BehavioralPatternPort,
  type BehavioralPatternSample,
  type BehavioralStrategySummary,
} from './patterns.js';
import {
  type ActiveConcernContextProvider,
  createConcernStorePort,
  type ActiveConcern,
  type ActiveConcernCreateInput,
  type ActiveConcernListOptions,
  type ActiveConcernRecentResolutionOptions,
  type ActiveConcernResolveOptions,
  type ConcernStorePort,
} from './concerns.js';
import {
  createPendingFollowUpStorePort,
  type PendingFollowUpContextProvider,
  type PendingFollowUp,
  type PendingFollowUpActivateOptions,
  type PendingFollowUpCreateInput,
  type PendingFollowUpListOptions,
  type PendingFollowUpStorePort,
} from './pending-follow-ups.js';

export interface PostgresIntentionPorts {
  concernProvider: ActiveConcernContextProvider;
  pendingFollowUpProvider: PendingFollowUpContextProvider;
  behavioralPatternProvider: BehavioralPatternContextProvider;
  concernStore: ConcernStorePort;
  pendingFollowUpStore: PendingFollowUpStorePort;
  behavioralPatternTracker: BehavioralPatternPort;
}

export interface PostgresIntentionPortOptions {
  pool?: Pool;
  applicationName?: string;
  now?: () => Date;
  idFactory?: () => string;
  promotionHook?: BehavioralPatternPromotionHook | null;
  minimumSamplesForPromotion?: number;
  minimumAverageOutcomeForPromotion?: number;
}

interface ActiveConcernRow {
  id: string;
  text: string;
  priority: string;
  source: string;
  created_at: string;
  expires_at: string;
  resolved_at: string | null;
  resolution_outcome: string | null;
  contact_id: string | null;
  formation_vad: unknown;
}

interface PendingFollowUpRow {
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
  activated_at: string | null;
  activation_reason: string | null;
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

const ACTIVE_CONCERN_PRIORITIES = ['high', 'medium', 'low'] as const;
const ACTIVE_CONCERN_SOURCES = ['appraisal', 'agent', 'heartbeat'] as const;
const PENDING_FOLLOW_UP_PRIORITIES = ['low', 'medium', 'high'] as const;
const PENDING_FOLLOW_UP_TIMINGS = ['immediate', 'soon', 'scheduled'] as const;
const CHANNEL_TYPES = ['terminal', 'api', 'discord', 'telegram', 'psfn-amica'] as const;
const BEHAVIORAL_RESPONSE_STRATEGIES = [
  'empathy',
  'humor',
  'technical',
  'redirect',
  'validation',
  'questioning',
  'direct',
  'supportive',
] as const;

const MAX_CONCERN_TEXT_CHARS = 500;
const MAX_CONCERN_RESOLUTION_CHARS = 400;
const MAX_PENDING_TEXT_CHARS = 500;
const MAX_PENDING_ID_CHARS = 128;
const MAX_PENDING_REASON_CHARS = 240;
const MAX_CONTACT_ID_CHARS = 160;
const MAX_MESSAGE_ID_CHARS = 200;
const MAX_RESPONSE_EXCERPT_CHARS = 240;
const MAX_PROMOTION_MEMORY_ID_CHARS = 128;
const DEFAULT_CONCERN_LIST_LIMIT = 32;
const DEFAULT_PENDING_LIST_LIMIT = 32;
const MAX_LIST_LIMIT = 200;
const DEFAULT_RECENT_RESOLUTION_WINDOW_MS = 6 * 60 * 60 * 1000;
const DEFAULT_RECENT_RESOLUTION_LIMIT = 8;
const DEFAULT_BEHAVIORAL_LIST_LIMIT = 50;
const DEFAULT_BEHAVIORAL_SUMMARY_LIMIT = 4;
const MAX_BEHAVIORAL_SUMMARY_LIMIT = 12;
const DEFAULT_MINIMUM_SAMPLES_FOR_PROMOTION = 3;
const DEFAULT_MINIMUM_AVERAGE_OUTCOME_FOR_PROMOTION = 0.2;
const CONCERN_DUPLICATE_SIMILARITY_THRESHOLD = 0.72;
function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Field "${fieldName}" is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Field "${fieldName}" exceeds max length (${maxChars})`);
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
    throw new Error(`Field "${fieldName}" exceeds max length (${maxChars})`);
  }
  return normalized;
}

function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, 128);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Field "${fieldName}" must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizePriority(value: string): 'high' | 'medium' | 'low' {
  if (!ACTIVE_CONCERN_PRIORITIES.includes(value as (typeof ACTIVE_CONCERN_PRIORITIES)[number])) {
    throw new Error(`Unsupported active concern priority: ${value}`);
  }
  return value as 'high' | 'medium' | 'low';
}

function normalizeSource(value: string): 'appraisal' | 'agent' | 'heartbeat' {
  if (!ACTIVE_CONCERN_SOURCES.includes(value as (typeof ACTIVE_CONCERN_SOURCES)[number])) {
    throw new Error(`Unsupported active concern source: ${value}`);
  }
  return value as 'appraisal' | 'agent' | 'heartbeat';
}

function normalizePendingPriority(value: string): 'low' | 'medium' | 'high' {
  if (!PENDING_FOLLOW_UP_PRIORITIES.includes(value as (typeof PENDING_FOLLOW_UP_PRIORITIES)[number])) {
    throw new Error(`Unsupported pending follow-up priority: ${value}`);
  }
  return value as 'low' | 'medium' | 'high';
}

function normalizeTiming(value: string): 'immediate' | 'soon' | 'scheduled' {
  if (!PENDING_FOLLOW_UP_TIMINGS.includes(value as (typeof PENDING_FOLLOW_UP_TIMINGS)[number])) {
    throw new Error(`Unsupported pending follow-up timing: ${value}`);
  }
  return value as 'immediate' | 'soon' | 'scheduled';
}

function normalizeChannelType(value: string): 'terminal' | 'api' | 'discord' | 'telegram' | 'psfn-amica' {
  if (!CHANNEL_TYPES.includes(value as (typeof CHANNEL_TYPES)[number])) {
    throw new Error(`Unsupported pending follow-up channel type: ${value}`);
  }
  return value as 'terminal' | 'api' | 'discord' | 'telegram' | 'psfn-amica';
}

function normalizeStrategy(value: string): (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number] {
  const normalized = compactWhitespace(value).toLowerCase();
  if (!BEHAVIORAL_RESPONSE_STRATEGIES.includes(normalized as (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number])) {
    throw new Error(`Unsupported behavioral response strategy: ${value}`);
  }
  return normalized as (typeof BEHAVIORAL_RESPONSE_STRATEGIES)[number];
}

function normalizeOutcomeScore(value: number): number {
  if (!Number.isFinite(value)) {
    throw new Error(`Behavioral pattern outcome must be finite, received ${String(value)}`);
  }
  return Math.max(-1, Math.min(1, value));
}

function clampListLimit(limit: number | undefined, fallback: number): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

function clampSummaryLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_BEHAVIORAL_SUMMARY_LIMIT;
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_BEHAVIORAL_SUMMARY_LIMIT);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') return Number(value);
  return Number.NaN;
}

function serializeFormationVAD(value: { valence: number; arousal: number; dominance: number } | undefined): string | null {
  return value ? JSON.stringify(value) : null;
}

function parseFormationVAD(value: unknown): { valence: number; arousal: number; dominance: number } | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const candidate = value as Partial<{ valence: number; arousal: number; dominance: number }>;
  if (
    typeof candidate.valence !== 'number'
    || typeof candidate.arousal !== 'number'
    || typeof candidate.dominance !== 'number'
  ) {
    return undefined;
  }
  return {
    valence: candidate.valence,
    arousal: candidate.arousal,
    dominance: candidate.dominance,
  };
}

function normalizeContactId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function concernSimilarityText(value: string): string {
  return compactWhitespace(value.toLowerCase().replace(/[^a-z0-9]+/g, ' '));
}

function tokenizeConcernSimilarityText(value: string): string[] {
  const normalized = concernSimilarityText(value);
  if (!normalized) return [];
  return Array.from(new Set(normalized.split(' ').filter(token => token.length >= 3)));
}

function scoreConcernSimilarity(left: string, right: string): number {
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

function mapActiveConcernRow(row: ActiveConcernRow): ActiveConcern {
  const resolvedAt = row.resolved_at === null ? undefined : normalizeIsoTimestamp(row.resolved_at, 'resolved_at');
  const resolutionOutcome = row.resolution_outcome === null
    ? undefined
    : normalizeOptionalText(row.resolution_outcome, 'resolution_outcome', MAX_CONCERN_RESOLUTION_CHARS);
  const contactId = row.contact_id === null ? undefined : normalizeContactId(row.contact_id);
  const formationVAD = parseFormationVAD(row.formation_vad);
  return {
    id: row.id,
    text: row.text,
    priority: normalizePriority(row.priority),
    source: normalizeSource(row.source),
    createdAt: normalizeIsoTimestamp(row.created_at, 'created_at'),
    expiresAt: normalizeIsoTimestamp(row.expires_at, 'expires_at'),
    ...(resolvedAt ? { resolvedAt } : {}),
    ...(resolutionOutcome ? { resolutionOutcome } : {}),
    ...(contactId ? { contactId } : {}),
    ...(formationVAD ? { formationVAD } : {}),
  };
}

function mapPendingFollowUpRow(row: PendingFollowUpRow): PendingFollowUp {
  const dueAt = row.due_at === null ? undefined : normalizeIsoTimestamp(row.due_at, 'due_at');
  const contactId = row.contact_id === null ? undefined : normalizeContactId(row.contact_id);
  const sourceMessageId = row.source_message_id === null ? undefined : normalizeContactId(row.source_message_id);
  const activatedAt = row.activated_at === null ? undefined : normalizeIsoTimestamp(row.activated_at, 'activated_at');
  const activationReason = row.activation_reason === null
    ? undefined
    : normalizeOptionalText(row.activation_reason, 'activation_reason', MAX_PENDING_REASON_CHARS);
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
    ...(activatedAt ? { activatedAt } : {}),
    ...(activationReason ? { activationReason } : {}),
  };
}

function mapBehavioralPatternRow(row: BehavioralPatternRow): BehavioralPatternSample {
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

function mapBehavioralStrategySummaryRow(row: BehavioralPatternSummaryRow): BehavioralStrategySummary {
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

function formatSignedOutcome(value: number): string {
  const normalized = normalizeOutcomeScore(value);
  const fixed = normalized.toFixed(2);
  return normalized >= 0 ? `+${fixed}` : fixed;
}

function toProceduralMemoryText(candidate: {
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

class PostgresActiveConcernStore {
  private activeConcernCache = new Map<string, ActiveConcern>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
  ) {}

  snapshotActiveConcerns(contactId?: string): ActiveConcern[] {
    const normalizedContactId = normalizeContactId(contactId);
    const asOfMs = this.now().getTime();
    return [...this.activeConcernCache.values()]
      .filter((concern) => {
        if (concern.resolvedAt) return false;
        if (Date.parse(concern.expiresAt) <= asOfMs) return false;
        if (!normalizedContactId) return true;
        return !concern.contactId || concern.contactId === normalizedContactId;
      })
      .sort((left, right) => (
        Date.parse(left.expiresAt) - Date.parse(right.expiresAt)
        || Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
  }

  async hydrateCache(): Promise<void> {
    const rows = await queryRows<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
      `,
    );
    this.activeConcernCache = new Map(
      rows.map((row) => {
        const concern = mapActiveConcernRow(row);
        return [concern.id, concern] as const;
      }),
    );
  }

  async create(input: ActiveConcernCreateInput): Promise<ActiveConcern> {
    const text = normalizeRequiredText(input.text, 'text', MAX_CONCERN_TEXT_CHARS);
    const priority = normalizePriority(input.priority ?? 'medium');
    const source = normalizeSource(input.source ?? 'agent');
    const createdAt = input.createdAt ? normalizeIsoTimestamp(input.createdAt, 'createdAt') : this.now().toISOString();
    const createdAtMs = Date.parse(createdAt);
    const expiresAt = input.expiresAt
      ? normalizeIsoTimestamp(input.expiresAt, 'expiresAt')
      : new Date(createdAtMs + this.resolveConcernTtlMs(priority)).toISOString();
    if (Date.parse(expiresAt) <= createdAtMs) {
      throw new Error('Active concern expiresAt must be after createdAt');
    }

    const contactId = normalizeContactId(input.contactId);
    const formationVAD = serializeFormationVAD(input.formationVAD);
    const id = normalizeRequiredText(this.idFactory(), 'id', 128);

    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        INSERT INTO active_concerns (
          id, text, priority, source, created_at, expires_at, contact_id, formation_vad
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8
        )
        RETURNING
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
      `,
      [id, text, priority, source, createdAt, expiresAt, contactId ?? null, formationVAD],
    );

    if (!row) {
      throw new Error(`Failed to insert active concern "${id}"`);
    }
    const concern = mapActiveConcernRow(row);
    this.activeConcernCache.set(concern.id, concern);
    return concern;
  }

  async getById(id: string): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
        WHERE id = $1
      `,
      [normalizedId],
    );
    if (!row) return null;
    const concern = mapActiveConcernRow(row);
    this.activeConcernCache.set(concern.id, concern);
    return concern;
  }

  async getActiveConcerns(contactId?: string): Promise<ActiveConcern[]> {
    return await this.list({
      contactId,
      includeResolved: false,
      includeExpired: false,
      asOf: this.now().toISOString(),
    });
  }

  async list(options: ActiveConcernListOptions = {}): Promise<ActiveConcern[]> {
    const asOf = options.asOf ? normalizeIsoTimestamp(options.asOf, 'asOf') : this.now().toISOString();
    const includeResolved = options.includeResolved === true;
    const includeExpired = options.includeExpired === true;
    const normalizedContactId = normalizeContactId(options.contactId);
    const limit = clampListLimit(options.limit, DEFAULT_CONCERN_LIST_LIMIT);
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (!includeResolved) whereClauses.push('resolved_at IS NULL');
    if (!includeExpired) {
      params.push(asOf);
      whereClauses.push(`expires_at > $${params.length}`);
    }
    if (normalizedContactId) {
      params.push(normalizedContactId);
      whereClauses.push(`(contact_id IS NULL OR contact_id = $${params.length})`);
    }
    params.push(limit);

    const rows = await queryRows<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY
          CASE priority
            WHEN 'high' THEN 0
            WHEN 'medium' THEN 1
            ELSE 2
          END ASC,
          expires_at ASC,
          created_at ASC,
          id ASC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(mapActiveConcernRow);
  }

  async listRecentlyResolvedConcerns(
    contactId?: string,
    options: ActiveConcernRecentResolutionOptions = {},
  ): Promise<ActiveConcern[]> {
    const asOf = options.asOf ? normalizeIsoTimestamp(options.asOf, 'asOf') : this.now().toISOString();
    const normalizedContactId = normalizeContactId(contactId);
    const limit = clampListLimit(options.limit ?? DEFAULT_RECENT_RESOLUTION_LIMIT, DEFAULT_RECENT_RESOLUTION_LIMIT);
    const withinMs = normalizeRecentResolutionWindowMs(options.withinMs);
    const resolvedAfter = new Date(Date.parse(asOf) - withinMs).toISOString();
    const params: unknown[] = [resolvedAfter];
    const whereClauses = ['resolved_at IS NOT NULL', 'resolved_at >= $1'];
    if (normalizedContactId) {
      params.push(normalizedContactId);
      whereClauses.push(`(contact_id IS NULL OR contact_id = $${params.length})`);
    }
    params.push(limit);

    const rows = await queryRows<ActiveConcernRow>(
      this.pool,
      `
        SELECT
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
        FROM active_concerns
        WHERE ${whereClauses.join(' AND ')}
        ORDER BY resolved_at DESC, created_at DESC, id DESC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(mapActiveConcernRow);
  }

  async findRecentlyResolvedSimilarConcern(input: {
    text: string;
    contactId?: string;
    withinMs?: number;
    asOf?: string;
  }): Promise<ActiveConcern | null> {
    const text = normalizeRequiredText(input.text, 'text', MAX_CONCERN_TEXT_CHARS);
    const recentResolved = await this.listRecentlyResolvedConcerns(input.contactId, {
      withinMs: input.withinMs,
      asOf: input.asOf,
      limit: DEFAULT_RECENT_RESOLUTION_LIMIT,
    });

    let bestMatch: ActiveConcern | null = null;
    let bestScore = 0;
    for (const concern of recentResolved) {
      const score = scoreConcernSimilarity(text, concern.text);
      if (score < CONCERN_DUPLICATE_SIMILARITY_THRESHOLD || score <= bestScore) continue;
      bestMatch = concern;
      bestScore = score;
    }
    return bestMatch;
  }

  async resolveConcern(id: string, options: ActiveConcernResolveOptions = {}): Promise<ActiveConcern | null> {
    const normalizedId = normalizeRequiredText(id, 'id', 128);
    const outcome = normalizeOptionalText(options.outcome, 'outcome', MAX_CONCERN_RESOLUTION_CHARS);
    const resolvedAt = options.resolvedAt ? normalizeIsoTimestamp(options.resolvedAt, 'resolvedAt') : this.now().toISOString();

    const row = await queryOne<ActiveConcernRow>(
      this.pool,
      `
        UPDATE active_concerns
        SET resolved_at = $2, resolution_outcome = $3
        WHERE id = $1 AND resolved_at IS NULL
        RETURNING
          id, text, priority, source, created_at, expires_at,
          resolved_at, resolution_outcome, contact_id, formation_vad
      `,
      [normalizedId, resolvedAt, outcome ?? null],
    );
    return row ? mapActiveConcernRow(row) : null;
  }

  private resolveConcernTtlMs(priority: 'high' | 'medium' | 'low'): number {
    switch (priority) {
      case 'high':
        return 48 * 60 * 60 * 1000;
      case 'medium':
        return 24 * 60 * 60 * 1000;
      case 'low':
        return 8 * 60 * 60 * 1000;
    }
  }
}

class PostgresPendingFollowUpStore {
  private pendingFollowUpCache = new Map<string, PendingFollowUp>();

  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date,
    private readonly idFactory: () => string,
  ) {}

  snapshotPendingFollowUps(contactId?: string): PendingFollowUp[] {
    const normalizedContactId = normalizeContactId(contactId);
    return [...this.pendingFollowUpCache.values()]
      .filter((followUp) => {
        if (followUp.activatedAt) return false;
        if (!normalizedContactId) return true;
        return !followUp.contactId || followUp.contactId === normalizedContactId;
      })
      .sort((left, right) => (
        Date.parse(left.createdAt) - Date.parse(right.createdAt)
        || left.id.localeCompare(right.id)
      ));
  }

  async hydrateCache(): Promise<void> {
    const rows = await queryRows<PendingFollowUpRow>(
      this.pool,
      `
        SELECT
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
        FROM intention_pending_follow_ups
      `,
    );
    this.pendingFollowUpCache = new Map(
      rows.map((row) => {
        const followUp = mapPendingFollowUpRow(row);
        return [followUp.id, followUp] as const;
      }),
    );
  }

  async create(input: PendingFollowUpCreateInput): Promise<PendingFollowUp> {
    const id = normalizeRequiredText(this.idFactory(), 'id', MAX_PENDING_ID_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_PENDING_TEXT_CHARS);
    const priority = normalizePendingPriority(input.priority);
    const timing = normalizeTiming(input.timing);
    const createdAt = input.createdAt ? normalizeIsoTimestamp(input.createdAt, 'createdAt') : this.now().toISOString();
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_PENDING_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_PENDING_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_PENDING_ID_CHARS);
    const dueAt = input.dueAt ? normalizeIsoTimestamp(input.dueAt, 'dueAt') : undefined;
    const contactId = normalizeContactId(input.contactId);
    const sourceMessageId = normalizeContactId(input.sourceMessageId);

    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        INSERT INTO intention_pending_follow_ups (
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )
        RETURNING
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
      `,
      [
        id,
        content,
        priority,
        timing,
        createdAt,
        channelId,
        channelType,
        authorId,
        authorName,
        dueAt ?? null,
        contactId ?? null,
        sourceMessageId ?? null,
      ],
    );

    if (!row) {
      throw new Error(`Failed to insert pending follow-up "${id}"`);
    }
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }

  async getById(id: string): Promise<PendingFollowUp | null> {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_PENDING_ID_CHARS);
    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        SELECT
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
        FROM intention_pending_follow_ups
        WHERE id = $1
      `,
      [normalizedId],
    );
    if (!row) return null;
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }

  async getPendingFollowUps(contactId?: string): Promise<PendingFollowUp[]> {
    return await this.list({
      contactId,
      includeActivated: false,
    });
  }

  async list(options: PendingFollowUpListOptions = {}): Promise<PendingFollowUp[]> {
    const normalizedContactId = normalizeContactId(options.contactId);
    const includeActivated = options.includeActivated === true;
    const limit = clampListLimit(options.limit, DEFAULT_PENDING_LIST_LIMIT);
    const params: unknown[] = [];
    const whereClauses: string[] = [];

    if (!includeActivated) whereClauses.push('activated_at IS NULL');
    if (normalizedContactId) {
      params.push(normalizedContactId);
      whereClauses.push(`(contact_id IS NULL OR contact_id = $${params.length})`);
    }
    params.push(limit);

    const rows = await queryRows<PendingFollowUpRow>(
      this.pool,
      `
        SELECT
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
        FROM intention_pending_follow_ups
        ${whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : ''}
        ORDER BY created_at ASC, id ASC
        LIMIT $${params.length}
      `,
      params,
    );
    return rows.map(mapPendingFollowUpRow);
  }

  async markActivated(id: string, options: PendingFollowUpActivateOptions = {}): Promise<PendingFollowUp | null> {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_PENDING_ID_CHARS);
    const activatedAt = options.activatedAt ? normalizeIsoTimestamp(options.activatedAt, 'activatedAt') : this.now().toISOString();
    const activationReason = normalizeOptionalText(options.activationReason, 'activationReason', MAX_PENDING_REASON_CHARS);

    const row = await queryOne<PendingFollowUpRow>(
      this.pool,
      `
        UPDATE intention_pending_follow_ups
        SET activated_at = $2, activation_reason = $3
        WHERE id = $1 AND activated_at IS NULL
        RETURNING
          id, content, priority, timing, created_at, channel_id, channel_type,
          author_id, author_name, due_at, contact_id, source_message_id, activated_at, activation_reason
      `,
      [normalizedId, activatedAt, activationReason ?? null],
    );
    if (!row) return null;
    const followUp = mapPendingFollowUpRow(row);
    this.pendingFollowUpCache.set(followUp.id, followUp);
    return followUp;
  }
}

class PostgresBehavioralPatternTracker {
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

function normalizeRecentResolutionWindowMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RECENT_RESOLUTION_WINDOW_MS;
  const floored = Math.floor(value);
  if (floored < 1) {
    throw new Error('Active concern recent resolution window must be a positive number');
  }
  return floored;
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

function createPostgresIntentionRuntimeState(
  pool: Pool,
  options: PostgresIntentionPortOptions = {},
): {
  concernBackend: PostgresActiveConcernStore;
  pendingFollowUpBackend: PostgresPendingFollowUpStore;
  behavioralBackend: PostgresBehavioralPatternTracker;
  ports: PostgresIntentionPorts;
} {
  const now = options.now ?? (() => new Date());
  const idFactory = options.idFactory ?? randomUUID;
  const concernBackend = new PostgresActiveConcernStore(pool, now, idFactory);
  const pendingFollowUpBackend = new PostgresPendingFollowUpStore(pool, now, idFactory);
  const behavioralBackend = new PostgresBehavioralPatternTracker(pool, now, idFactory, {
      promotionHook: options.promotionHook ?? null,
      minimumSamplesForPromotion: options.minimumSamplesForPromotion,
      minimumAverageOutcomeForPromotion: options.minimumAverageOutcomeForPromotion,
    });
  const concernStore = createConcernStorePort(concernBackend);
  const pendingFollowUpStore = createPendingFollowUpStorePort(pendingFollowUpBackend);
  const behavioralPatternTracker = createBehavioralPatternStorePort(behavioralBackend);
  return {
    concernBackend,
    pendingFollowUpBackend,
    behavioralBackend,
    ports: {
    concernProvider: {
      getActiveConcerns: (contactId?: string) => concernBackend.snapshotActiveConcerns(contactId),
    },
    pendingFollowUpProvider: {
      getPendingFollowUps: (contactId?: string) => pendingFollowUpBackend.snapshotPendingFollowUps(contactId),
    },
    behavioralPatternProvider: {
      getBehavioralNotes: (contactId?: string, limit?: number) => (
        behavioralBackend.snapshotBehavioralNotes(contactId, limit)
      ),
    },
    concernStore,
    pendingFollowUpStore,
    behavioralPatternTracker,
    },
  };
}

export function createPostgresIntentionPortsFromPool(
  pool: Pool,
  options: PostgresIntentionPortOptions = {},
): PostgresIntentionPorts {
  return createPostgresIntentionRuntimeState(pool, options).ports;
}

export async function createPostgresIntentionPorts(
  databaseUrl: string,
  options: PostgresIntentionPortOptions = {},
): Promise<PostgresIntentionPorts> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-intention',
    allowExitOnIdle: true,
  });
  await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
  const state = createPostgresIntentionRuntimeState(pool, options);
  await Promise.all([
    state.concernBackend.hydrateCache(),
    state.pendingFollowUpBackend.hydrateCache(),
    state.behavioralBackend.hydrateCache(),
  ]);
  return state.ports;
}
