// ── User Continuity Store ──
// Per-user index of recent messages across ALL channels for cross-channel context.
// Each user gets a single JSONL file: user_<userId>.jsonl
// This is a secondary index — the primary audit trail stays in per-channel JSONL files.

import { mkdirSync, readFileSync, appendFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeChannelId } from './store.js';
import type { SessionEntry, JournalEntry } from './types.js';
import { createComponentLogger } from '../logger.js';
import {
  classifyChannel,
  visibilitiesShareContinuity,
  type ChannelMeta,
} from '../trust/policy.js';
import type { ChannelVisibility } from '../trust/types.js';

const log = createComponentLogger('UserContinuity');

/** Default cap for continuity entries per user. */
const DEFAULT_CONTINUITY_LIMIT = 20;

interface UserCache {
  entries: SessionEntry[];
  nextId: number;
  filePath: string;
}

export class UserContinuityStore {
  private sessionsDir: string;
  private maxEntries: number;
  private users: Map<string, UserCache> = new Map();

  constructor(sessionsDir: string, maxEntries: number = DEFAULT_CONTINUITY_LIMIT) {
    this.sessionsDir = sessionsDir;
    this.maxEntries = maxEntries;
    mkdirSync(sessionsDir, { recursive: true });
  }

  private userFilePath(userId: string): string {
    return join(this.sessionsDir, 'user_' + sanitizeChannelId(userId) + '.jsonl');
  }

  private ensureUser(userId: string): UserCache {
    let cache = this.users.get(userId);
    if (cache) return cache;

    const fp = this.userFilePath(userId);
    cache = { entries: [], nextId: 1, filePath: fp };

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
            originChannelId: (j as any).originChannelId,
            channelVisibility: (j as any).channelVisibility,
          });
        }
      }

      cache.nextId = maxId + 1;
    }

    this.users.set(userId, cache);
    return cache;
  }

  /**
   * Append a message to the user's continuity thread.
   * Automatically caps at maxEntries — oldest entries are evicted from memory
   * (but remain in the JSONL file on disk for audit purposes).
   */
  append(userId: string, entry: Omit<SessionEntry, 'id'>): number {
    const cache = this.ensureUser(userId);
    const id = cache.nextId++;

    const full: SessionEntry = { ...entry, id };
    if (!full.channelVisibility) {
      full.channelVisibility = classifyChannel(entry.channelId);
    }
    cache.entries.push(full);

    // Cap in-memory entries to maxEntries (JSONL file keeps all for audit)
    if (cache.entries.length > this.maxEntries) {
      cache.entries = cache.entries.slice(-this.maxEntries);
    }

    const journal: JournalEntry & { originChannelId?: string; channelVisibility?: string } = {
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

    // Include origin metadata if present
    if (entry.originChannelId) {
      journal.originChannelId = entry.originChannelId;
    }
    if (entry.channelVisibility) {
      journal.channelVisibility = entry.channelVisibility;
    }

    appendFileSync(cache.filePath, JSON.stringify(journal) + '\n');
    return id;
  }

  /**
   * Get recent messages from the user's continuity thread.
   * Optionally exclude entries from a specific channel to avoid duplicates
   * when merging with the current channel's local messages.
   */
  getRecent(
    userId: string,
    limit: number,
    excludeChannelId?: string,
    currentChannelId?: string,
    currentChannelMeta?: ChannelMeta,
  ): SessionEntry[] {
    const cache = this.ensureUser(userId);
    let entries = cache.entries;

    if (excludeChannelId) {
      entries = entries.filter(e => e.originChannelId !== excludeChannelId);
    }

    // If currentChannelId is provided, filter by visibility compatibility
    if (currentChannelId) {
      const currentVisibility = classifyChannel(currentChannelId, currentChannelMeta);
      entries = entries.filter(e => {
        const origin = e.originChannelId ?? e.channelId;
        const originVisibility = parseChannelVisibility(e.channelVisibility) ?? classifyChannel(origin);
        return visibilitiesShareContinuity(originVisibility, currentVisibility);
      });
    }

    if (entries.length <= limit) return [...entries];
    return entries.slice(-limit);
  }

  /** Get total message count for a user's continuity thread. */
  count(userId: string): number {
    return this.ensureUser(userId).entries.length;
  }
}

function parseChannelVisibility(value?: string): ChannelVisibility | undefined {
  switch (value) {
    case 'private':
    case 'semi_private':
    case 'public':
    case 'broadcast':
      return value;
    default:
      return undefined;
  }
}
