import { existsSync, readFileSync } from 'node:fs';
import type { SessionEntry } from '../../../core/session/types.js';
import {
  createDefaultGroupMemorySettings,
  type GroupMemorySettings,
} from '../../../system/config/group-memory-config.js';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import { isRecord } from '../../../shared/utils/types.js';

export const GROUP_MEMORY_POLICY_VERSION = 'group-memory:v1';

export type GroupMemoryWatermarkStatus =
  | 'processed'
  | 'skipped'
  | 'failed'
  | 'empty';

export interface GroupMemorySpanRecord {
  startMessageId: number;
  endMessageId: number;
  entryCount: number;
  recordedAt: number;
  reason?: string;
}

export interface GroupMemoryFailureRecord extends GroupMemorySpanRecord {
  error: string;
  retryCount: number;
}

export interface GroupMemoryWatermarkRecord {
  schemaVersion: 1;
  channelId: string;
  policyVersion: string;
  coveredUpToMessageId: number;
  updatedAt: number;
  status: GroupMemoryWatermarkStatus;
  processedSpanCount: number;
  skippedSpanCount: number;
  failureCount: number;
  lastProcessedSpan?: GroupMemorySpanRecord;
  lastSkippedSpan?: GroupMemorySpanRecord;
  lastFailure?: GroupMemoryFailureRecord;
}

export interface GroupMemoryWatermarkStorePort {
  get(channelId: string, policyVersion?: string): GroupMemoryWatermarkRecord;
  markProcessed(input: GroupMemoryWatermarkMutationInput): GroupMemoryWatermarkRecord;
  markSkipped(input: GroupMemoryWatermarkMutationInput & { reason: string }): GroupMemoryWatermarkRecord;
  markFailed(input: GroupMemoryFailureInput): GroupMemoryWatermarkRecord;
}

export interface GroupMemoryWatermarkMutationInput {
  channelId: string;
  policyVersion?: string;
  startMessageId: number;
  endMessageId: number;
  entryCount: number;
  recordedAt?: number;
}

export interface GroupMemoryFailureInput extends GroupMemoryWatermarkMutationInput {
  error: string;
}

export interface GroupMemoryRangeSessionReader {
  getLastEntry(channelId: string): SessionEntry | undefined;
  getEntriesInRange(channelId: string, startId: number, endId: number): SessionEntry[];
  getEntriesAfter?(channelId: string, afterId: number, limit: number): SessionEntry[];
}

export interface GroupMemoryRangeChunk {
  channelId: string;
  policyVersion: string;
  spanStartMessageId: number;
  spanEndMessageId: number;
  contextStartMessageId: number;
  contextEndMessageId: number;
  entries: SessionEntry[];
  newEntries: SessionEntry[];
  newEntryCount: number;
  overlapEntryCount: number;
  estimatedTokens: number;
}

export interface GroupMemoryRangePlan {
  channelId: string;
  policyVersion: string;
  watermark: GroupMemoryWatermarkRecord;
  headMessageId: number | null;
  watermarkLagMessageIds: number;
  chunks: GroupMemoryRangeChunk[];
  hasDeferredBacklog: boolean;
  deferredAfterMessageId?: number;
}

export interface GroupMemoryRangePlanOptions {
  channelId: string;
  sessionReader: GroupMemoryRangeSessionReader;
  watermarkStore?: GroupMemoryWatermarkStorePort;
  watermark?: GroupMemoryWatermarkRecord;
  settings?: GroupMemorySettings;
  policyVersion?: string;
  estimateEntryTokens?: (entry: SessionEntry) => number;
}

interface GroupMemoryWatermarkFile {
  schemaVersion: 1;
  records: Record<string, GroupMemoryWatermarkRecord>;
}

export class JsonGroupMemoryWatermarkStore implements GroupMemoryWatermarkStorePort {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  get(channelId: string, policyVersion = GROUP_MEMORY_POLICY_VERSION): GroupMemoryWatermarkRecord {
    const records = this.loadRecords();
    return records[this.key(channelId, policyVersion)]
      ?? createEmptyWatermark(channelId, policyVersion);
  }

  markProcessed(input: GroupMemoryWatermarkMutationInput): GroupMemoryWatermarkRecord {
    const policyVersion = input.policyVersion ?? GROUP_MEMORY_POLICY_VERSION;
    const records = this.loadRecords();
    const current = records[this.key(input.channelId, policyVersion)]
      ?? createEmptyWatermark(input.channelId, policyVersion);
    const span = normalizeSpanRecord(input, input.recordedAt ?? Date.now());
    const next: GroupMemoryWatermarkRecord = {
      ...current,
      coveredUpToMessageId: Math.max(current.coveredUpToMessageId, span.endMessageId),
      updatedAt: span.recordedAt,
      status: 'processed',
      processedSpanCount: current.processedSpanCount + 1,
      lastProcessedSpan: span,
    };
    this.saveRecord(next);
    return next;
  }

  markSkipped(input: GroupMemoryWatermarkMutationInput & { reason: string }): GroupMemoryWatermarkRecord {
    const policyVersion = input.policyVersion ?? GROUP_MEMORY_POLICY_VERSION;
    const records = this.loadRecords();
    const current = records[this.key(input.channelId, policyVersion)]
      ?? createEmptyWatermark(input.channelId, policyVersion);
    const span = normalizeSpanRecord(input, input.recordedAt ?? Date.now(), input.reason);
    const next: GroupMemoryWatermarkRecord = {
      ...current,
      coveredUpToMessageId: Math.max(current.coveredUpToMessageId, span.endMessageId),
      updatedAt: span.recordedAt,
      status: 'skipped',
      skippedSpanCount: current.skippedSpanCount + 1,
      lastSkippedSpan: span,
    };
    this.saveRecord(next);
    return next;
  }

  markFailed(input: GroupMemoryFailureInput): GroupMemoryWatermarkRecord {
    const policyVersion = input.policyVersion ?? GROUP_MEMORY_POLICY_VERSION;
    const records = this.loadRecords();
    const current = records[this.key(input.channelId, policyVersion)]
      ?? createEmptyWatermark(input.channelId, policyVersion);
    const previousRetryCount =
      current.lastFailure?.startMessageId === input.startMessageId
      && current.lastFailure.endMessageId === input.endMessageId
        ? current.lastFailure.retryCount
        : 0;
    const span = normalizeSpanRecord(input, input.recordedAt ?? Date.now());
    const next: GroupMemoryWatermarkRecord = {
      ...current,
      updatedAt: span.recordedAt,
      status: 'failed',
      failureCount: current.failureCount + 1,
      lastFailure: {
        ...span,
        error: input.error,
        retryCount: previousRetryCount + 1,
      },
    };
    this.saveRecord(next);
    return next;
  }

  private loadRecords(): Record<string, GroupMemoryWatermarkRecord> {
    if (!existsSync(this.filePath)) return {};
    const parsed = JSON.parse(readFileSync(this.filePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || parsed.schemaVersion !== 1 || !isRecord(parsed.records)) {
      throw new Error('Invalid group memory watermark file');
    }
    const records: Record<string, GroupMemoryWatermarkRecord> = {};
    for (const [key, value] of Object.entries(parsed.records)) {
      const record = normalizeWatermarkRecord(value);
      if (record) records[key] = record;
    }
    return records;
  }

  private saveRecord(record: GroupMemoryWatermarkRecord): void {
    const records = this.loadRecords();
    records[this.key(record.channelId, record.policyVersion)] = record;
    const payload: GroupMemoryWatermarkFile = {
      schemaVersion: 1,
      records,
    };
    writeJsonAtomic(this.filePath, payload);
  }

  private key(channelId: string, policyVersion: string): string {
    return `${policyVersion}:${channelId}`;
  }
}

export function createEmptyWatermark(
  channelId: string,
  policyVersion = GROUP_MEMORY_POLICY_VERSION,
): GroupMemoryWatermarkRecord {
  return {
    schemaVersion: 1,
    channelId,
    policyVersion,
    coveredUpToMessageId: 0,
    updatedAt: 0,
    status: 'empty',
    processedSpanCount: 0,
    skippedSpanCount: 0,
    failureCount: 0,
  };
}

export function buildGroupMemoryRangePlan(
  options: GroupMemoryRangePlanOptions,
): GroupMemoryRangePlan {
  const policyVersion = options.policyVersion ?? GROUP_MEMORY_POLICY_VERSION;
  const settings = options.settings ?? createDefaultGroupMemorySettings();
  const watermark = options.watermark
    ?? options.watermarkStore?.get(options.channelId, policyVersion)
    ?? createEmptyWatermark(options.channelId, policyVersion);
  const head = options.sessionReader.getLastEntry(options.channelId);
  const headMessageId = head?.id ?? null;
  if (!headMessageId || headMessageId <= watermark.coveredUpToMessageId) {
    return {
      channelId: options.channelId,
      policyVersion,
      watermark,
      headMessageId,
      watermarkLagMessageIds: 0,
      chunks: [],
      hasDeferredBacklog: false,
    };
  }

  const maxMessagesPerChunk = Math.max(1, settings.onlineExtraction.maxMessagesPerChunk);
  const maxChunksPerRun = Math.max(1, settings.onlineExtraction.maxBacklogChunksPerRun);
  const maxCandidateEntries = maxMessagesPerChunk * maxChunksPerRun;
  const fetchedEntries = readUnreadEntries({
    channelId: options.channelId,
    sessionReader: options.sessionReader,
    afterMessageId: watermark.coveredUpToMessageId,
    headMessageId,
    limit: maxCandidateEntries + 1,
  });
  const hasMoreCandidatesThanRunLimit = fetchedEntries.length > maxCandidateEntries;
  const candidateEntries = fetchedEntries
    .slice(0, maxCandidateEntries)
    .sort((left, right) => left.id - right.id);
  const chunks = chunkGroupMemoryEntries({
    channelId: options.channelId,
    policyVersion,
    candidateEntries,
    sessionReader: options.sessionReader,
    settings,
    estimateEntryTokens: options.estimateEntryTokens ?? defaultEstimateEntryTokens,
  });
  const lastChunk = chunks.at(-1);
  const lastPlannedMessageId = lastChunk?.spanEndMessageId
    ?? watermark.coveredUpToMessageId;
  const hasDeferredBacklog =
    hasMoreCandidatesThanRunLimit
    || lastPlannedMessageId < headMessageId
    || candidateEntries.some(entry => entry.id > lastPlannedMessageId);

  return {
    channelId: options.channelId,
    policyVersion,
    watermark,
    headMessageId,
    watermarkLagMessageIds: headMessageId - watermark.coveredUpToMessageId,
    chunks,
    hasDeferredBacklog,
    ...(hasDeferredBacklog ? { deferredAfterMessageId: lastPlannedMessageId } : {}),
  };
}

function readUnreadEntries(params: {
  channelId: string;
  sessionReader: GroupMemoryRangeSessionReader;
  afterMessageId: number;
  headMessageId: number;
  limit: number;
}): SessionEntry[] {
  const entries = params.sessionReader.getEntriesAfter
    ? params.sessionReader.getEntriesAfter(params.channelId, params.afterMessageId, params.limit)
    : params.sessionReader.getEntriesInRange(
      params.channelId,
      params.afterMessageId + 1,
      params.headMessageId,
    );
  return entries
    .filter(entry => entry.id > params.afterMessageId)
    .sort((left, right) => left.id - right.id)
    .slice(0, params.limit);
}

function chunkGroupMemoryEntries(params: {
  channelId: string;
  policyVersion: string;
  candidateEntries: readonly SessionEntry[];
  sessionReader: GroupMemoryRangeSessionReader;
  settings: GroupMemorySettings;
  estimateEntryTokens: (entry: SessionEntry) => number;
}): GroupMemoryRangeChunk[] {
  const chunks: GroupMemoryRangeChunk[] = [];
  const maxMessagesPerChunk = Math.max(1, params.settings.onlineExtraction.maxMessagesPerChunk);
  const maxTokensPerChunk = Math.max(1, params.settings.onlineExtraction.maxEstimatedTokensPerChunk);
  const maxChunksPerRun = Math.max(1, params.settings.onlineExtraction.maxBacklogChunksPerRun);
  let cursor = 0;

  while (cursor < params.candidateEntries.length && chunks.length < maxChunksPerRun) {
    const newEntries: SessionEntry[] = [];
    let estimatedTokens = 0;
    while (cursor < params.candidateEntries.length && newEntries.length < maxMessagesPerChunk) {
      const entry = params.candidateEntries[cursor];
      const entryTokens = Math.max(1, params.estimateEntryTokens(entry));
      if (
        newEntries.length > 0
        && estimatedTokens + entryTokens > maxTokensPerChunk
      ) {
        break;
      }
      newEntries.push(entry);
      estimatedTokens += entryTokens;
      cursor += 1;
    }
    if (newEntries.length === 0) {
      const entry = params.candidateEntries[cursor];
      newEntries.push(entry);
      estimatedTokens = Math.max(1, params.estimateEntryTokens(entry));
      cursor += 1;
    }

    const spanStartMessageId = newEntries[0].id;
    const spanEndMessageId = newEntries[newEntries.length - 1].id;
    const contextStartMessageId = Math.max(
      1,
      spanStartMessageId - params.settings.onlineExtraction.chunkOverlapMessages,
    );
    const entries = params.sessionReader
      .getEntriesInRange(params.channelId, contextStartMessageId, spanEndMessageId)
      .sort((left, right) => left.id - right.id);
    const overlapEntryCount = entries
      .filter(entry => entry.id < spanStartMessageId)
      .length;

    chunks.push({
      channelId: params.channelId,
      policyVersion: params.policyVersion,
      spanStartMessageId,
      spanEndMessageId,
      contextStartMessageId,
      contextEndMessageId: spanEndMessageId,
      entries,
      newEntries,
      newEntryCount: newEntries.length,
      overlapEntryCount,
      estimatedTokens,
    });
  }

  return chunks;
}

function normalizeSpanRecord(
  input: GroupMemoryWatermarkMutationInput,
  recordedAt: number,
  reason?: string,
): GroupMemorySpanRecord {
  const startMessageId = normalizeNonNegativeInteger(input.startMessageId, 'startMessageId');
  const endMessageId = normalizeNonNegativeInteger(input.endMessageId, 'endMessageId');
  if (endMessageId < startMessageId) {
    throw new Error('Group memory watermark span end must be >= start');
  }
  return {
    startMessageId,
    endMessageId,
    entryCount: normalizeNonNegativeInteger(input.entryCount, 'entryCount'),
    recordedAt: normalizeNonNegativeInteger(recordedAt, 'recordedAt'),
    ...(reason ? { reason } : {}),
  };
}

function normalizeWatermarkRecord(value: unknown): GroupMemoryWatermarkRecord | null {
  if (!isRecord(value) || value.schemaVersion !== 1) return null;
  if (typeof value.channelId !== 'string' || typeof value.policyVersion !== 'string') {
    return null;
  }
  const status = normalizeStatus(value.status);
  if (!status) return null;
  const record: GroupMemoryWatermarkRecord = {
    schemaVersion: 1,
    channelId: value.channelId,
    policyVersion: value.policyVersion,
    coveredUpToMessageId: normalizeNonNegativeInteger(value.coveredUpToMessageId, 'coveredUpToMessageId'),
    updatedAt: normalizeNonNegativeInteger(value.updatedAt, 'updatedAt'),
    status,
    processedSpanCount: normalizeNonNegativeInteger(value.processedSpanCount, 'processedSpanCount'),
    skippedSpanCount: normalizeNonNegativeInteger(value.skippedSpanCount, 'skippedSpanCount'),
    failureCount: normalizeNonNegativeInteger(value.failureCount, 'failureCount'),
  };
  const lastProcessedSpan = normalizeOptionalSpanRecord(value.lastProcessedSpan);
  if (lastProcessedSpan) record.lastProcessedSpan = lastProcessedSpan;
  const lastSkippedSpan = normalizeOptionalSpanRecord(value.lastSkippedSpan);
  if (lastSkippedSpan) record.lastSkippedSpan = lastSkippedSpan;
  const lastFailure = normalizeOptionalFailureRecord(value.lastFailure);
  if (lastFailure) record.lastFailure = lastFailure;
  return record;
}

function normalizeOptionalSpanRecord(value: unknown): GroupMemorySpanRecord | undefined {
  if (!isRecord(value)) return undefined;
  return {
    startMessageId: normalizeNonNegativeInteger(value.startMessageId, 'startMessageId'),
    endMessageId: normalizeNonNegativeInteger(value.endMessageId, 'endMessageId'),
    entryCount: normalizeNonNegativeInteger(value.entryCount, 'entryCount'),
    recordedAt: normalizeNonNegativeInteger(value.recordedAt, 'recordedAt'),
    ...(typeof value.reason === 'string' && value.reason.trim()
      ? { reason: value.reason.trim() }
      : {}),
  };
}

function normalizeOptionalFailureRecord(value: unknown): GroupMemoryFailureRecord | undefined {
  if (!isRecord(value)) return undefined;
  const span = normalizeOptionalSpanRecord(value);
  if (!span || typeof value.error !== 'string') return undefined;
  return {
    ...span,
    error: value.error,
    retryCount: normalizeNonNegativeInteger(value.retryCount, 'retryCount'),
  };
}

function normalizeStatus(value: unknown): GroupMemoryWatermarkStatus | undefined {
  return value === 'processed'
    || value === 'skipped'
    || value === 'failed'
    || value === 'empty'
    ? value
    : undefined;
}

function normalizeNonNegativeInteger(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`Invalid group memory watermark ${field}`);
  }
  return value;
}

function defaultEstimateEntryTokens(entry: SessionEntry): number {
  return Math.max(1, Math.ceil(entry.content.length / 4));
}
