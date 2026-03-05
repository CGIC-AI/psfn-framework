// ── User Continuity Store ──
// Per-user index of recent messages across ALL channels for cross-channel context.
// Each user gets a single JSONL file: user_<userId>.jsonl
// This is a secondary index — the primary audit trail stays in per-channel JSONL files.

import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitizeChannelId } from './store.js';
import type { SessionEntry } from './types.js';
import { createComponentLogger } from '../logger.js';
import {
  classifyChannel,
  visibilitiesShareContinuity,
  type ChannelMeta,
} from '../trust/policy.js';
import type { ChannelVisibility } from '../trust/types.js';
import {
  appendJournalEntry,
  buildMessageJournalEntry,
  journalToSessionEntry,
  readJournalFile,
} from './journal-utils.js';

const log = createComponentLogger('UserContinuity');

/** Default cap for continuity entries per user. */
const DEFAULT_CONTINUITY_LIMIT = 20;
const DEFAULT_ACTIVE_CHANNEL_WINDOW_MS = 30 * 60 * 1000;

interface UserCache {
  entries: SessionEntry[];
  nextId: number;
  filePath: string;
}

export interface ActiveContinuityChannel {
  channelId: string;
  channelVisibility: ChannelVisibility;
  lastTimestamp: number;
}

export interface ActiveChannelQuery {
  excludeChannelId?: string;
  withinMs?: number;
  nowMs?: number;
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
      const { entries, maxId } = readJournalFile(fp);
      for (const entry of entries) {
        const message = journalToSessionEntry(entry);
        if (message) {
          cache.entries.push(message);
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
    const id = cache.nextId;

    const full: SessionEntry = { ...entry, id };
    if (!full.channelVisibility) {
      full.channelVisibility = classifyChannel(entry.channelId);
    }

    const journal = buildMessageJournalEntry(id, full);
    appendJournalEntry(cache.filePath, journal);

    cache.nextId = id + 1;
    cache.entries.push(full);

    // Cap in-memory entries to maxEntries (JSONL file keeps all for audit)
    if (cache.entries.length > this.maxEntries) {
      cache.entries = cache.entries.slice(-this.maxEntries);
    }

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

  /**
   * Return active channels seen for a user within a recent time window.
   * Used by session mirroring to fan out lightweight mirror notes.
   */
  getActiveChannels(
    userId: string,
    query: ActiveChannelQuery = {},
  ): ActiveContinuityChannel[] {
    const cache = this.ensureUser(userId);
    if (cache.entries.length === 0) return [];

    const nowMs = query.nowMs ?? Date.now();
    const withinMs = Math.max(0, query.withinMs ?? DEFAULT_ACTIVE_CHANNEL_WINDOW_MS);
    const byChannel = new Map<string, ActiveContinuityChannel>();

    for (const entry of cache.entries) {
      const channelId = entry.originChannelId ?? entry.channelId;
      if (query.excludeChannelId && channelId === query.excludeChannelId) continue;
      if (withinMs > 0 && nowMs - entry.timestamp > withinMs) continue;

      const channelVisibility = parseChannelVisibility(entry.channelVisibility) ?? classifyChannel(channelId);
      const existing = byChannel.get(channelId);
      if (!existing || existing.lastTimestamp < entry.timestamp) {
        byChannel.set(channelId, {
          channelId,
          channelVisibility,
          lastTimestamp: entry.timestamp,
        });
      }
    }

    return [...byChannel.values()].sort((left, right) => {
      const timestampDelta = right.lastTimestamp - left.lastTimestamp;
      if (timestampDelta !== 0) return timestampDelta;
      return left.channelId.localeCompare(right.channelId);
    });
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
