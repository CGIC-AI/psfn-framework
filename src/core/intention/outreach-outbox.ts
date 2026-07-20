import { CHANNEL_TYPES, type ChannelType } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import { isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';
import { appendJsonLine, readJsonLines } from '../../persistence/jsonl.js';

const log = createComponentLogger('OutreachOutbox');

export type OutreachOutboxPhase =
  | 'queued'
  | 'scheduled'
  | 'dispatching'
  | 'sent'
  | 'blocked'
  | 'failed'
  | 'skipped';
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
  getLatest(dedupeKey: string): OutreachOutboxRecord | undefined;
  getIcpDeliveredCompletion(pendingFollowUpId: string): OutreachOutboxRecord | undefined;
  listRecent(limit?: number): OutreachOutboxRecord[];
  /**
   * Durable count of 'sent' records at or after `sinceMs`, optionally filtered
   * by a reason prefix (e.g. 'social_desire' for the desire-outreach rate
   * budget, bead oth4.2). Counting from this ledger keeps budget enforcement
   * at the dispatch layer and restart-proof.
   */
  countSentSince(input: { sinceMs: number; reasonPrefix?: string }): number;
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
  return typeof value === 'string' && CHANNEL_TYPES.includes(value as ChannelType);
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
    || !TERMINAL_PHASES.has(phase as OutreachOutboxPhase)
      && phase !== 'queued'
      && phase !== 'scheduled'
      && phase !== 'dispatching'
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

function deliveredIcpPendingFollowUpId(record: OutreachOutboxRecord): string | undefined {
  if (record.phase !== 'sent' || !record.metadata) return undefined;
  if (record.metadata.kind !== 'icp_candidate_delivery'
    || record.metadata.disposition !== 'delivered'
    || record.metadata.candidateStatus !== 'consumed'
    || typeof record.metadata.candidateId !== 'string'
    || !isRfc4122Uuid(record.metadata.candidateId)) {
    return undefined;
  }
  return normalizeNonEmptyString(record.metadata.pendingFollowUpId);
}

export function createFileOutreachOutboxStore(path: string): OutreachOutboxStore {
  const records: OutreachOutboxRecord[] = [];
  const terminalByDedupeKey = new Map<string, OutreachOutboxRecord>();
  const latestByDedupeKey = new Map<string, OutreachOutboxRecord>();
  const icpDeliveredByPendingFollowUpId = new Map<string, OutreachOutboxRecord>();

  const remember = (record: OutreachOutboxRecord): void => {
    records.push(record);
    latestByDedupeKey.set(record.dedupeKey, record);
    if (TERMINAL_PHASES.has(record.phase)) {
      terminalByDedupeKey.set(record.dedupeKey, record);
    }
    const pendingFollowUpId = deliveredIcpPendingFollowUpId(record);
    if (pendingFollowUpId) {
      icpDeliveredByPendingFollowUpId.set(pendingFollowUpId, record);
    }
  };

  const loaded = readJsonLines(path, normalizeRecord);
  for (const record of loaded.entries) {
    remember(record);
  }
  const malformed = loaded.skipped + loaded.corrupt;
  if (malformed > 0) {
    log.warn('Ignored malformed outreach outbox ledger records during load', {
      path,
      malformed,
    });
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
      appendJsonLine(path, record);
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
    getLatest(dedupeKey) {
      const record = latestByDedupeKey.get(dedupeKey.trim());
      return record ? { ...record, ...(record.metadata ? { metadata: { ...record.metadata } } : {}) } : undefined;
    },
    getIcpDeliveredCompletion(pendingFollowUpId) {
      const record = icpDeliveredByPendingFollowUpId.get(pendingFollowUpId.trim());
      return record ? { ...record, ...(record.metadata ? { metadata: { ...record.metadata } } : {}) } : undefined;
    },
    listRecent(limit = 25) {
      return records
        .slice(Math.max(0, records.length - Math.max(0, Math.floor(limit))))
        .reverse()
        .map(record => ({ ...record, ...(record.metadata ? { metadata: { ...record.metadata } } : {}) }));
    },
    countSentSince({ sinceMs, reasonPrefix }) {
      let count = 0;
      for (const record of records) {
        if (record.phase !== 'sent' || record.recordedAt < sinceMs) continue;
        if (reasonPrefix !== undefined && !(record.reason ?? '').startsWith(reasonPrefix)) continue;
        count += 1;
      }
      return count;
    },
  };
}
