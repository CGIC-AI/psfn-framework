import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, CompactionSummary, JournalEntry } from './types.js';

interface ChannelCache {
  entries: SessionEntry[];
  compactions: CompactionSummary[];
  nextId: number;
}

/** Sanitize a channelId into a safe filename component. */
function sanitizeChannelId(channelId: string): string {
  return channelId.replace(/\//g, '_').replace(/:/g, '-');
}

export class SessionStore {
  private sessionsDir: string;
  private channels: Map<string, ChannelCache> = new Map();

  constructor(sessionsDir: string) {
    this.sessionsDir = sessionsDir;
    mkdirSync(sessionsDir, { recursive: true });
  }

  private filePath(channelId: string): string {
    return join(this.sessionsDir, sanitizeChannelId(channelId) + '.jsonl');
  }

  private ensureChannel(channelId: string): ChannelCache {
    let cache = this.channels.get(channelId);
    if (cache) return cache;

    cache = { entries: [], compactions: [], nextId: 1 };
    const fp = this.filePath(channelId);

    if (existsSync(fp)) {
      const raw = readFileSync(fp, 'utf-8');
      const lines = raw.split('\n').filter(l => l.length > 0);
      let maxId = 0;

      for (const line of lines) {
        const j: JournalEntry = JSON.parse(line);
        if (j.id > maxId) maxId = j.id;

        if (j.type === 'message') {
          cache.entries.push({
            id: j.id,
            channelId: j.channelId,
            role: j.role!,
            content: j.content!,
            authorId: j.authorId,
            authorName: j.authorName,
            timestamp: j.timestamp,
            metadata: j.metadata,
          });
        } else if (j.type === 'compaction') {
          cache.compactions.push({
            id: j.id,
            channelId: j.channelId,
            summary: j.summary!,
            coveredUpTo: j.coveredUpTo!,
            createdAt: j.timestamp,
          });
        }
      }

      cache.nextId = maxId + 1;
    }

    this.channels.set(channelId, cache);
    return cache;
  }

  append(entry: Omit<SessionEntry, 'id'>): number {
    const cache = this.ensureChannel(entry.channelId);
    const id = cache.nextId++;

    const full: SessionEntry = { ...entry, id };
    cache.entries.push(full);

    const journal: JournalEntry = {
      type: 'message',
      id,
      channelId: entry.channelId,
      role: entry.role,
      content: entry.content,
      authorId: entry.authorId,
      authorName: entry.authorName,
      timestamp: entry.timestamp,
      metadata: entry.metadata,
    };
    appendFileSync(this.filePath(entry.channelId), JSON.stringify(journal) + '\n');

    return id;
  }

  getRecent(channelId: string, limit: number): SessionEntry[] {
    const cache = this.ensureChannel(channelId);
    if (cache.entries.length <= limit) return [...cache.entries];
    return cache.entries.slice(-limit);
  }

  count(channelId: string): number {
    return this.ensureChannel(channelId).entries.length;
  }

  getCompactionSummaries(channelId: string): CompactionSummary[] {
    return [...this.ensureChannel(channelId).compactions];
  }

  insertCompaction(channelId: string, summary: string, coveredUpTo: number): void {
    const cache = this.ensureChannel(channelId);
    const id = cache.nextId++;
    const now = Date.now();

    cache.compactions.push({ id, channelId, summary, coveredUpTo, createdAt: now });

    const journal: JournalEntry = {
      type: 'compaction',
      id,
      channelId,
      summary,
      coveredUpTo,
      timestamp: now,
    };
    appendFileSync(this.filePath(channelId), JSON.stringify(journal) + '\n');
  }
}
