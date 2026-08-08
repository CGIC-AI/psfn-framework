import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, CompactionSummary } from '../../../core/session/types.js';
import { inferSessionChannelType } from '../../../core/session/session-id.js';
import {
  normalizeOptionalHmac,
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalSessionEntryRole,
  normalizeOptionalString,
  type ChannelCache,
  type ChannelIndexEntry,
} from '../store-primitives.js';
import type { ResolvedIndexedSession } from './channel-index.js';
import type { SessionJournalRuntime } from './journal-runtime.js';
import { indexedChannelId } from './session-index-keys.js';
import {
  buildRecentEntriesFingerprint,
  syncLightweightSessionCacheFromIndex,
} from './session-chain-cache.js';


export interface SessionCursorOperationsContext {
  readonly sessionsDir: string;
  readonly journalRuntime: SessionJournalRuntime;
  refreshChannelIndexFromDisk(): void;
  primeChannelIndexFromDisk(): void;
  resolveSessionId(channelId: string): string | null;
  resolveExistingSession(channelId: string): ResolvedIndexedSession | null;
  getLoadedCache(channelId: string): ChannelCache | undefined;
  loadExistingChannelCache(channelId: string): ChannelCache | null;
  ensureChannelFullyLoaded(channelId: string): ChannelCache | null;
  resolveJournalAuthoritativeTurnTombstones(params: {
    sessionId: string;
    channelId: string;
    filePaths: readonly string[];
    cache?: ChannelCache;
  }): ReadonlySet<string>;
  ensureChannelIndexEntry(
    sessionId: string,
    channelId: string,
    filePaths: readonly string[],
  ): ChannelIndexEntry;
  fullyLoadedCacheIsCurrent(cache: ChannelCache): boolean;
  fingerprintArchive(cache: ChannelCache): string | null;
  getChannelIndexEntries(): [string, ChannelIndexEntry][];
}

const MAX_RECENT_ENTRY_CACHE_LIMITS = 8;
export interface LatestSessionSummary {
  sessionId: string;
  timestamp: number;
  channelType?: string;
  lastRole: SessionEntry['role'];
}
export interface SessionActivitySummary {
  sessionId: string;
  channelId: string;
  channelType?: string;
  lastActivityAt: number;
  messageCount: number;
  lastRole: SessionEntry['role'];
  lastAuthorName?: string;
  lastMessagePreview: string;
}
type EntriesBeforeReadPlan =
  | { kind: 'complete'; entries: SessionEntry[] }
  | {
      kind: 'archive';
      channelId: string;
      filePath: string;
      beforeId: number;
      limit: number;
      tombstones: ReadonlySet<string>;
      // Load-bearing only for the asynchronous request-time revalidation path
      // (getEntriesBeforeAsync): a missing fingerprint means an L0 mutation
      // mid-read cannot be detected, so that path fails closed. The synchronous
      // getEntriesBefore does not revalidate and reads without it, so this stays
      // optional here (psfn-framework-k4uei).
      archiveFingerprint?: string;
    };
const ASYNC_ENTRIES_BEFORE_AUTHORITY_LIMITS = Object.freeze({
  retries: 2,
});
function entriesBeforeAuthorityMatches(
  expected: Extract<EntriesBeforeReadPlan, { kind: 'archive' }>,
  observed: Extract<EntriesBeforeReadPlan, { kind: 'archive' }>,
): boolean {
  return expected.channelId === observed.channelId
    && expected.filePath === observed.filePath
    && expected.beforeId === observed.beforeId
    && expected.limit === observed.limit
    && expected.archiveFingerprint === observed.archiveFingerprint
    && expected.tombstones.size === observed.tombstones.size
    && [...expected.tombstones].every(turnId => observed.tombstones.has(turnId));
}

export class SessionCursorOperations {
  constructor(private readonly context: SessionCursorOperationsContext) {}
  private readRecentEntriesFromTail(
    channelId: string,
    filePaths: readonly string[],
    limit: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    return this.context.journalRuntime.readRecentEntriesFromTailChain(
      filePaths.map(filePath => this.context.journalRuntime.openArchive(channelId, filePath)),
      limit,
      tombstones,
    );
  }
  private readEntriesBeforeFromArchive(
    channelId: string,
    filePath: string,
    beforeId: number,
    limit: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    return this.context.journalRuntime.readEntriesBefore(
      this.context.journalRuntime.openArchive(channelId, filePath),
      beforeId,
      limit,
      tombstones,
    );
  }
  private async readEntriesBeforeFromArchiveAsync(
    channelId: string,
    filePath: string,
    beforeId: number,
    limit: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): Promise<SessionEntry[]> {
    return await this.context.journalRuntime.readEntriesBeforeAsync(
      this.context.journalRuntime.openArchive(channelId, filePath),
      beforeId,
      limit,
      tombstones,
    );
  }
  private readCachedRecentEntries(
    cache: ChannelCache,
    limit: number,
    archiveFingerprint: string | null,
  ): SessionEntry[] | null {
    const cached = cache.recentEntriesByLimit.get(limit);
    if (!cached) return null;
    if (cached.fingerprint !== buildRecentEntriesFingerprint(cache)) return null;
    if (cached.archiveFingerprint !== archiveFingerprint) return null;
    return [...cached.entries];
  }
  private writeCachedRecentEntries(
    cache: ChannelCache,
    limit: number,
    entries: SessionEntry[],
    archiveFingerprintBeforeRead: string | null,
  ): void {
    if (cache.fullyLoaded) return;
    const archiveFingerprint = this.context.fingerprintArchive(cache);
    if (!archiveFingerprint || archiveFingerprint !== archiveFingerprintBeforeRead) {
      return;
    }
    cache.recentEntriesByLimit.set(limit, {
      fingerprint: buildRecentEntriesFingerprint(cache),
      archiveFingerprint,
      entries: [...entries],
    });
    while (cache.recentEntriesByLimit.size > MAX_RECENT_ENTRY_CACHE_LIMITS) {
      const oldestKey = cache.recentEntriesByLimit.keys().next().value;
      if (oldestKey === undefined) break;
      cache.recentEntriesByLimit.delete(oldestKey);
    }
  }
  getRecent(channelId: string, limit: number): SessionEntry[] {
    this.context.refreshChannelIndexFromDisk();
    if (limit <= 0) return [];
    this.context.refreshChannelIndexFromDisk();
    const cached = this.context.getLoadedCache(channelId) ?? this.context.loadExistingChannelCache(channelId);
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    if (cached?.fullyLoaded) {
      if (this.context.fullyLoadedCacheIsCurrent(cached)) {
        if (cached.entries.length <= limit) return [...cached.entries];
        return cached.entries.slice(-limit);
      }
    }
    const resolved = this.context.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
        filePath: cached.resolvedPath,
      }
      : null);
    if (!resolved) return [];
    const indexEntry = this.context.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
    if (cached) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.context.sessionsDir });
    }
    const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
    if (messageCount === 0) return [];
    const tombstones = this.context.resolveJournalAuthoritativeTurnTombstones({
      sessionId: resolved.sessionId,
      channelId: resolved.channelId,
      filePaths: resolved.filePaths,
      cache: cached ?? undefined,
    });
    const archiveFingerprintBeforeRead = cached ? this.context.fingerprintArchive(cached) : null;
    const recentCacheHit = cached
      ? this.readCachedRecentEntries(cached, limit, archiveFingerprintBeforeRead)
      : null;
    if (recentCacheHit) {
      return recentCacheHit;
    }
    const recentEntries = this.readRecentEntriesFromTail(
      resolved.channelId,
      resolved.filePaths,
      limit,
      tombstones,
    );
    if (cached) {
      this.writeCachedRecentEntries(cached, limit, recentEntries, archiveFingerprintBeforeRead);
    }
    return recentEntries;
  }
  getLastEntry(channelId: string): SessionEntry | undefined {
    const entries = this.getRecent(channelId, 1);
    return entries[entries.length - 1];
  }
  findLatestEntries(
    channelId: string,
    predicate: (entry: SessionEntry) => boolean,
    limit = 1,
    options: { stopBeforeTimestamp?: number } = {},
  ): SessionEntry[] {
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedLimit <= 0) return [];
    const stopBeforeTimestamp = options.stopBeforeTimestamp;
    if (stopBeforeTimestamp !== undefined && !Number.isFinite(stopBeforeTimestamp)) {
      throw new Error('stopBeforeTimestamp must be finite when provided');
    }
    const matchesWindow = stopBeforeTimestamp === undefined
      ? predicate
      : (entry: SessionEntry): boolean => (
        entry.timestamp >= stopBeforeTimestamp && predicate(entry)
      );
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    const cached = this.context.getLoadedCache(sessionId) ?? this.context.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded || (cached?.activeTurnTombstoneCount ?? 0) > 0) {
      const full = cached?.fullyLoaded ? cached : this.context.ensureChannelFullyLoaded(channelId);
      return full ? full.entries.filter(matchesWindow).slice(-normalizedLimit).reverse() : [];
    }
    const resolved = cached
      ? { channelId: cached.channelId, filePath: cached.resolvedPath }
      : this.context.resolveExistingSession(channelId);
    if (!resolved) return [];
    const found = this.context.journalRuntime.findLatestEntries(
      this.context.journalRuntime.openArchive(resolved.channelId, resolved.filePath),
      predicate,
      normalizedLimit,
      stopBeforeTimestamp,
    );
    if (found) return found;
    const full = this.context.ensureChannelFullyLoaded(channelId);
    return full ? full.entries.filter(matchesWindow).slice(-normalizedLimit).reverse() : [];
  }
  private prepareEntriesBeforeRead(
    channelId: string,
    beforeId: number,
    limit: number,
  ): EntriesBeforeReadPlan {
    this.context.refreshChannelIndexFromDisk();
    if (!Number.isFinite(beforeId) || !Number.isFinite(limit)) {
      return { kind: 'complete', entries: [] };
    }
    const normalizedBeforeId = Math.max(0, Math.floor(beforeId));
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedBeforeId <= 0 || normalizedLimit <= 0) {
      return { kind: 'complete', entries: [] };
    }

    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    const cached = this.context.getLoadedCache(sessionId) ?? this.context.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded) {
      const current = this.context.fullyLoadedCacheIsCurrent(cached)
        ? cached
        : this.context.ensureChannelFullyLoaded(channelId);
      if (!current) return { kind: 'complete', entries: [] };
      const eligible = current.entries.filter(entry => entry.id < normalizedBeforeId);
      return {
        kind: 'complete',
        entries: eligible.length <= normalizedLimit ? eligible : eligible.slice(-normalizedLimit),
      };
    }

    const resolved = cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
        filePath: cached.resolvedPath,
      }
      : this.context.resolveExistingSession(channelId);
    if (!resolved) return { kind: 'complete', entries: [] };
    const indexEntry = this.context.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached && !cached.fullyLoaded) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.context.sessionsDir });
    }
    if ((normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0) === 0) {
      return { kind: 'complete', entries: [] };
    }

    const activeTurnTombstoneCount = normalizeOptionalNonNegativeNumber(indexEntry.activeTurnTombstoneCount) ?? 0;
    const indexedTurnTombstones = new Set(indexEntry.activeTurnTombstoneIds ?? []);
    // Legacy/incomplete tombstone metadata cannot safely drive a bounded
    // privacy filter. Fall back to canonical replay only for that stale shape.
    if (activeTurnTombstoneCount > 0 && indexedTurnTombstones.size !== activeTurnTombstoneCount) {
      const full = this.context.ensureChannelFullyLoaded(channelId);
      if (!full) return { kind: 'complete', entries: [] };
      const eligible = full.entries.filter(entry => entry.id < normalizedBeforeId);
      return {
        kind: 'complete',
        entries: eligible.length <= normalizedLimit ? eligible : eligible.slice(-normalizedLimit),
      };
    }
    // The archive fingerprint is only consumed by the asynchronous
    // request-time revalidation in getEntriesBeforeAsync; a missing fingerprint
    // is failed closed there, not here. Keeping the check off this shared helper
    // means the synchronous getEntriesBefore (auto-compaction, ICP projection),
    // which never revalidates, does not inherit that fail-closed behavior it was
    // never meant to have (psfn-framework-k4uei).
    const archiveFingerprint = normalizeOptionalString(indexEntry.archiveFingerprint);
    return {
      kind: 'archive',
      channelId: resolved.channelId,
      filePath: resolved.filePath,
      beforeId: normalizedBeforeId,
      limit: normalizedLimit,
      tombstones: indexedTurnTombstones,
      ...(archiveFingerprint ? { archiveFingerprint } : {}),
    };
  }
  getEntriesBefore(channelId: string, beforeId: number, limit: number): SessionEntry[] {
    const plan = this.prepareEntriesBeforeRead(channelId, beforeId, limit);
    if (plan.kind === 'complete') return plan.entries;
    return this.readEntriesBeforeFromArchive(
      plan.channelId,
      plan.filePath,
      plan.beforeId,
      plan.limit,
      plan.tombstones,
    );
  }
  async getEntriesBeforeAsync(
    channelId: string,
    beforeId: number,
    limit: number,
  ): Promise<SessionEntry[]> {
    let plan = this.prepareEntriesBeforeRead(channelId, beforeId, limit);
    for (
      let attempt = 0;
      attempt <= ASYNC_ENTRIES_BEFORE_AUTHORITY_LIMITS.retries;
      attempt += 1
    ) {
      if (plan.kind === 'complete') return plan.entries;
      if (!plan.archiveFingerprint) {
        // Async request-time reads revalidate the returned page against the
        // archive fingerprint after the cooperative read (see the retry below).
        // Without a fingerprint that authority check cannot detect an L0
        // mutation mid-read, so fail closed here — this is the throw's intended
        // scope, narrowed off the shared prepareEntriesBeforeRead so the
        // synchronous path is unaffected (psfn-framework-k4uei).
        throw new Error(
          `Cannot establish bounded-read journal authority for L0 session ${channelId}`,
        );
      }
      const entries = await this.readEntriesBeforeFromArchiveAsync(
        plan.channelId,
        plan.filePath,
        plan.beforeId,
        plan.limit,
        plan.tombstones,
      );
      const observed = this.prepareEntriesBeforeRead(channelId, beforeId, limit);
      if (observed.kind === 'complete') return observed.entries;
      if (entriesBeforeAuthorityMatches(plan, observed)) return entries;
      plan = observed;
    }
    throw new Error(
      `L0 session ${channelId} changed repeatedly during an asynchronous bounded read; `
      + 'refusing to return a page under stale turn-tombstone authority',
    );
  }
  getEntriesInRange(channelId: string, startId: number, endId: number): SessionEntry[] {
    this.context.refreshChannelIndexFromDisk();
    if (!Number.isFinite(startId) || !Number.isFinite(endId)) return [];
    const normalizedStart = Math.max(0, Math.floor(Math.min(startId, endId)));
    const normalizedEnd = Math.max(0, Math.floor(Math.max(startId, endId)));
    if (normalizedEnd < normalizedStart) return [];
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    const cached = this.context.getLoadedCache(channelId) ?? this.context.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded && this.context.fullyLoadedCacheIsCurrent(cached)) {
      return cached.entries.filter(entry => entry.id >= normalizedStart && entry.id <= normalizedEnd);
    }
    const resolved = this.context.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
      }
      : null);
    if (!resolved) return [];
    const indexEntry = this.context.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached && !cached.fullyLoaded) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.context.sessionsDir });
    }
    const tombstones = this.context.resolveJournalAuthoritativeTurnTombstones({
      sessionId: resolved.sessionId,
      channelId: resolved.channelId,
      filePaths: resolved.filePaths,
      cache: cached ?? undefined,
    });
    if (
      resolved.filePaths.length === 1
      && tombstones.size === 0
      && normalizeOptionalHmac(indexEntry.lastHmac) === null
    ) {
      const found = this.context.journalRuntime.findEntriesInRange(
        this.context.journalRuntime.openArchive(resolved.channelId, resolved.filePaths[0]!),
        normalizedStart,
        normalizedEnd,
      );
      if (found) return found;
    }
    return this.context.journalRuntime.readEntriesInRangeFromChain(
      resolved.filePaths.map(filePath => this.context.journalRuntime.openArchive(resolved.channelId, filePath)),
      normalizedStart,
      normalizedEnd,
      tombstones,
    );
  }
  getRecentDiscordMessageIds(channelId: string, limit: number): Set<string> {
    const entries = this.getRecent(channelId, limit);
    const ids = entries
      .map((entry) => entry.discordMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return new Set(ids);
  }
  count(channelId: string): number {
    this.context.refreshChannelIndexFromDisk();
    let cached = this.context.getLoadedCache(channelId);
    // Frozen fullyLoaded caches must not serve counts across a sibling
    // process's journal rewrite (same fingerprint gate as entry reads).
    if (cached?.fullyLoaded && !this.context.fullyLoadedCacheIsCurrent(cached)) {
      cached = this.context.ensureChannelFullyLoaded(channelId) ?? cached;
    }
    if (cached) return cached.messageCount;
    const resolved = this.context.resolveExistingSession(channelId);
    if (!resolved) return 0;
    const indexEntry = this.context.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
    return normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
  }
  getCompactionSummaries(channelId: string): CompactionSummary[] {
    this.context.refreshChannelIndexFromDisk();
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    const cached = this.context.getLoadedCache(channelId) ?? this.context.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded && this.context.fullyLoadedCacheIsCurrent(cached)) {
      return [...cached.compactions];
    }
    const resolved = this.context.resolveExistingSession(channelId) ?? (cached
      ? { sessionId, channelId: cached.channelId, filePaths: cached.archivePaths }
      : null);
    if (!resolved) return [];
    const indexEntry = this.context.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached && !cached.fullyLoaded) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.context.sessionsDir });
    }
    const compactionArchivePaths = new Set(
      (indexEntry.compactionFilenames ?? []).map(filename => join(this.context.sessionsDir, filename)),
    );
    return this.context.journalRuntime.readCompactionSummariesFromChain(
      resolved.filePaths.map(filePath => this.context.journalRuntime.openArchive(resolved.channelId, filePath)),
      compactionArchivePaths,
    );
  }
  getSessionActivity(channelId: string): SessionActivitySummary | null {
    this.context.refreshChannelIndexFromDisk();
    const sessionId = this.context.resolveSessionId(channelId) ?? channelId;
    let cached = this.context.getLoadedCache(channelId) ?? this.context.loadExistingChannelCache(channelId);
    // Same fingerprint gate as count(): a frozen fullyLoaded cache must not
    // serve activity metadata across a sibling process's journal rewrite.
    if (cached?.fullyLoaded && !this.context.fullyLoadedCacheIsCurrent(cached)) {
      cached = this.context.ensureChannelFullyLoaded(channelId) ?? cached;
    }
    if (cached && cached.messageCount > 0 && cached.lastMessageTimestamp > 0 && cached.lastMessageRole) {
      return {
        sessionId,
        channelId: cached.channelId,
        channelType: inferSessionChannelType(cached.channelId),
        lastActivityAt: cached.lastMessageTimestamp,
        messageCount: cached.messageCount,
        lastRole: cached.lastMessageRole,
        lastAuthorName: cached.lastMessageAuthorName,
        lastMessagePreview: cached.lastMessagePreview,
      };
    }

    const resolved = this.context.resolveExistingSession(channelId);
    if (!resolved) return null;
    const indexEntry = this.context.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
    const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
    const lastActivityAt = normalizeOptionalNonNegativeNumber(indexEntry.lastMessageTimestamp) ?? 0;
    const lastRole = normalizeOptionalSessionEntryRole(indexEntry.lastMessageRole);
    if (messageCount <= 0 || lastActivityAt <= 0 || !lastRole) return null;
    return {
      sessionId,
      channelId: resolved.channelId,
      channelType: inferSessionChannelType(resolved.channelId),
      lastActivityAt,
      messageCount,
      lastRole,
      lastAuthorName: normalizeOptionalString(indexEntry.lastMessageAuthorName),
      lastMessagePreview: normalizeOptionalString(indexEntry.lastMessagePreview) ?? '',
    };
  }
  listSessionsByRecentActivity(limit = 20, offset = 0): SessionActivitySummary[] {
    if (limit <= 0 || offset < 0) return [];
    this.context.primeChannelIndexFromDisk();
    const sessions: SessionActivitySummary[] = [];

    // Ensuring a stale entry may atomically replace the backing Map. Iterate a
    // stable snapshot so that replacement cannot revisit already-seen rows.
    for (const [sessionId, indexEntry] of this.context.getChannelIndexEntries()) {
      const logicalChannelId = indexedChannelId(sessionId, indexEntry);
      const filePaths = indexEntry.filenames.map(filename => join(this.context.sessionsDir, filename));
      if (filePaths.some(filePath => !existsSync(filePath))) continue;

      const ensured = this.context.ensureChannelIndexEntry(sessionId, logicalChannelId, filePaths);
      const messageCount = normalizeOptionalNonNegativeNumber(ensured.messageCount) ?? 0;
      if (messageCount <= 0) continue;

      const summary = this.getSessionActivity(sessionId);
      if (!summary) continue;
      sessions.push(summary);
    }

    sessions.sort((left, right) => {
      if (right.lastActivityAt !== left.lastActivityAt) {
        return right.lastActivityAt - left.lastActivityAt;
      }
      return left.sessionId.localeCompare(right.sessionId);
    });

    return sessions.slice(offset, offset + limit);
  }
  getLatestSessionByTimestamp(): LatestSessionSummary | null {
    const latest = this.listSessionsByRecentActivity(1)[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index may be undefined at runtime
    if (!latest) return null;
    return {
      sessionId: latest.sessionId,
      timestamp: latest.lastActivityAt,
      channelType: latest.channelType,
      lastRole: latest.lastRole,
    };
  }
  listChannels(): Array<{ sessionId: string; channelId: string; messageCount: number }> {
    this.context.primeChannelIndexFromDisk();
    const channels: Array<{ sessionId: string; channelId: string; messageCount: number }> = [];
    // `ensureChannelIndexEntry` can replace the local Map after an index
    // repair; snapshot iteration prevents duplicate rows in this one listing.
    for (const [sessionId, indexEntry] of this.context.getChannelIndexEntries()) {
      const logicalChannelId = indexedChannelId(sessionId, indexEntry);
      const filePaths = indexEntry.filenames.map(filename => join(this.context.sessionsDir, filename));
      if (filePaths.some(filePath => !existsSync(filePath))) continue;
      const ensured = this.context.ensureChannelIndexEntry(sessionId, logicalChannelId, filePaths);
      channels.push({
        sessionId,
        channelId: logicalChannelId,
        messageCount: normalizeOptionalNonNegativeNumber(ensured.messageCount) ?? 0,
      });
    }
    return channels;
  }
}
