import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';

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
  limit?: number;
}

export interface PendingFollowUpStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export interface PendingFollowUpContextProvider {
  getPendingFollowUps(contactId?: string): PendingFollowUp[];
}

type Awaitable<T> = T | Promise<T>;

interface PendingFollowUpStorePortBackend extends PendingFollowUpContextProvider {
  create(input: PendingFollowUpCreateInput): Awaitable<PendingFollowUp>;
  getById(id: string): Awaitable<PendingFollowUp | null>;
  list(options?: PendingFollowUpListOptions): Awaitable<PendingFollowUp[]>;
  markActivated(
    id: string,
    options?: PendingFollowUpActivateOptions,
  ): Awaitable<PendingFollowUp | null>;
}

export interface PendingFollowUpStorePort {
  create(input: PendingFollowUpCreateInput): Promise<PendingFollowUp>;
  getById(id: string): Promise<PendingFollowUp | null>;
  getPendingFollowUps(contactId?: string): Promise<PendingFollowUp[]>;
  list(options?: PendingFollowUpListOptions): Promise<PendingFollowUp[]>;
  markActivated(
    id: string,
    options?: PendingFollowUpActivateOptions,
  ): Promise<PendingFollowUp | null>;
}

export function createPendingFollowUpStorePort(
  store: PendingFollowUpStorePortBackend,
): PendingFollowUpStorePort {
  return {
    create: async (input) => await store.create(input),
    getById: async (id) => await store.getById(id),
    getPendingFollowUps: async (contactId) => await store.getPendingFollowUps(contactId),
    list: async (options) => await store.list(options),
    markActivated: async (id, options) => await store.markActivated(id, options),
  };
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
  context_summary: string | null;
  wake_conditions: string | null;
  activated_at: string | null;
  activation_reason: string | null;
}

const MAX_TEXT_CHARS = 500;
const MAX_ID_CHARS = 128;
const MAX_SUMMARY_CHARS = 320;
const MAX_REASON_CHARS = 240;
const DEFAULT_LIST_LIMIT = 32;
const MAX_LIST_LIMIT = 200;
const NEGATIVE_MOOD_WAKE_THRESHOLD = -0.2;
const PENDING_FOLLOW_UPS_TABLE = 'intention_pending_follow_ups';

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Pending follow-up ${fieldName} is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Pending follow-up ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

function normalizeOptionalText(
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

function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, 128);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Pending follow-up ${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizePriority(value: string): PendingFollowUpPriority {
  if (!PENDING_FOLLOW_UP_PRIORITIES.includes(value as PendingFollowUpPriority)) {
    throw new Error(`Unsupported pending follow-up priority: ${String(value)}`);
  }
  return value as PendingFollowUpPriority;
}

function normalizeTiming(value: string): PendingFollowUpTiming {
  if (!PENDING_FOLLOW_UP_TIMINGS.includes(value as PendingFollowUpTiming)) {
    throw new Error(`Unsupported pending follow-up timing: ${String(value)}`);
  }
  return value as PendingFollowUpTiming;
}

function normalizeChannelType(value: string): ChannelType {
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

function normalizeWakeConditions(
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

function encodeWakeConditions(
  value: readonly PendingFollowUpWakeCondition[] | undefined,
): string | null {
  const normalized = normalizeWakeConditions(value);
  return normalized ? JSON.stringify(normalized) : null;
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

function mapRow(row: PendingFollowUpRow): PendingFollowUp {
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

export function hasStateWakeConditions(followUp: Pick<PendingFollowUp, 'wakeConditions'>): boolean {
  return Array.isArray(followUp.wakeConditions) && followUp.wakeConditions.length > 0;
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

export class PendingFollowUpStore implements PendingFollowUpContextProvider {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(db: Database.Database, options: PendingFollowUpStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.initializeSchema();
  }

  create(input: PendingFollowUpCreateInput): PendingFollowUp {
    const id = normalizeRequiredText(this.idFactory(), 'id', MAX_ID_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_TEXT_CHARS);
    const priority = normalizePriority(input.priority);
    const timing = normalizeTiming(input.timing);
    const createdAt = input.createdAt
      ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
      : this.now().toISOString();
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_ID_CHARS);
    const dueAt = input.dueAt ? normalizeIsoTimestamp(input.dueAt, 'dueAt') : undefined;
    const contactId = normalizeOptionalId(input.contactId);
    const sourceMessageId = normalizeOptionalId(input.sourceMessageId);
    const contextSummary = normalizeOptionalText(
      input.contextSummary,
      'contextSummary',
      MAX_SUMMARY_CHARS,
    );
    const wakeConditions = normalizeWakeConditions(input.wakeConditions);

    this.db.prepare(`
      INSERT INTO ${PENDING_FOLLOW_UPS_TABLE} (
        id,
        content,
        priority,
        timing,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        due_at,
        contact_id,
        source_message_id,
        context_summary,
        wake_conditions
      ) VALUES (
        @id,
        @content,
        @priority,
        @timing,
        @created_at,
        @channel_id,
        @channel_type,
        @author_id,
        @author_name,
        @due_at,
        @contact_id,
        @source_message_id,
        @context_summary,
        @wake_conditions
      )
    `).run({
      id,
      content,
      priority,
      timing,
      created_at: createdAt,
      channel_id: channelId,
      channel_type: channelType,
      author_id: authorId,
      author_name: authorName,
      due_at: dueAt ?? null,
      contact_id: contactId ?? null,
      source_message_id: sourceMessageId ?? null,
      context_summary: contextSummary ?? null,
      wake_conditions: encodeWakeConditions(wakeConditions),
    });

    return this.requireById(id);
  }

  update(id: string, input: PendingFollowUpUpdateInput): PendingFollowUp | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_TEXT_CHARS);
    const priority = normalizePriority(input.priority);
    const timing = normalizeTiming(input.timing);
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_ID_CHARS);
    const dueAt = input.dueAt ? normalizeIsoTimestamp(input.dueAt, 'dueAt') : undefined;
    const contactId = normalizeOptionalId(input.contactId);
    const sourceMessageId = normalizeOptionalId(input.sourceMessageId);
    const contextSummary = normalizeOptionalText(
      input.contextSummary,
      'contextSummary',
      MAX_SUMMARY_CHARS,
    );
    const wakeConditions = normalizeWakeConditions(input.wakeConditions);

    const result = this.db.prepare(`
      UPDATE ${PENDING_FOLLOW_UPS_TABLE}
      SET
        content = @content,
        priority = @priority,
        timing = @timing,
        channel_id = @channel_id,
        channel_type = @channel_type,
        author_id = @author_id,
        author_name = @author_name,
        due_at = @due_at,
        contact_id = @contact_id,
        source_message_id = @source_message_id,
        context_summary = @context_summary,
        wake_conditions = @wake_conditions
      WHERE
        id = @id
        AND activated_at IS NULL
    `).run({
      id: normalizedId,
      content,
      priority,
      timing,
      channel_id: channelId,
      channel_type: channelType,
      author_id: authorId,
      author_name: authorName,
      due_at: dueAt ?? null,
      contact_id: contactId ?? null,
      source_message_id: sourceMessageId ?? null,
      context_summary: contextSummary ?? null,
      wake_conditions: encodeWakeConditions(wakeConditions),
    });

    if (result.changes === 0) {
      return null;
    }
    return this.requireById(normalizedId);
  }

  getById(id: string): PendingFollowUp | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const row = this.db.prepare(`
      SELECT
        id,
        content,
        priority,
        timing,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        due_at,
        contact_id,
        source_message_id,
        context_summary,
        wake_conditions,
        activated_at,
        activation_reason
      FROM ${PENDING_FOLLOW_UPS_TABLE}
      WHERE id = @id
    `).get({ id: normalizedId }) as PendingFollowUpRow | undefined;
    return row ? mapRow(row) : null;
  }

  getPendingFollowUps(contactId?: string): PendingFollowUp[] {
    return this.list({
      contactId,
      includeActivated: false,
    });
  }

  list(options: PendingFollowUpListOptions = {}): PendingFollowUp[] {
    const normalizedContactId = normalizeOptionalId(options.contactId);
    const limit = clampListLimit(options.limit);
    const whereClauses: string[] = [];
    if (options.includeActivated !== true) {
      whereClauses.push('activated_at IS NULL');
    }
    if (normalizedContactId) {
      whereClauses.push('(contact_id IS NULL OR contact_id = @contactId)');
    }
    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    const rows = this.db.prepare(`
      SELECT
        id,
        content,
        priority,
        timing,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        due_at,
        contact_id,
        source_message_id,
        context_summary,
        wake_conditions,
        activated_at,
        activation_reason
      FROM ${PENDING_FOLLOW_UPS_TABLE}
      ${whereSql}
      ORDER BY
        created_at ASC,
        id ASC
      LIMIT @limit
    `).all({
      contactId: normalizedContactId ?? null,
      limit,
    }) as PendingFollowUpRow[];

    return rows.map(mapRow);
  }

  markActivated(id: string, options: PendingFollowUpActivateOptions = {}): PendingFollowUp | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const activatedAt = options.activatedAt
      ? normalizeIsoTimestamp(options.activatedAt, 'activatedAt')
      : this.now().toISOString();
    const activationReason = normalizeOptionalText(
      options.activationReason,
      'activationReason',
      MAX_REASON_CHARS,
    );

    const result = this.db.prepare(`
      UPDATE ${PENDING_FOLLOW_UPS_TABLE}
      SET
        activated_at = @activated_at,
        activation_reason = @activation_reason
      WHERE
        id = @id
        AND activated_at IS NULL
    `).run({
      id: normalizedId,
      activated_at: activatedAt,
      activation_reason: activationReason ?? null,
    });

    if (result.changes === 0) {
      return null;
    }
    return this.requireById(normalizedId);
  }

  private requireById(id: string): PendingFollowUp {
    const record = this.getById(id);
    if (!record) {
      throw new Error(`Failed to load pending follow-up "${id}" after write`);
    }
    return record;
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${PENDING_FOLLOW_UPS_TABLE} (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        priority TEXT NOT NULL,
        timing TEXT NOT NULL,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        due_at TEXT,
        contact_id TEXT,
        source_message_id TEXT,
        context_summary TEXT,
        wake_conditions TEXT,
        activated_at TEXT,
        activation_reason TEXT,
        CHECK (priority IN ('low', 'medium', 'high')),
        CHECK (timing IN ('immediate', 'soon', 'scheduled')),
        CHECK (channel_type IN ('terminal', 'api', 'discord', 'telegram', 'psfn-amica'))
      );

      CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_active
      ON ${PENDING_FOLLOW_UPS_TABLE} (activated_at, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_contact
      ON ${PENDING_FOLLOW_UPS_TABLE} (contact_id, activated_at, created_at, id);
    `);
    this.ensureColumn('context_summary', 'TEXT');
    this.ensureColumn('wake_conditions', 'TEXT');
  }

  private ensureColumn(columnName: string, columnDefinition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${PENDING_FOLLOW_UPS_TABLE})`).all() as Array<{
      name?: string;
    }>;
    if (columns.some(column => column.name === columnName)) {
      return;
    }
    this.db.exec(`ALTER TABLE ${PENDING_FOLLOW_UPS_TABLE} ADD COLUMN ${columnName} ${columnDefinition}`);
  }
}
