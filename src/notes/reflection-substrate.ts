import { join } from 'node:path';
import { createComponentLogger } from '../logger.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { sanitizeChannelId } from '../session/store-primitives.js';
import type { ValuesDeliberationMetadata } from '../values/store.js';

const log = createComponentLogger('ReflectionSubstrate');
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export type ReflectionExecutionSource =
  | 'manual'
  | 'scheduled'
  | 'deferred_scheduler'
  | 'deferred_post_turn';

export type ReflectionDailyJournalSource = 'heartbeat_template';
export type ReflectionProcessType = 'reflection_deliberation';
export type ReflectionProcessStage = 'started' | 'completed' | 'failed';

interface ReflectionSubstrateStoreOptions {
  now?: () => number;
}

export interface ReflectionDailyJournalAppendInput {
  source: ReflectionDailyJournalSource;
  executionSource: ReflectionExecutionSource;
  reflection: string;
  createdAt?: string;
  date?: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  mode?: 'agent' | 'deliberation';
  reflectionJournalEntryId?: string;
  processId?: string;
  tags?: string[];
}

export interface ReflectionDailyJournalEntry {
  id: string;
  kind: 'daily_journal_entry';
  source: ReflectionDailyJournalSource;
  executionSource: ReflectionExecutionSource;
  reflection: string;
  createdAt: string;
  date: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  mode?: 'agent' | 'deliberation';
  reflectionJournalEntryId?: string;
  processId?: string;
  tags?: string[];
}

export interface ReflectionProcessLogAppendInput {
  processId: string;
  processLabel: string;
  processType: ReflectionProcessType;
  stage: ReflectionProcessStage;
  executionSource: ReflectionExecutionSource;
  createdAt?: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  reflection?: string;
  error?: string;
  tags?: string[];
  deliberation?: ValuesDeliberationMetadata;
}

export interface ReflectionProcessLogEntry {
  id: string;
  kind: 'process_log_entry';
  processId: string;
  processLabel: string;
  processType: ReflectionProcessType;
  stage: ReflectionProcessStage;
  executionSource: ReflectionExecutionSource;
  createdAt: string;
  templateId?: string;
  templateName?: string;
  channelId?: string;
  prompt?: string;
  reflection?: string;
  error?: string;
  tags?: string[];
  deliberation?: ValuesDeliberationMetadata;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeOptionalString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  return normalizeRequiredString(value, fieldName);
}

function normalizeIsoDate(value: unknown, fieldName: string): string {
  const normalized = normalizeRequiredString(value, fieldName);
  if (!ISO_DATE_PATTERN.test(normalized)) {
    throw new Error(`${fieldName} must match YYYY-MM-DD`);
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new Error(`${fieldName} must be a valid ISO date`);
  }
  return normalized;
}

function normalizeCreatedAt(value: unknown, now: () => number): string {
  if (value === undefined || value === null) {
    return new Date(now()).toISOString();
  }
  const normalized = normalizeRequiredString(value, 'createdAt');
  if (Number.isNaN(Date.parse(normalized))) {
    throw new Error('createdAt must be an ISO-8601 timestamp');
  }
  return normalized;
}

function normalizeTags(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error('tags must be an array when provided');
  }
  const normalized = [...new Set(value.map((tag, index) => normalizeRequiredString(tag, `tags[${String(index)}]`)))];
  return normalized.length > 0 ? normalized : undefined;
}

function normalizeDeliberationMetadata(raw: unknown): ValuesDeliberationMetadata | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object') {
    throw new Error('deliberation must be an object when provided');
  }
  const candidate = raw as Partial<ValuesDeliberationMetadata>;
  if (typeof candidate.sessionId !== 'string' || candidate.sessionId.trim().length === 0) {
    throw new Error('deliberation.sessionId must be a non-empty string');
  }
  if (typeof candidate.stopReason !== 'string' || candidate.stopReason.trim().length === 0) {
    throw new Error('deliberation.stopReason must be a non-empty string');
  }
  const numericFields: Array<keyof Pick<
    ValuesDeliberationMetadata,
    'rounds' | 'totalInputTokens' | 'totalOutputTokens' | 'totalTokens' | 'estimatedCostUsd' | 'durationMs'
  >> = [
    'rounds',
    'totalInputTokens',
    'totalOutputTokens',
    'totalTokens',
    'estimatedCostUsd',
    'durationMs',
  ];
  for (const fieldName of numericFields) {
    const value = candidate[fieldName];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new Error(`deliberation.${fieldName} must be a finite number >= 0`);
    }
  }
  return {
    sessionId: candidate.sessionId.trim(),
    stopReason: candidate.stopReason.trim(),
    rounds: Math.floor(candidate.rounds),
    totalInputTokens: candidate.totalInputTokens,
    totalOutputTokens: candidate.totalOutputTokens,
    totalTokens: candidate.totalTokens,
    estimatedCostUsd: candidate.estimatedCostUsd,
    durationMs: candidate.durationMs,
  };
}

function buildEntryId(prefix: string, now: () => number): string {
  return `${prefix}-${now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

export function buildReflectionProcessId(processLabel: string, now: () => number = Date.now): string {
  const slug = sanitizeChannelId(normalizeRequiredString(processLabel, 'processLabel').toLowerCase());
  return `reflection-process-${slug}-${now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

export class ReflectionDailyJournalStore {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(rootDir: string, options: ReflectionSubstrateStoreOptions = {}) {
    this.rootDir = rootDir;
    this.now = options.now ?? Date.now;
  }

  append(input: ReflectionDailyJournalAppendInput): ReflectionDailyJournalEntry {
    const createdAt = normalizeCreatedAt(input.createdAt, this.now);
    const date = normalizeIsoDate(input.date ?? createdAt.slice(0, 10), 'date');
    const entry: ReflectionDailyJournalEntry = {
      id: buildEntryId('daily-reflection', this.now),
      kind: 'daily_journal_entry',
      source: input.source,
      executionSource: input.executionSource,
      reflection: normalizeRequiredString(input.reflection, 'reflection'),
      createdAt,
      date,
      ...(normalizeOptionalString(input.templateId, 'templateId') ? { templateId: normalizeOptionalString(input.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(input.templateName, 'templateName') ? { templateName: normalizeOptionalString(input.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(input.channelId, 'channelId') ? { channelId: normalizeOptionalString(input.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(input.prompt, 'prompt') ? { prompt: normalizeOptionalString(input.prompt, 'prompt') } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(normalizeOptionalString(input.reflectionJournalEntryId, 'reflectionJournalEntryId')
        ? { reflectionJournalEntryId: normalizeOptionalString(input.reflectionJournalEntryId, 'reflectionJournalEntryId') }
        : {}),
      ...(normalizeOptionalString(input.processId, 'processId') ? { processId: normalizeOptionalString(input.processId, 'processId') } : {}),
      ...(normalizeTags(input.tags) ? { tags: normalizeTags(input.tags) } : {}),
    };

    appendJsonLine(join(this.rootDir, `${date}.jsonl`), entry);
    log.debug('Persisted reflection daily journal entry', {
      date,
      source: entry.source,
      executionSource: entry.executionSource,
    });
    return entry;
  }
}

export class ReflectionProcessLogStore {
  private readonly rootDir: string;
  private readonly now: () => number;

  constructor(rootDir: string, options: ReflectionSubstrateStoreOptions = {}) {
    this.rootDir = rootDir;
    this.now = options.now ?? Date.now;
  }

  append(input: ReflectionProcessLogAppendInput): ReflectionProcessLogEntry {
    const processId = normalizeRequiredString(input.processId, 'processId');
    const reflection = normalizeOptionalString(input.reflection, 'reflection');
    const error = normalizeOptionalString(input.error, 'error');
    if (input.stage === 'completed' && !reflection) {
      throw new Error('reflection is required when process stage is "completed"');
    }
    if (input.stage === 'failed' && !error) {
      throw new Error('error is required when process stage is "failed"');
    }

    const entry: ReflectionProcessLogEntry = {
      id: buildEntryId('reflection-process', this.now),
      kind: 'process_log_entry',
      processId,
      processLabel: normalizeRequiredString(input.processLabel, 'processLabel'),
      processType: input.processType,
      stage: input.stage,
      executionSource: input.executionSource,
      createdAt: normalizeCreatedAt(input.createdAt, this.now),
      ...(normalizeOptionalString(input.templateId, 'templateId') ? { templateId: normalizeOptionalString(input.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(input.templateName, 'templateName') ? { templateName: normalizeOptionalString(input.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(input.channelId, 'channelId') ? { channelId: normalizeOptionalString(input.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(input.prompt, 'prompt') ? { prompt: normalizeOptionalString(input.prompt, 'prompt') } : {}),
      ...(reflection ? { reflection } : {}),
      ...(error ? { error } : {}),
      ...(normalizeTags(input.tags) ? { tags: normalizeTags(input.tags) } : {}),
      ...(normalizeDeliberationMetadata(input.deliberation) ? { deliberation: normalizeDeliberationMetadata(input.deliberation) } : {}),
    };

    appendJsonLine(join(this.rootDir, `${sanitizeChannelId(processId)}.jsonl`), entry);
    log.debug('Persisted reflection process log entry', {
      processId,
      stage: entry.stage,
      processType: entry.processType,
    });
    return entry;
  }
}
