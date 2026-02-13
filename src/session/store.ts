import { mkdirSync, readFileSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, CompactionSummary, JournalEntry } from './types.js';

interface ChannelCache {
  entries: SessionEntry[];
  compactions: CompactionSummary[];
  nextId: number;
  resolvedPath: string; // actual file path used (may be legacy format)
}

/** Sanitize a channelId into a safe filename component using strict allowlist. */
export function sanitizeChannelId(channelId: string): string {
  return channelId.replace(/[^a-zA-Z0-9._-]/g, (ch) => {
    // encodeURIComponent produces %XX sequences using UTF-8 byte encoding
    // This handles multi-byte unicode correctly (e.g. € → %E2%82%AC)
    return encodeURIComponent(ch);
  });
}

/** Reverse sanitizeChannelId: decode %XX hex sequences back to original characters. */
export function unsanitizeChannelId(filename: string): string {
  return decodeURIComponent(filename);
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

  /** Legacy sanitization (pre-%XX encoding): : → -, / → _ */
  private legacyFilePath(channelId: string): string {
    const legacy = channelId.replace(/\//g, '_').replace(/:/g, '-');
    return join(this.sessionsDir, legacy + '.jsonl');
  }

  private ensureChannel(channelId: string): ChannelCache {
    let cache = this.channels.get(channelId);
    if (cache) return cache;

    const defaultFp = this.filePath(channelId);
    cache = { entries: [], compactions: [], nextId: 1, resolvedPath: defaultFp };
    let fp = defaultFp;

    // Fall back to legacy filename if new-format file doesn't exist
    if (!existsSync(fp)) {
      const legacyFp = this.legacyFilePath(channelId);
      if (existsSync(legacyFp)) {
        fp = legacyFp;
        cache.resolvedPath = legacyFp; // write to same file we loaded from
      }
    }

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
    appendFileSync(cache.resolvedPath, JSON.stringify(journal) + '\n');

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

  listChannels(): Array<{ channelId: string; messageCount: number }> {
    const files = readdirSync(this.sessionsDir).filter(f => f.endsWith('.jsonl'));
    for (const f of files) {
      const stem = f.slice(0, -6); // strip .jsonl

      // New-format files contain %XX sequences for special chars.
      // Files without % could be new-format (simple channelId) or old-format
      // (legacy : → -, / → _ sanitization). For unambiguous new-format files
      // (those with %), decode directly. For files without %, fall back to
      // reading the first JSONL line to get the real channelId.
      if (stem.includes('%')) {
        const decoded = unsanitizeChannelId(stem);
        if (!this.channels.has(decoded)) {
          this.ensureChannel(decoded);
        }
      } else {
        // Could be a simple channelId or old-format — check if already cached
        if (this.channels.has(stem)) continue;

        // Read first line to get the real channelId from journal data
        const fp = join(this.sessionsDir, f);
        const raw = readFileSync(fp, 'utf-8');
        const firstLine = raw.split('\n').find(l => l.length > 0);
        if (firstLine) {
          const entry = JSON.parse(firstLine) as { channelId: string };
          if (!this.channels.has(entry.channelId)) {
            this.ensureChannel(entry.channelId);
          }
        }
      }
    }
    return [...this.channels.entries()].map(([channelId, cache]) => ({
      channelId,
      messageCount: cache.entries.length,
    }));
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
    appendFileSync(cache.resolvedPath, JSON.stringify(journal) + '\n');
  }
}
