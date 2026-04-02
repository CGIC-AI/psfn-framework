import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../logger.js';
import { appendJsonLine } from '../persistence/jsonl.js';
import { sanitizeChannelId } from '../session/store-primitives.js';
import type { ValuesDeliberationMetadata } from '../values/store.js';
import type { ReflectionJournalEntry } from './reflection-journal.js';
import { NON_CANONICAL_REFLECTION_SUBSTRATE } from './reflection-journal.js';

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

export interface ReflectionSubstrateListOptions {
  limit?: number;
}

export interface ReflectionProcessLogListOptions extends ReflectionSubstrateListOptions {
  stages?: ReflectionProcessStage[];
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

export interface ReflectionSubstrateContext {
  canonicalTruthBoundary: typeof NON_CANONICAL_REFLECTION_SUBSTRATE;
  promptBlock: string;
  provenanceRefs: string[];
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
  const rounds = candidate.rounds as number;
  const totalInputTokens = candidate.totalInputTokens as number;
  const totalOutputTokens = candidate.totalOutputTokens as number;
  const totalTokens = candidate.totalTokens as number;
  const estimatedCostUsd = candidate.estimatedCostUsd as number;
  const durationMs = candidate.durationMs as number;
  return {
    sessionId: candidate.sessionId.trim(),
    stopReason: candidate.stopReason.trim(),
    rounds: Math.floor(rounds),
    totalInputTokens,
    totalOutputTokens,
    totalTokens,
    estimatedCostUsd,
    durationMs,
  };
}

function normalizePositiveInteger(value: unknown, fieldName: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw new Error(`${fieldName} must be a positive integer when provided`);
  }
  return value;
}

function readJsonlEntries<T>(
  filePath: string,
  normalize: (raw: unknown) => T | null,
  warningPrefix: string,
): T[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf-8');
  if (raw.trim().length === 0) return [];

  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map((line, index) => {
      try {
        return normalize(JSON.parse(line) as unknown);
      } catch (error) {
        log.warn(warningPrefix, {
          filePath,
          line: index + 1,
          error: String(error),
        });
        return null;
      }
    })
    .filter((entry): entry is T => entry !== null);
}

function listJsonlFiles(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir)
    .filter(fileName => fileName.endsWith('.jsonl'))
    .map(fileName => join(rootDir, fileName));
}

function sortEntriesByCreatedAtDescending<T extends { createdAt: string; id: string }>(entries: readonly T[]): T[] {
  return [...entries].sort((left, right) => {
    const timeDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
    if (timeDelta !== 0) return timeDelta;
    return right.id.localeCompare(left.id);
  });
}

function truncateReflectionText(text: string, maxLength = 220): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

function normalizeDailyJournalEntry(raw: unknown): ReflectionDailyJournalEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<ReflectionDailyJournalEntry>;
  if (
    typeof entry.id !== 'string'
    || entry.id.trim().length === 0
    || entry.kind !== 'daily_journal_entry'
    || entry.source !== 'heartbeat_template'
    || (entry.executionSource !== 'manual'
      && entry.executionSource !== 'scheduled'
      && entry.executionSource !== 'deferred_scheduler'
      && entry.executionSource !== 'deferred_post_turn')
    || typeof entry.reflection !== 'string'
    || entry.reflection.trim().length === 0
    || typeof entry.createdAt !== 'string'
    || entry.createdAt.trim().length === 0
    || typeof entry.date !== 'string'
    || entry.date.trim().length === 0
  ) {
    return null;
  }
  try {
    return {
      id: entry.id.trim(),
      kind: 'daily_journal_entry',
      source: 'heartbeat_template',
      executionSource: entry.executionSource,
      reflection: normalizeRequiredString(entry.reflection, 'reflection'),
      createdAt: normalizeCreatedAt(entry.createdAt, Date.now),
      date: normalizeIsoDate(entry.date, 'date'),
      ...(normalizeOptionalString(entry.templateId, 'templateId') ? { templateId: normalizeOptionalString(entry.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(entry.templateName, 'templateName') ? { templateName: normalizeOptionalString(entry.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(entry.channelId, 'channelId') ? { channelId: normalizeOptionalString(entry.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(entry.prompt, 'prompt') ? { prompt: normalizeOptionalString(entry.prompt, 'prompt') } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(normalizeOptionalString(entry.reflectionJournalEntryId, 'reflectionJournalEntryId')
        ? { reflectionJournalEntryId: normalizeOptionalString(entry.reflectionJournalEntryId, 'reflectionJournalEntryId') }
        : {}),
      ...(normalizeOptionalString(entry.processId, 'processId') ? { processId: normalizeOptionalString(entry.processId, 'processId') } : {}),
      ...(normalizeTags(entry.tags) ? { tags: normalizeTags(entry.tags) } : {}),
    };
  } catch {
    return null;
  }
}

function normalizeProcessLogEntry(raw: unknown): ReflectionProcessLogEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const entry = raw as Partial<ReflectionProcessLogEntry>;
  if (
    typeof entry.id !== 'string'
    || entry.id.trim().length === 0
    || entry.kind !== 'process_log_entry'
    || typeof entry.processId !== 'string'
    || entry.processId.trim().length === 0
    || typeof entry.processLabel !== 'string'
    || entry.processLabel.trim().length === 0
    || entry.processType !== 'reflection_deliberation'
    || (entry.stage !== 'started' && entry.stage !== 'completed' && entry.stage !== 'failed')
    || (entry.executionSource !== 'manual'
      && entry.executionSource !== 'scheduled'
      && entry.executionSource !== 'deferred_scheduler'
      && entry.executionSource !== 'deferred_post_turn')
    || typeof entry.createdAt !== 'string'
    || entry.createdAt.trim().length === 0
  ) {
    return null;
  }
  try {
    const reflection = normalizeOptionalString(entry.reflection, 'reflection');
    const error = normalizeOptionalString(entry.error, 'error');
    if (entry.stage === 'completed' && !reflection) {
      return null;
    }
    if (entry.stage === 'failed' && !error) {
      return null;
    }
    return {
      id: entry.id.trim(),
      kind: 'process_log_entry',
      processId: normalizeRequiredString(entry.processId, 'processId'),
      processLabel: normalizeRequiredString(entry.processLabel, 'processLabel'),
      processType: 'reflection_deliberation',
      stage: entry.stage,
      executionSource: entry.executionSource,
      createdAt: normalizeCreatedAt(entry.createdAt, Date.now),
      ...(normalizeOptionalString(entry.templateId, 'templateId') ? { templateId: normalizeOptionalString(entry.templateId, 'templateId') } : {}),
      ...(normalizeOptionalString(entry.templateName, 'templateName') ? { templateName: normalizeOptionalString(entry.templateName, 'templateName') } : {}),
      ...(normalizeOptionalString(entry.channelId, 'channelId') ? { channelId: normalizeOptionalString(entry.channelId, 'channelId') } : {}),
      ...(normalizeOptionalString(entry.prompt, 'prompt') ? { prompt: normalizeOptionalString(entry.prompt, 'prompt') } : {}),
      ...(reflection ? { reflection } : {}),
      ...(error ? { error } : {}),
      ...(normalizeTags(entry.tags) ? { tags: normalizeTags(entry.tags) } : {}),
      ...(normalizeDeliberationMetadata(entry.deliberation) ? { deliberation: normalizeDeliberationMetadata(entry.deliberation) } : {}),
    };
  } catch {
    return null;
  }
}

function buildEntryId(prefix: string, now: () => number): string {
  return `${prefix}-${now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

export function buildReflectionProcessId(processLabel: string, now: () => number = Date.now): string {
  const slug = sanitizeChannelId(normalizeRequiredString(processLabel, 'processLabel').toLowerCase());
  return `reflection-process-${slug}-${now().toString(36)}-${Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0')}`;
}

export function toReflectionJournalProvenanceRef(entry: Pick<
  ReflectionJournalEntry,
  'id' | 'templateId' | 'channelId' | 'mode' | 'createdAt'
>): string {
  return `reflection_journal:${entry.id}|template:${entry.templateId}|channel:${entry.channelId}|mode:${entry.mode}|createdAt:${entry.createdAt}`;
}

export function toReflectionDailyJournalProvenanceRef(entry: Pick<
  ReflectionDailyJournalEntry,
  'id' | 'templateId' | 'date' | 'executionSource' | 'createdAt'
>): string {
  return `reflection_daily:${entry.id}|template:${entry.templateId ?? 'unknown'}|date:${entry.date}|source:${entry.executionSource}|createdAt:${entry.createdAt}`;
}

export function toReflectionProcessLogProvenanceRef(entry: Pick<
  ReflectionProcessLogEntry,
  'id' | 'processId' | 'stage' | 'templateId' | 'createdAt'
>): string {
  return `reflection_process:${entry.id}|process:${entry.processId}|stage:${entry.stage}|template:${entry.templateId ?? 'unknown'}|createdAt:${entry.createdAt}`;
}

export function assembleReflectionSubstrateContext(input: {
  recentReflectionJournalEntries?: readonly ReflectionJournalEntry[];
  recentDailyJournalEntries?: readonly ReflectionDailyJournalEntry[];
  recentProcessLogEntries?: readonly ReflectionProcessLogEntry[];
}): ReflectionSubstrateContext | null {
  const recentReflectionJournalEntries = input.recentReflectionJournalEntries ?? [];
  const recentDailyJournalEntries = input.recentDailyJournalEntries ?? [];
  const recentProcessLogEntries = input.recentProcessLogEntries ?? [];

  if (
    recentReflectionJournalEntries.length === 0
    && recentDailyJournalEntries.length === 0
    && recentProcessLogEntries.length === 0
  ) {
    return null;
  }

  const sections: string[] = [
    '[Reflection Substrate Replay]',
    `canonical_truth_boundary: ${NON_CANONICAL_REFLECTION_SUBSTRATE}`,
    'guidance:',
    '- Treat these append-only journal and process traces as reflective clues, not canonical truth.',
    '- Preserve cited provenance refs when carrying a pattern forward.',
  ];
  const provenanceRefs: string[] = [];

  if (recentReflectionJournalEntries.length > 0) {
    sections.push('[Recent Reflection Journal]');
    for (const entry of recentReflectionJournalEntries) {
      const provenanceRef = toReflectionJournalProvenanceRef(entry);
      provenanceRefs.push(provenanceRef);
      sections.push(
        `- ref=${provenanceRef} template=${entry.templateId} mode=${entry.mode} reflection=${truncateReflectionText(entry.reflection)}`,
      );
    }
  }

  if (recentDailyJournalEntries.length > 0) {
    sections.push('[Recent Lived-Day Journal]');
    for (const entry of recentDailyJournalEntries) {
      const provenanceRef = toReflectionDailyJournalProvenanceRef(entry);
      provenanceRefs.push(provenanceRef);
      sections.push(
        `- ref=${provenanceRef} date=${entry.date} template=${entry.templateId ?? 'unknown'} reflection=${truncateReflectionText(entry.reflection)}`,
      );
    }
  }

  if (recentProcessLogEntries.length > 0) {
    sections.push('[Recent Long-Process Trace]');
    for (const entry of recentProcessLogEntries) {
      const provenanceRef = toReflectionProcessLogProvenanceRef(entry);
      provenanceRefs.push(provenanceRef);
      const processSummary = entry.stage === 'failed'
        ? `error=${truncateReflectionText(entry.error ?? 'unknown failure')}`
        : `reflection=${truncateReflectionText(entry.reflection ?? 'none')}`;
      sections.push(
        `- ref=${provenanceRef} process=${entry.processId} stage=${entry.stage} template=${entry.templateId ?? 'unknown'} ${processSummary}`,
      );
    }
  }

  return {
    canonicalTruthBoundary: NON_CANONICAL_REFLECTION_SUBSTRATE,
    promptBlock: sections.join('\n'),
    provenanceRefs: [...new Set(provenanceRefs)],
  };
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

  listRecent(options: ReflectionSubstrateListOptions = {}): ReflectionDailyJournalEntry[] {
    const limit = normalizePositiveInteger(options.limit, 'limit');
    const entries = sortEntriesByCreatedAtDescending(
      listJsonlFiles(this.rootDir)
        .flatMap(filePath => readJsonlEntries(
          filePath,
          normalizeDailyJournalEntry,
          'Skipping unreadable reflection daily journal line',
        )),
    );
    return limit === undefined ? entries : entries.slice(0, limit);
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

  listRecent(options: ReflectionProcessLogListOptions = {}): ReflectionProcessLogEntry[] {
    const limit = normalizePositiveInteger(options.limit, 'limit');
    const requestedStages = options.stages ? new Set(options.stages) : null;
    const entries = sortEntriesByCreatedAtDescending(
      listJsonlFiles(this.rootDir)
        .flatMap(filePath => readJsonlEntries(
          filePath,
          normalizeProcessLogEntry,
          'Skipping unreadable reflection process log line',
        ))
        .filter(entry => requestedStages === null || requestedStages.has(entry.stage)),
    );
    return limit === undefined ? entries : entries.slice(0, limit);
  }
}
