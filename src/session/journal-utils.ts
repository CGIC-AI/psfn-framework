import {
  appendFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import type { CompactionSummary, JournalEntry, SessionEntry } from './types.js';

export interface QuarantinedJournalEntry {
  lineNumber: number;
  error: string;
  raw: string;
}

export interface ReadJournalResult {
  entries: JournalEntry[];
  maxId: number;
  quarantined: QuarantinedJournalEntry[];
}

export interface ReadJournalFileOptions {
  persistQuarantine?: boolean;
}

export function parseJournalText(raw: string): ReadJournalResult {
  const entries: JournalEntry[] = [];
  const quarantined: QuarantinedJournalEntry[] = [];
  let maxId = 0;

  const lines = raw.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim().length === 0) continue;

    try {
      const entry = parseJournalLine(line);
      entries.push(entry);
      if (entry.id > maxId) {
        maxId = entry.id;
      }
    } catch (error) {
      quarantined.push({
        lineNumber: i + 1,
        error: error instanceof Error ? error.message : String(error),
        raw: line,
      });
    }
  }

  return { entries, maxId, quarantined };
}

function parseJournalLine(line: string): JournalEntry {
  const parsed = JSON.parse(line) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('entry is not an object');
  }

  const entry = parsed as Partial<JournalEntry>;
  if (entry.type !== 'message' && entry.type !== 'compaction') {
    throw new Error('entry type must be "message" or "compaction"');
  }
  if (typeof entry.id !== 'number' || !Number.isFinite(entry.id)) {
    throw new Error('entry id must be a finite number');
  }
  if (typeof entry.channelId !== 'string' || entry.channelId.length === 0) {
    throw new Error('entry channelId must be a non-empty string');
  }
  if (typeof entry.timestamp !== 'number' || !Number.isFinite(entry.timestamp)) {
    throw new Error('entry timestamp must be a finite number');
  }

  return entry as JournalEntry;
}

export function quarantineSidecarPath(filePath: string): string {
  return `${filePath}.quarantine`;
}

export function persistQuarantinedEntries(
  filePath: string,
  quarantined: QuarantinedJournalEntry[],
): void {
  const quarantinePath = quarantineSidecarPath(filePath);
  if (quarantined.length === 0) {
    if (existsSync(quarantinePath)) {
      unlinkSync(quarantinePath);
    }
    return;
  }

  const body = quarantined.map(entry => JSON.stringify(entry)).join('\n') + '\n';
  writeFileSync(quarantinePath, body, 'utf-8');
}

export function readJournalFile(
  filePath: string,
  options: ReadJournalFileOptions = {},
): ReadJournalResult {
  if (!existsSync(filePath)) {
    return { entries: [], maxId: 0, quarantined: [] };
  }
  const raw = readFileSync(filePath, 'utf-8');
  const parsed = parseJournalText(raw);
  if (options.persistQuarantine !== false) {
    try {
      persistQuarantinedEntries(filePath, parsed.quarantined);
    } catch {
      // Quarantine sidecar write failure should never block journal loading.
    }
  }
  return parsed;
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
