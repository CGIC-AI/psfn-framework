import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ChannelType } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord } from '../../shared/utils/types.js';

const log = createComponentLogger('OutreachOutbox');

export type OutreachOutboxPhase = 'queued' | 'scheduled' | 'sent' | 'blocked' | 'failed' | 'skipped';
export type OutreachOutboxTerminalPhase = Extract<OutreachOutboxPhase, 'sent' | 'blocked' | 'failed' | 'skipped'>;

export interface OutreachOutboxRecord {
  version: 1;
  phase: OutreachOutboxPhase;
  actionId: string;
  dedupeKey: string;
  channelId: string;
  channelType: ChannelType;
  sourceMessageId: string;
  recordedAt: number;
  contentHash?: string;
  contentLength?: number;
  reason?: string;
  runAt?: number;
  attempt?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface OutreachOutboxAppendInput {
  phase: OutreachOutboxPhase;
  actionId: string;
  dedupeKey: string;
  channelId: string;
  channelType: ChannelType;
  sourceMessageId: string;
  contentHash?: string;
  contentLength?: number;
  reason?: string;
  runAt?: number;
  attempt?: number;
  error?: string;
  metadata?: Record<string, unknown>;
  recordedAt?: number;
}

export interface OutreachOutboxStore {
  append(input: OutreachOutboxAppendInput): OutreachOutboxRecord;
  hasTerminal(dedupeKey: string): boolean;
  getTerminal(dedupeKey: string): OutreachOutboxRecord | undefined;
  listRecent(limit?: number): OutreachOutboxRecord[];
}

const TERMINAL_PHASES = new Set<OutreachOutboxPhase>(['sent', 'blocked', 'failed', 'skipped']);

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizePositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function isChannelType(value: unknown): value is ChannelType {
  return value === 'discord'
    || value === 'terminal'
    || value === 'api'
    || value === 'telegram'
    || value === 'psfn-amica';
}

function normalizeRecord(value: unknown): OutreachOutboxRecord | null {
  if (!isRecord(value) || value.version !== 1) {
    return null;
  }
  const phase = normalizeNonEmptyString(value.phase);
  const actionId = normalizeNonEmptyString(value.actionId);
  const dedupeKey = normalizeNonEmptyString(value.dedupeKey);
  const channelId = normalizeNonEmptyString(value.channelId);
  const sourceMessageId = normalizeNonEmptyString(value.sourceMessageId);
  const recordedAt = normalizePositiveNumber(value.recordedAt);
  if (
    !phase
    || !TERMINAL_PHASES.has(phase as OutreachOutboxPhase) && phase !== 'queued' && phase !== 'scheduled'
    || !actionId
    || !dedupeKey
    || !channelId
    || !isChannelType(value.channelType)
    || !sourceMessageId
    || recordedAt === undefined
  ) {
    return null;
  }

  const record: OutreachOutboxRecord = {
    version: 1,
    phase: phase as OutreachOutboxPhase,
    actionId,
    dedupeKey,
    channelId,
    channelType: value.channelType,
    sourceMessageId,
    recordedAt,
  };
  const contentHash = normalizeNonEmptyString(value.contentHash);
  const contentLength = normalizePositiveNumber(value.contentLength);
  const reason = normalizeNonEmptyString(value.reason);
  const runAt = normalizePositiveNumber(value.runAt);
  const attempt = normalizePositiveNumber(value.attempt);
  const error = normalizeNonEmptyString(value.error);
  if (contentHash) record.contentHash = contentHash;
  if (contentLength !== undefined) record.contentLength = contentLength;
  if (reason) record.reason = reason;
  if (runAt !== undefined) record.runAt = runAt;
  if (attempt !== undefined) record.attempt = attempt;
  if (error) record.error = error;
  if (isRecord(value.metadata)) record.metadata = { ...value.metadata };
  return record;
}

export function createFileOutreachOutboxStore(path: string): OutreachOutboxStore {
  const records: OutreachOutboxRecord[] = [];
  const terminalByDedupeKey = new Map<string, OutreachOutboxRecord>();

  const remember = (record: OutreachOutboxRecord): void => {
    records.push(record);
    if (TERMINAL_PHASES.has(record.phase)) {
      terminalByDedupeKey.set(record.dedupeKey, record);
    }
  };

  if (existsSync(path)) {
    const lines = readFileSync(path, 'utf-8').split(/\r?\n/);
    let malformed = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const record = normalizeRecord(JSON.parse(line));
        if (record) {
          remember(record);
        } else {
          malformed += 1;
        }
      } catch {
        malformed += 1;
      }
    }
    if (malformed > 0) {
      log.warn('Ignored malformed outreach outbox ledger records during load', {
        path,
        malformed,
      });
    }
  }

  return {
    append(input) {
      const record = normalizeRecord({
        version: 1,
        ...input,
        recordedAt: input.recordedAt ?? Date.now(),
      });
      if (!record) {
        throw new Error('Invalid outreach outbox record');
      }
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify(record)}\n`, 'utf-8');
      remember(record);
      return { ...record, ...(record.metadata ? { metadata: { ...record.metadata } } : {}) };
    },
    hasTerminal(dedupeKey) {
      return terminalByDedupeKey.has(dedupeKey.trim());
    },
    getTerminal(dedupeKey) {
      const record = terminalByDedupeKey.get(dedupeKey.trim());
      return record ? { ...record, ...(record.metadata ? { metadata: { ...record.metadata } } : {}) } : undefined;
    },
    listRecent(limit = 25) {
      return records
        .slice(Math.max(0, records.length - Math.max(0, Math.floor(limit))))
        .reverse()
        .map(record => ({ ...record, ...(record.metadata ? { metadata: { ...record.metadata } } : {}) }));
    },
  };
}
