import type { JournalEntry } from '../../../core/session/types.js';
import {
  isCogSecInvalidatedSummaryContent,
  isCogSecTombstoneContent,
} from '../../../core/cogsec/tombstones.js';

export interface CogSecSelectorOptions {
  messageIds?: readonly number[];
  startEntryId?: number;
  endEntryId?: number;
}

export interface CogSecJournalSelector {
  messageIds: Set<number>;
  startEntryId?: number;
  endEntryId?: number;
}

export function normalizeEntryId(value: number, field: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${field} must be a positive integer`);
  }
  return value;
}

function normalizeOptionalEntryId(value: number | undefined, field: string): number | undefined {
  return value === undefined ? undefined : normalizeEntryId(value, field);
}

export function normalizeCogSecSelector(options: CogSecSelectorOptions): CogSecJournalSelector {
  const messageIds = new Set<number>();
  for (const [index, id] of (options.messageIds ?? []).entries()) {
    messageIds.add(normalizeEntryId(id, `messageIds[${index}]`));
  }
  const startEntryId = normalizeOptionalEntryId(options.startEntryId, 'startEntryId');
  const endEntryId = normalizeOptionalEntryId(options.endEntryId, 'endEntryId');
  if (startEntryId !== undefined && endEntryId !== undefined && endEntryId < startEntryId) {
    throw new Error('endEntryId must be greater than or equal to startEntryId');
  }
  if (messageIds.size === 0 && startEntryId === undefined && endEntryId === undefined) {
    throw new Error('CogSec tombstone requires messageIds or an entry-id range');
  }
  return {
    messageIds,
    ...(startEntryId !== undefined ? { startEntryId } : {}),
    ...(endEntryId !== undefined ? { endEntryId } : {}),
  };
}

export function isSelectedCogSecMessage(
  entry: JournalEntry,
  selector: CogSecJournalSelector,
): boolean {
  if (entry.type !== 'message') return false;
  if (selector.messageIds.has(entry.id)) return true;
  if (selector.startEntryId !== undefined && entry.id < selector.startEntryId) return false;
  if (selector.endEntryId !== undefined && entry.id > selector.endEntryId) return false;
  return selector.startEntryId !== undefined || selector.endEntryId !== undefined;
}

export function uniqueStrings<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

export function buildCogSecTombstoneJournalEntry(
  entry: JournalEntry,
  content: string,
  metadata: string,
): JournalEntry {
  if (entry.type !== 'message') {
    throw new Error('CogSec tombstone can only replace message journal entries');
  }
  return {
    type: 'message',
    id: entry.id,
    channelId: entry.channelId,
    role: entry.role!,
    content,
    authorId: entry.authorId,
    authorName: entry.authorName,
    timestamp: entry.timestamp,
    discordMessageId: entry.discordMessageId,
    metadata,
    originChannelId: entry.originChannelId,
    channelVisibility: entry.channelVisibility,
  };
}

export function buildCogSecInvalidatedCompactionJournalEntry(
  entry: JournalEntry,
  summary: string,
): JournalEntry {
  if (entry.type !== 'compaction') {
    throw new Error('CogSec summary invalidation can only replace compaction journal entries');
  }
  return {
    type: 'compaction',
    id: entry.id,
    channelId: entry.channelId,
    timestamp: entry.timestamp,
    summary,
    coveredUpTo: entry.coveredUpTo,
  };
}

export function normalizeCogSecRegeneratedSummary(summary: string, field: string): string {
  const normalized = summary.trim();
  if (!normalized) {
    throw new Error(`${field} must be non-empty`);
  }
  if (
    isCogSecTombstoneContent(normalized)
    || isCogSecInvalidatedSummaryContent(normalized)
    || normalized.includes('[CogSec redaction:')
    || normalized.includes('[CogSec summary invalidated:')
  ) {
    throw new Error(`${field} must not contain CogSec tombstone or invalidation marker text`);
  }
  return normalized;
}
