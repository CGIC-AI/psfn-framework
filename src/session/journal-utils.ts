import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { CompactionSummary, JournalEntry, SessionEntry } from './types.js';

export interface ReadJournalResult {
  entries: JournalEntry[];
  maxId: number;
}

export function parseJournalText(raw: string): ReadJournalResult {
  const entries: JournalEntry[] = [];
  let maxId = 0;

  const lines = raw.split('\n').filter(line => line.length > 0);
  for (const line of lines) {
    const entry = JSON.parse(line) as JournalEntry;
    entries.push(entry);
    if (entry.id > maxId) {
      maxId = entry.id;
    }
  }

  return { entries, maxId };
}

export function readJournalFile(filePath: string): ReadJournalResult {
  if (!existsSync(filePath)) {
    return { entries: [], maxId: 0 };
  }
  const raw = readFileSync(filePath, 'utf-8');
  return parseJournalText(raw);
}

export function appendJournalEntry(filePath: string, entry: JournalEntry): void {
  appendFileSync(filePath, JSON.stringify(entry) + '\n');
}

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
