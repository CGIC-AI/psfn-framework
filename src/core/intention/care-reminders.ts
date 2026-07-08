import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';

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

export interface CareReminderStorePort extends CareReminderContextProvider {
  create(input: CareReminderCreateInput): CareReminder;
  getById(id: string): CareReminder | null;
  list(options?: CareReminderListOptions): CareReminder[];
  markTriggered(id: string, options?: CareReminderActivationOptions): CareReminder | null;
}

export interface CareReminderRow {
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

export const MAX_TEXT_CHARS = 500;
export const MAX_TITLE_CHARS = 160;
export const MAX_ID_CHARS = 128;
const DEFAULT_LIST_LIMIT = 64;
const MAX_LIST_LIMIT = 200;

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeRequiredText(value: string, fieldName: string, maxChars: number): string {
  const normalized = compactWhitespace(value);
  if (!normalized) {
    throw new Error(`Care reminder ${fieldName} is required`);
  }
  if (normalized.length > maxChars) {
    throw new Error(`Care reminder ${fieldName} exceeds max length (${maxChars})`);
  }
  return normalized;
}

export function normalizeOptionalId(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = compactWhitespace(value);
  return normalized.length > 0 ? normalized : undefined;
}

export function normalizeIsoTimestamp(value: string, fieldName: string): string {
  const normalized = normalizeRequiredText(value, fieldName, MAX_ID_CHARS);
  const parsed = Date.parse(normalized);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Care reminder ${fieldName} must be a valid ISO timestamp`);
  }
  return new Date(parsed).toISOString();
}

export function normalizeKind(value: string): CareReminderKind {
  if (!CARE_REMINDER_KINDS.includes(value as CareReminderKind)) {
    throw new Error(`Unsupported care reminder kind: ${String(value)}`);
  }
  return value as CareReminderKind;
}

export function normalizeClassification(value: string): CareReminderClassification {
  if (!CARE_REMINDER_CLASSIFICATIONS.includes(value as CareReminderClassification)) {
    throw new Error(`Unsupported care reminder classification: ${String(value)}`);
  }
  return value as CareReminderClassification;
}

export function normalizeSchedule(value: string): CareReminderSchedule {
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

export function normalizeChannelType(value: string): ChannelType {
  if (!CHANNEL_TYPES.includes(value as ChannelType)) {
    throw new Error(`Unsupported care reminder channel type: ${String(value)}`);
  }
  return value as ChannelType;
}

export function normalizeProvenanceSource(value: string): CareReminderProvenanceSource {
  if (!CARE_REMINDER_PROVENANCE_SOURCES.includes(value as CareReminderProvenanceSource)) {
    throw new Error(`Unsupported care reminder provenance source: ${String(value)}`);
  }
  return value as CareReminderProvenanceSource;
}

export function clampListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return DEFAULT_LIST_LIMIT;
  }
  const floored = Math.floor(limit);
  if (floored < 1) return 1;
  return Math.min(floored, MAX_LIST_LIMIT);
}

export function compareCareReminders(left: CareReminder, right: CareReminder): number {
  const dueDelta = Date.parse(left.dueAt) - Date.parse(right.dueAt);
  if (dueDelta !== 0) return dueDelta;
  const createdDelta = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (createdDelta !== 0) return createdDelta;
  return left.id.localeCompare(right.id);
}

export function mapRow(row: CareReminderRow): CareReminder {
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

export function advanceYear(isoTimestamp: string, nowIso: string): string {
  const next = new Date(isoTimestamp);
  const now = Date.parse(nowIso);
  next.setUTCFullYear(next.getUTCFullYear() + 1);
  while (next.getTime() <= now) {
    next.setUTCFullYear(next.getUTCFullYear() + 1);
  }
  return next.toISOString();
}

