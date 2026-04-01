import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { CHANNEL_TYPES, type ChannelType } from '../types.js';

export const CARE_REMINDER_KINDS = ['important_date', 'self_reminder'] as const;
export type CareReminderKind = typeof CARE_REMINDER_KINDS[number];

export const CARE_REMINDER_CLASSIFICATIONS = [
  'birthday',
  'anniversary',
  'important_date',
  'check_in',
  'self_note',
] as const;
export type CareReminderClassification = typeof CARE_REMINDER_CLASSIFICATIONS[number];

export const CARE_REMINDER_SCHEDULES = ['one_time', 'annual'] as const;
export type CareReminderSchedule = typeof CARE_REMINDER_SCHEDULES[number];

export const CARE_REMINDER_STATUSES = ['active', 'completed', 'dismissed'] as const;
export type CareReminderStatus = typeof CARE_REMINDER_STATUSES[number];

export const CARE_REMINDER_PROVENANCE_SOURCES = ['companion_appraisal', 'operator'] as const;
export type CareReminderProvenanceSource = typeof CARE_REMINDER_PROVENANCE_SOURCES[number];

export interface CareReminder {
  id: string;
  kind: CareReminderKind;
  classification: CareReminderClassification;
  title: string;
  content: string;
  schedule: CareReminderSchedule;
  status: CareReminderStatus;
  dueAt: string;
  createdAt: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  provenanceSource: CareReminderProvenanceSource;
  provenanceReason: string;
  contactId?: string;
  sourceMessageId?: string;
  lastActivatedAt?: string;
  activationCount: number;
  completedAt?: string;
}

export interface CareReminderCreateInput {
  kind: CareReminderKind;
  classification: CareReminderClassification;
  title: string;
  content: string;
  schedule: CareReminderSchedule;
  dueAt: string;
  channelId: string;
  channelType: ChannelType;
  authorId: string;
  authorName: string;
  provenanceSource: CareReminderProvenanceSource;
  provenanceReason: string;
  createdAt?: string;
  contactId?: string;
  sourceMessageId?: string;
}

export interface CareReminderListOptions {
  contactId?: string;
  includeCompleted?: boolean;
  includeDismissed?: boolean;
  limit?: number;
}

export interface CareReminderActivationOptions {
  activatedAt?: string;
}

export interface CareReminderStoreOptions {
  now?: () => Date;
  idFactory?: () => string;
}

export interface CareReminderContextProvider {
  getActiveCareReminders(contactId?: string): CareReminder[];
}

interface CareReminderRow {
  id: string;
  kind: string;
  classification: string;
  title: string;
  content: string;
  schedule: string;
  status: string;
  due_at: string;
  created_at: string;
  channel_id: string;
  channel_type: string;
  author_id: string;
  author_name: string;
  provenance_source: string;
  provenance_reason: string;
  contact_id: string | null;
  source_message_id: string | null;
  last_activated_at: string | null;
  activation_count: number;
  completed_at: string | null;
}

const MAX_TEXT_CHARS = 500;
const MAX_TITLE_CHARS = 160;
const MAX_ID_CHARS = 128;
const DEFAULT_LIST_LIMIT = 64;
const MAX_LIST_LIMIT = 200;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Care reminder ${fieldName} is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Care reminder ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, MAX_ID_CHARS);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Care reminder ${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

function normalizeKind(value: string): CareReminderKind {
  if (!CARE_REMINDER_KINDS.includes(value as CareReminderKind)) {
    throw new Error(`Unsupported care reminder kind: ${String(value)}`);
  }
  return value as CareReminderKind;
}

function normalizeClassification(value: string): CareReminderClassification {
  if (!CARE_REMINDER_CLASSIFICATIONS.includes(value as CareReminderClassification)) {
    throw new Error(`Unsupported care reminder classification: ${String(value)}`);
  }
  return value as CareReminderClassification;
}

function normalizeSchedule(value: string): CareReminderSchedule {
  if (!CARE_REMINDER_SCHEDULES.includes(value as CareReminderSchedule)) {
    throw new Error(`Unsupported care reminder schedule: ${String(value)}`);
  }
  return value as CareReminderSchedule;
}

function normalizeStatus(value: string): CareReminderStatus {
  if (!CARE_REMINDER_STATUSES.includes(value as CareReminderStatus)) {
    throw new Error(`Unsupported care reminder status: ${String(value)}`);
  }
  return value as CareReminderStatus;
}

function normalizeChannelType(value: string): ChannelType {
  if (!CHANNEL_TYPES.includes(value as ChannelType)) {
    throw new Error(`Unsupported care reminder channel type: ${String(value)}`);
  }
  return value as ChannelType;
}

function normalizeProvenanceSource(value: string): CareReminderProvenanceSource {
  if (!CARE_REMINDER_PROVENANCE_SOURCES.includes(value as CareReminderProvenanceSource)) {
    throw new Error(`Unsupported care reminder provenance source: ${String(value)}`);
  }
  return value as CareReminderProvenanceSource;
}

function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

function compareCareReminders(left: CareReminder, right: CareReminder): number {
  const dueDelta = Date.parse(left.dueAt) - Date.parse(right.dueAt);
  if (dueDelta !== 0) return dueDelta;
  const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
}

function mapRow(row: CareReminderRow): CareReminder {
  const contactId = row.contact_id === null ? undefined : normalizeOptionalId(row.contact_id);
  const sourceMessageId = row.source_message_id === null ? undefined : normalizeOptionalId(row.source_message_id);
  const lastActivatedAt = row.last_activated_at === null
    ? undefined
    : normalizeIsoTimestamp(row.last_activated_at, 'last_activated_at');
  const completedAt = row.completed_at === null
    ? undefined
    : normalizeIsoTimestamp(row.completed_at, 'completed_at');

  return {
    id: normalizeRequiredText(row.id, 'id', MAX_ID_CHARS),
    kind: normalizeKind(row.kind),
    classification: normalizeClassification(row.classification),
    title: normalizeRequiredText(row.title, 'title', MAX_TITLE_CHARS),
    content: normalizeRequiredText(row.content, 'content', MAX_TEXT_CHARS),
    schedule: normalizeSchedule(row.schedule),
    status: normalizeStatus(row.status),
    dueAt: normalizeIsoTimestamp(row.due_at, 'due_at'),
    createdAt: normalizeIsoTimestamp(row.created_at, 'created_at'),
    channelId: normalizeRequiredText(row.channel_id, 'channel_id', MAX_ID_CHARS),
    channelType: normalizeChannelType(row.channel_type),
    authorId: normalizeRequiredText(row.author_id, 'author_id', MAX_ID_CHARS),
    authorName: normalizeRequiredText(row.author_name, 'author_name', MAX_ID_CHARS),
    provenanceSource: normalizeProvenanceSource(row.provenance_source),
    provenanceReason: normalizeRequiredText(row.provenance_reason, 'provenance_reason', MAX_TEXT_CHARS),
    activationCount: Math.max(0, Math.floor(row.activation_count)),
    ...(contactId ? { contactId } : {}),
    ...(sourceMessageId ? { sourceMessageId } : {}),
    ...(lastActivatedAt ? { lastActivatedAt } : {}),
    ...(completedAt ? { completedAt } : {}),
  };
}

function advanceYear(isoTimestamp: string, nowIso: string): string {
  const next = new Date(isoTimestamp);
  const now = Date.parse(nowIso);
  while (next.getTime() <= now) {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  }
  return next.toISOString();
}

export class CareReminderStore implements CareReminderContextProvider {
  private readonly db: Database.Database;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(db: Database.Database, options: CareReminderStoreOptions = {}) {
    this.db = db;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.initializeSchema();
  }

  create(input: CareReminderCreateInput): CareReminder {
    const id = normalizeRequiredText(this.idFactory(), 'id', MAX_ID_CHARS);
    const kind = normalizeKind(input.kind);
    const classification = normalizeClassification(input.classification);
    const title = normalizeRequiredText(input.title, 'title', MAX_TITLE_CHARS);
    const content = normalizeRequiredText(input.content, 'content', MAX_TEXT_CHARS);
    const schedule = normalizeSchedule(input.schedule);
    const dueAt = normalizeIsoTimestamp(input.dueAt, 'dueAt');
    const createdAt = input.createdAt
      ? normalizeIsoTimestamp(input.createdAt, 'createdAt')
      : this.now().toISOString();
    const channelId = normalizeRequiredText(input.channelId, 'channelId', MAX_ID_CHARS);
    const channelType = normalizeChannelType(input.channelType);
    const authorId = normalizeRequiredText(input.authorId, 'authorId', MAX_ID_CHARS);
    const authorName = normalizeRequiredText(input.authorName, 'authorName', MAX_ID_CHARS);
    const provenanceSource = normalizeProvenanceSource(input.provenanceSource);
    const provenanceReason = normalizeRequiredText(input.provenanceReason, 'provenanceReason', MAX_TEXT_CHARS);
    const contactId = normalizeOptionalId(input.contactId);
    const sourceMessageId = normalizeOptionalId(input.sourceMessageId);

    this.db.prepare(`
      INSERT INTO intention_care_reminders (
        id,
        kind,
        classification,
        title,
        content,
        schedule,
        status,
        due_at,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        provenance_source,
        provenance_reason,
        contact_id,
        source_message_id,
        activation_count
      ) VALUES (
        @id,
        @kind,
        @classification,
        @title,
        @content,
        @schedule,
        'active',
        @due_at,
        @created_at,
        @channel_id,
        @channel_type,
        @author_id,
        @author_name,
        @provenance_source,
        @provenance_reason,
        @contact_id,
        @source_message_id,
        0
      )
    `).run({
      id,
      kind,
      classification,
      title,
      content,
      schedule,
      due_at: dueAt,
      created_at: createdAt,
      channel_id: channelId,
      channel_type: channelType,
      author_id: authorId,
      author_name: authorName,
      provenance_source: provenanceSource,
      provenance_reason: provenanceReason,
      contact_id: contactId ?? null,
      source_message_id: sourceMessageId ?? null,
    });

    return this.requireById(id);
  }

  getById(id: string): CareReminder | null {
    const normalizedId = normalizeRequiredText(id, 'id', MAX_ID_CHARS);
    const row = this.db.prepare(`
      SELECT
        id,
        kind,
        classification,
        title,
        content,
        schedule,
        status,
        due_at,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        provenance_source,
        provenance_reason,
        contact_id,
        source_message_id,
        last_activated_at,
        activation_count,
        completed_at
      FROM intention_care_reminders
      WHERE id = @id
      LIMIT 1
    `).get({ id: normalizedId }) as CareReminderRow | undefined;

    return row ? mapRow(row) : null;
  }

  getActiveCareReminders(contactId?: string): CareReminder[] {
    return this.list({
      ...(contactId ? { contactId } : {}),
      includeCompleted: false,
      includeDismissed: false,
    });
  }

  list(options: CareReminderListOptions = {}): CareReminder[] {
    const clauses = ['status != \'completed\''];
    if (options.includeCompleted) {
      clauses.length = 0;
    }
    if (!options.includeDismissed) {
      clauses.push('status != \'dismissed\'');
    }
    const normalizedContactId = normalizeOptionalId(options.contactId);
    if (normalizedContactId) {
      clauses.push('contact_id = @contact_id');
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`
      SELECT
        id,
        kind,
        classification,
        title,
        content,
        schedule,
        status,
        due_at,
        created_at,
        channel_id,
        channel_type,
        author_id,
        author_name,
        provenance_source,
        provenance_reason,
        contact_id,
        source_message_id,
        last_activated_at,
        activation_count,
        completed_at
      FROM intention_care_reminders
      ${where}
      ORDER BY due_at ASC, created_at ASC, id ASC
      LIMIT @limit
    `).all({
      contact_id: normalizedContactId ?? null,
      limit: clampListLimit(options.limit),
    }) as CareReminderRow[];

    return rows.map(mapRow).sort(compareCareReminders);
  }

  markTriggered(id: string, options: CareReminderActivationOptions = {}): CareReminder | null {
    const reminder = this.getById(id);
    if (!reminder || reminder.status !== 'active') {
      return reminder;
    }

    const activatedAt = options.activatedAt
      ? normalizeIsoTimestamp(options.activatedAt, 'activatedAt')
      : this.now().toISOString();
    const activationCount = reminder.activationCount + 1;

    if (reminder.schedule === 'annual') {
      const nextDueAt = advanceYear(reminder.dueAt, activatedAt);
      this.db.prepare(`
        UPDATE intention_care_reminders
        SET
          due_at = @due_at,
          last_activated_at = @last_activated_at,
          activation_count = @activation_count
        WHERE id = @id
      `).run({
        id: reminder.id,
        due_at: nextDueAt,
        last_activated_at: activatedAt,
        activation_count: activationCount,
      });
      return this.requireById(reminder.id);
    }

    this.db.prepare(`
      UPDATE intention_care_reminders
      SET
        status = 'completed',
        completed_at = @completed_at,
        last_activated_at = @last_activated_at,
        activation_count = @activation_count
      WHERE id = @id
    `).run({
      id: reminder.id,
      completed_at: activatedAt,
      last_activated_at: activatedAt,
      activation_count: activationCount,
    });
    return this.requireById(reminder.id);
  }

  private requireById(id: string): CareReminder {
    const reminder = this.getById(id);
    if (!reminder) {
      throw new Error(`Failed to load care reminder "${id}" after write`);
    }
    return reminder;
  }

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS intention_care_reminders (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        classification TEXT NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        schedule TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        channel_type TEXT NOT NULL,
        author_id TEXT NOT NULL,
        author_name TEXT NOT NULL,
        provenance_source TEXT NOT NULL,
        provenance_reason TEXT NOT NULL,
        contact_id TEXT,
        source_message_id TEXT,
        last_activated_at TEXT,
        activation_count INTEGER NOT NULL DEFAULT 0,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_intention_care_reminders_due_at
        ON intention_care_reminders(due_at);
      CREATE INDEX IF NOT EXISTS idx_intention_care_reminders_contact_status
        ON intention_care_reminders(contact_id, status, due_at);
    `);
  }
}
