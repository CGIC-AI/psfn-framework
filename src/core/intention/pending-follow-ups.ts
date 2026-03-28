import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';

export const PENDING_FOLLOW_UP_PRIORITIES = ['low', 'medium', 'high'] as const;
export type PendingFollowUpPriority = typeof PENDING_FOLLOW_UP_PRIORITIES[number];

export const PENDING_FOLLOW_UP_TIMINGS = ['immediate', 'soon', 'scheduled'] as const;
export type PendingFollowUpTiming = typeof PENDING_FOLLOW_UP_TIMINGS[number];

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

const MAX_TEXT_CHARS = 500;
const MAX_ID_CHARS = 128;
const MAX_REASON_CHARS = 240;
const DEFAULT_LIST_LIMIT = 32;
const MAX_LIST_LIMIT = 200;

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
    ...(activatedAt ? { activatedAt } : {}),
    ...(activationReason ? { activationReason } : {}),
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

    this.db.prepare(`
      INSERT INTO intention_pending_follow_ups (
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
        source_message_id
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
        @source_message_id
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
    });

    return this.requireById(id);
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
        activated_at,
        activation_reason
      FROM intention_pending_follow_ups
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
        activated_at,
        activation_reason
      FROM intention_pending_follow_ups
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
      UPDATE intention_pending_follow_ups
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
      CREATE TABLE IF NOT EXISTS intention_pending_follow_ups (
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
        activated_at TEXT,
        activation_reason TEXT,
        CHECK (priority IN ('low', 'medium', 'high')),
        CHECK (timing IN ('immediate', 'soon', 'scheduled')),
        CHECK (channel_type IN ('terminal', 'api', 'discord', 'telegram', 'psfn-amica'))
      );

      CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_active
      ON intention_pending_follow_ups (activated_at, created_at, id);

      CREATE INDEX IF NOT EXISTS idx_intention_pending_follow_ups_contact
      ON intention_pending_follow_ups (contact_id, activated_at, created_at, id);
    `);
  }
}
