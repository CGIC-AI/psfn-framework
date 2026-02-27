import type { CompactionSummary, JournalEntry, SessionEntry } from '../types.js';
import type { JournalMarkerEntry } from './types.js';

export function journalToSessionEntry(entry: JournalEntry): SessionEntry | null {
  if (entry.type !== 'message') {
    return null;
  }

  return {
    id: entry.id,
    channelId: entry.channelId,
    role: entry.role!,
    content: entry.content!,
    authorId: entry.authorId,
    authorName: entry.authorName,
    timestamp: entry.timestamp,
    discordMessageId: entry.discordMessageId,
    metadata: entry.metadata,
    originChannelId: entry.originChannelId,
    channelVisibility: entry.channelVisibility,
  };
}

export function journalToCompactionSummary(entry: JournalEntry): CompactionSummary | null {
  if (entry.type !== 'compaction') {
    return null;
  }

  return {
    id: entry.id,
    channelId: entry.channelId,
    summary: entry.summary!,
    coveredUpTo: entry.coveredUpTo!,
    createdAt: entry.timestamp,
  };
}

export function journalToMarkerEntry(entry: JournalEntry): JournalMarkerEntry | null {
  if (entry.type !== 'marker') return null;
  if (entry.marker !== 'extraction' && entry.marker !== 'graceful_shutdown') return null;

  return {
    id: entry.id,
    channelId: entry.channelId,
    marker: entry.marker,
    timestamp: entry.timestamp,
    coveredUpTo: entry.coveredUpTo,
  };
}

export function buildMessageJournalEntry(id: number, entry: Omit<SessionEntry, 'id'>): JournalEntry {
  return {
    type: 'message',
    id,
    channelId: entry.channelId,
    role: entry.role,
    content: entry.content,
    authorId: entry.authorId,
    authorName: entry.authorName,
    timestamp: entry.timestamp,
    discordMessageId: entry.discordMessageId,
    metadata: entry.metadata,
    originChannelId: entry.originChannelId,
    channelVisibility: entry.channelVisibility,
  };
}

export function buildCompactionJournalEntry(
  id: number,
  channelId: string,
  summary: string,
  coveredUpTo: number,
  timestamp: number,
): JournalEntry {
  return {
    type: 'compaction',
    id,
    channelId,
    summary,
    coveredUpTo,
    timestamp,
  };
}

export function buildExtractionMarkerJournalEntry(
  id: number,
  channelId: string,
  coveredUpTo: number,
  timestamp: number,
): JournalEntry {
  return {
    type: 'marker',
    id,
    channelId,
    marker: 'extraction',
    coveredUpTo,
    timestamp,
  };
}

export function buildGracefulShutdownMarkerJournalEntry(
  id: number,
  channelId: string,
  timestamp: number,
): JournalEntry {
  return {
    type: 'marker',
    id,
    channelId,
    marker: 'graceful_shutdown',
    timestamp,
  };
}
