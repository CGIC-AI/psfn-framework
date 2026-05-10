import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, CompactionSummary, JournalEntry } from '../../core/session/types.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { createComponentLogger } from '../../shared/logger.js';
import {
  buildExtractionMarkerJournalEntry,
  buildCompactionJournalEntry,
  buildGracefulShutdownMarkerJournalEntry,
  buildMessageJournalEntry,
  buildTurnTombstoneJournalEntry,
} from '../journals/journal-utils.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  CHANNEL_INDEX_FILENAME,
  IMPORT_MANIFEST_FILENAME,
  createKeyringIntegrityProvider,
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalSessionEntryRole,
  normalizeOptionalString,
  sanitizeChannelId,
  unsanitizeChannelId,
  type ChannelCache,
  type ChannelIndexEntry,
  type CrashRecoveryExtractionCandidate,
  type LegacyChatImportManifest,
  type LegacyChatImportManifestFilter,
  type LegacyChatImportRequest,
  type LegacyChatImportResult,
  type SessionFileSeed,
  type SessionStoreOptions,
} from './store-primitives.js';
import { inferSessionChannelType } from '../../core/session/session-id.js';
import {
  type SessionSearchHit,
  supportsKeywordSearch,
  type TranscriptProjectionPort,
} from './transcript-projection-port.js';
import {
  createDefaultSQLiteSessionArchivePort,
  createDefaultSQLiteTranscriptProjection,
  createDefaultSQLiteTurnRecordStorePort,
  DEFAULT_SQLITE_SESSION_SEARCH_INDEX_FILENAME,
} from './sqlite-adapters.js';
import type { TurnRecordStorePort } from './turn-record-store-port.js';
import type { TranscriptSearchPort } from './transcript-search-port.js';
import {
  getCrashRecoveryExtractionCandidates,
  getUncleanShutdownChannels,
  isGracefulShutdownEntry,
} from './store/crash-recovery.js';
import {
  createLightweightCache,
  ensureChannelIndexEntry,
  migrateLegacyFilenames,
  primeChannelIndexFromDisk,
  rehydrateLastJournalEntry,
  resolveExistingSession,
  snapshotIndexEntry,
  upsertChannelIndex,
  loadChannelIndex,
} from './store/channel-index.js';
import {
  buildLegacyImportMetadata,
  listLegacyImportManifests,
  readImportManifests,
  runLegacyChatImport,
} from './store/legacy-import.js';
import { SessionJournalRuntime } from './store/journal-runtime.js';
import { resolveSessionEntryTurnContext } from '../../core/session/turn-provenance.js';
import { backfillLegacyTurnId, parseTurnId } from '../../core/turns/id.js';
import { indexedChannelId, resolvePrimarySessionId } from './store/session-index-keys.js';
const log = createComponentLogger('SessionStore');
const MAX_RECENT_ENTRY_CACHE_LIMITS = 8;
const JOURNAL_WRITE_LOCK_SUFFIX = '.write-lock';
const JOURNAL_WRITE_LOCK_POLL_MS = 10;
const JOURNAL_WRITE_LOCK_STALE_MS = 30_000;
const JOURNAL_WRITE_LOCK_TIMEOUT_MS = 5_000;
const JOURNAL_WRITE_SLEEP_STATE = new Int32Array(new SharedArrayBuffer(4));
export {
  sanitizeChannelId,
  unsanitizeChannelId,
};
export type {
  CrashRecoveryExtractionCandidate,
  LegacyChatImportManifest,
  LegacyChatImportManifestFilter,
  LegacyChatImportRequest,
  LegacyChatImportRange,
  LegacyChatImportResult,
  SessionIntegrityProvider,
  SessionStoreOptions,
} from './store-primitives.js';

export interface LatestSessionSummary {
  sessionId: string;
  timestamp: number;
  channelType?: string;
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

const DEFAULT_MESSAGE_PREVIEW_CHARS = 120;

function toMessagePreview(content: string, maxChars = DEFAULT_MESSAGE_PREVIEW_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

function applyLastMessageMetadata(
  cache: ChannelCache,
  entry: Pick<SessionEntry, 'timestamp' | 'role' | 'authorName' | 'content'>,
): void {
  cache.lastMessageTimestamp = entry.timestamp;
  cache.lastMessageRole = entry.role;
  cache.lastMessageAuthorName = entry.authorName;
  cache.lastMessagePreview = toMessagePreview(entry.content);
}

function clearLastMessageMetadata(cache: ChannelCache): void {
  cache.lastMessageTimestamp = 0;
  cache.lastMessageRole = null;
  cache.lastMessageAuthorName = undefined;
  cache.lastMessagePreview = '';
}

function syncLastMessageMetadataFromEntries(cache: ChannelCache): void {
  const lastEntry = cache.entries.at(-1);
  if (!lastEntry) {
    clearLastMessageMetadata(cache);
    return;
  }
  applyLastMessageMetadata(cache, lastEntry);
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  Atomics.wait(JOURNAL_WRITE_SLEEP_STATE, 0, 0, ms);
}

function journalWriteLockPath(filePath: string): string {
  return `${filePath}${JOURNAL_WRITE_LOCK_SUFFIX}`;
}

function clearStaleJournalWriteLock(lockPath: string): boolean {
  try {
    const stats = statSync(lockPath);
    if (Date.now() - stats.mtimeMs <= JOURNAL_WRITE_LOCK_STALE_MS) {
      return false;
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return false;
    throw error;
  }

  rmSync(lockPath, { recursive: true, force: true });
  return true;
}

function withJournalWriteLock<T>(filePath: string, operation: () => T): T {
  const lockPath = journalWriteLockPath(filePath);
  const deadline = Date.now() + JOURNAL_WRITE_LOCK_TIMEOUT_MS;

  for (;;) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') {
        throw error;
      }
      if (clearStaleJournalWriteLock(lockPath)) {
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`Timed out acquiring session journal write lock for ${filePath}`);
      }
      sleepSync(JOURNAL_WRITE_LOCK_POLL_MS);
    }
  }

  try {
    return operation();
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

export class SessionStore implements TranscriptSearchPort {
  private sessionsDir: string;
  private channels: Map<string, ChannelCache> = new Map();
  private channelIndex: Map<string, ChannelIndexEntry> = new Map();
  private channelIndexPath: string;
  private importManifestPath: string;
  private transcriptProjection: TranscriptProjectionPort | null = null;
  private transcriptSearch: TranscriptSearchPort | null = null;
  private turnRecordStore: TurnRecordStorePort;
  private journalRuntime: SessionJournalRuntime;
  constructor(sessionsDir: string, options: SessionStoreOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.channelIndexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
    this.importManifestPath = join(sessionsDir, IMPORT_MANIFEST_FILENAME);
    const integrityProvider = options.integrityProvider
      ?? createKeyringIntegrityProvider(options.integrityKeyring ?? null);
    this.journalRuntime = new SessionJournalRuntime(
      integrityProvider,
      options.sessionArchivePort ?? createDefaultSQLiteSessionArchivePort(),
    );
    mkdirSync(sessionsDir, { recursive: true });
    if (options.transcriptProjection !== undefined) {
      this.transcriptProjection = options.transcriptProjection;
    } else if (!options.disableSearchIndex) {
      try {
        this.transcriptProjection = createDefaultSQLiteTranscriptProjection(
          options.searchIndexPath ?? join(this.sessionsDir, DEFAULT_SQLITE_SESSION_SEARCH_INDEX_FILENAME),
        );
      } catch (error) {
        log.warn('Transcript projection unavailable; canonical archive remains authoritative and keyword search is disabled', {
          error: toErrorMessage(error),
        });
        this.transcriptProjection = null;
      }
    }
    if (options.transcriptSearch !== undefined) {
      this.transcriptSearch = options.transcriptSearch;
    } else if (supportsKeywordSearch(this.transcriptProjection)) {
      this.transcriptSearch = this.transcriptProjection;
    }
    this.turnRecordStore = options.turnRecordStore ?? createDefaultSQLiteTurnRecordStorePort(this.sessionsDir);
    loadChannelIndex(this.channelIndexPath, this.channelIndex);
    this.migrateLegacyFilenames();
    this.primeChannelIndexFromDisk();
    this.backfillTranscriptProjectionFromDisk();
  }
  private ensureChannelIndexEntry(sessionId: string, channelId: string, filePath: string): ChannelIndexEntry {
    return ensureChannelIndexEntry({
      sessionId,
      channelId,
      filePath,
      channelIndexPath: this.channelIndexPath,
      channelIndex: this.channelIndex,
      warnAboutQuarantinedEntries: (id, path, quarantined, loaded) => {
        this.journalRuntime.warnAboutQuarantinedEntries(
          id,
          this.journalRuntime.openArchive(id, path),
          quarantined,
          loaded,
        );
      },
    });
  }
  private upsertChannelIndex(channelId: string, entry: ChannelIndexEntry): void {
    upsertChannelIndex(channelId, entry, this.channelIndexPath, this.channelIndex);
  }
  private resolveSessionId(lookupKey: string): string | null {
    return resolvePrimarySessionId(lookupKey, this.channelIndex);
  }
  private getLoadedCache(lookupKey: string): ChannelCache | undefined {
    const sessionId = this.resolveSessionId(lookupKey) ?? lookupKey;
    return this.channels.get(sessionId);
  }
  private resolveExistingSession(lookupKey: string) {
    return resolveExistingSession(this.sessionsDir, lookupKey, this.channelIndex);
  }
  private rehydrateLastJournalEntry(channelId: string, indexEntry: ChannelIndexEntry): JournalEntry | null {
    return rehydrateLastJournalEntry(channelId, indexEntry);
  }
  private migrateLegacyFilenames(): void {
    migrateLegacyFilenames({
      sessionsDir: this.sessionsDir,
      channelIndexPath: this.channelIndexPath,
      channelIndex: this.channelIndex,
      warnAboutQuarantinedEntries: (channelId, filePath, quarantinedCount, loadedCount) => {
        this.journalRuntime.warnAboutQuarantinedEntries(
          channelId,
          this.journalRuntime.openArchive(channelId, filePath),
          quarantinedCount,
          loadedCount,
        );
      },
    });
  }
  private primeChannelIndexFromDisk(): void {
    primeChannelIndexFromDisk({
      sessionsDir: this.sessionsDir,
      channelIndexPath: this.channelIndexPath,
      channelIndex: this.channelIndex,
      warnAboutQuarantinedEntries: (channelId, filePath, quarantinedCount, loadedCount) => {
        this.journalRuntime.warnAboutQuarantinedEntries(
          channelId,
          this.journalRuntime.openArchive(channelId, filePath),
          quarantinedCount,
          loadedCount,
        );
      },
    });
  }
  private backfillTranscriptProjectionFromDisk(): void {
    this.journalRuntime.backfillTranscriptProjectionFromDisk({
      transcriptProjection: this.transcriptProjection,
      channelIndex: this.channelIndex,
      sessionsDir: this.sessionsDir,
    });
  }
  private loadExistingChannelCache(channelId: string): ChannelCache | null {
    const existing = this.getLoadedCache(channelId);
    if (existing) return existing;
    const resolved = this.resolveExistingSession(channelId);
    if (!resolved) return null;
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePath);
    const cache = createLightweightCache(resolved.channelId, resolved.filePath, indexEntry);
    this.channels.set(resolved.sessionId, cache);
    return cache;
  }
  private ensureChannelFullyLoaded(channelId: string): ChannelCache | null {
    const resolvedSessionId = this.resolveSessionId(channelId) ?? channelId;
    const existing = this.channels.get(resolvedSessionId);
    if (existing?.fullyLoaded) return existing;
    const resolved = existing
      ? {
        sessionId: resolvedSessionId,
        channelId: existing.channelId,
        filePath: existing.resolvedPath,
      }
      : this.resolveExistingSession(channelId);
    if (!resolved) return null;
    const loaded = this.journalRuntime.loadChannel(
      this.journalRuntime.openArchive(resolved.channelId, resolved.filePath),
    );
    this.channels.set(resolved.sessionId, loaded);
    this.upsertChannelIndex(resolved.sessionId, snapshotIndexEntry(loaded));
    return loaded;
  }
  private indexSessionEntry(entry: SessionEntry): void {
    this.journalRuntime.indexSessionEntry(entry, this.transcriptProjection);
  }
  private ensureChannelForWrite(channelId: string, seed: SessionFileSeed): ChannelCache {
    const resolvedSessionId = this.resolveSessionId(channelId) ?? channelId;
    const existing = this.channels.get(resolvedSessionId);
    if (existing) return existing;
    const resolved = this.resolveExistingSession(channelId);
    if (resolved) {
      const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePath);
      const cache = createLightweightCache(resolved.channelId, resolved.filePath, indexEntry);
      this.channels.set(resolved.sessionId, cache);
      return cache;
    }
    const archive = this.journalRuntime.createArchive(this.sessionsDir, channelId, seed);
    const newPath = this.journalRuntime.resolveArchivePath(archive);
    const cache: ChannelCache = {
      channelId,
      entries: [],
      compactions: [],
      turnTombstones: new Set(),
      activeTurnTombstoneCount: 0,
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      resolvedPath: newPath,
      messageCount: 0,
      lastTimestamp: 0,
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: '',
      fullyLoaded: true,
      recentEntriesByLimit: new Map(),
    };
    this.channels.set(channelId, cache);
    this.upsertChannelIndex(channelId, snapshotIndexEntry(cache));
    return cache;
  }
  private writeJournalEntry(cache: ChannelCache, journal: JournalEntry): void {
    cache.recentEntriesByLimit.clear();
    const archive = this.journalRuntime.openArchive(cache.channelId, cache.resolvedPath);
    this.journalRuntime.writeJournalEntry({
      cache,
      archive,
      journal,
      upsertChannelIndex: (channelId, entry) => this.upsertChannelIndex(channelId, entry),
    });
  }
  private resolveCacheSessionKey(cache: ChannelCache): string {
    for (const [sessionId, candidate] of this.channels.entries()) {
      if (candidate === cache) return sessionId;
    }
    return this.resolveSessionId(cache.channelId) ?? cache.channelId;
  }
  private reconcileWriteCache(cache: ChannelCache): ChannelCache {
    const archive = this.journalRuntime.openArchive(cache.channelId, cache.resolvedPath);
    const metadata = this.journalRuntime.scanArchiveMetadata(archive);
    if (metadata.quarantined.length > 0) {
      this.journalRuntime.warnAboutQuarantinedEntries(
        cache.channelId,
        archive,
        metadata.quarantined.length,
        metadata.entryCount,
      );
    }

    const diskNextId = metadata.maxId + 1;
    const cacheLastJournalType = cache.lastJournalEntry?.type ?? null;
    const diskLastJournalType = metadata.lastEntry?.type ?? null;
    const cacheMatchesDisk = (
      cache.nextId === diskNextId
      && cache.lastHmac === metadata.lastHmac
      && cache.lastTimestamp === metadata.lastTimestamp
      && cache.messageCount === metadata.messageCount
      && cache.activeTurnTombstoneCount === metadata.activeTurnTombstoneCount
      && cache.lastExtractionCoveredUpTo === metadata.lastExtractionCoveredUpTo
      && cacheLastJournalType === diskLastJournalType
    );
    if (cacheMatchesDisk) {
      return cache;
    }

    const loaded = this.journalRuntime.loadChannel(archive);
    const sessionId = this.resolveCacheSessionKey(cache);
    this.channels.set(sessionId, loaded);
    this.upsertChannelIndex(sessionId, snapshotIndexEntry(loaded));
    this.syncTranscriptProjectionForChannel(loaded.channelId, loaded.entries);
    return loaded;
  }
  private withLockedChannelWrite<T>(
    channelId: string,
    seed: SessionFileSeed,
    writer: (cache: ChannelCache) => T,
  ): T {
    const cache = this.ensureChannelForWrite(channelId, seed);
    return withJournalWriteLock(cache.resolvedPath, () => writer(this.reconcileWriteCache(cache)));
  }
  private withLockedExistingChannelWrite<T>(
    channelId: string,
    writer: (cache: ChannelCache) => T,
  ): T | null {
    const cache = this.getLoadedCache(channelId) ?? this.loadExistingChannelCache(channelId);
    if (!cache) return null;
    return withJournalWriteLock(cache.resolvedPath, () => writer(this.reconcileWriteCache(cache)));
  }
  private readRecentEntriesFromTail(channelId: string, filePath: string, limit: number): SessionEntry[] {
    return this.journalRuntime.readRecentEntriesFromTail(
      this.journalRuntime.openArchive(channelId, filePath),
      limit,
    );
  }
  private applyTurnTombstonesToEntries(entries: readonly SessionEntry[], tombstones: ReadonlySet<string>): SessionEntry[] {
    if (tombstones.size === 0) return [...entries];
    return entries.filter((entry) => {
      let turnId: string;
      try {
        turnId = resolveSessionEntryTurnContext(entry).turnId;
      } catch {
        turnId = backfillLegacyTurnId(`legacy-turn:${entry.channelId}:${entry.id}:${entry.timestamp}:${entry.role}`);
      }
      return !tombstones.has(turnId);
    });
  }
  private syncTranscriptProjectionForChannel(channelId: string, entries: readonly SessionEntry[]): void {
    if (!this.transcriptProjection) return;
    this.transcriptProjection.replaceChannelEntries(channelId, entries);
  }
  private buildRecentEntriesFingerprint(cache: ChannelCache): string {
    return [
      cache.resolvedPath,
      cache.messageCount,
      cache.activeTurnTombstoneCount,
      cache.nextId,
      cache.lastTimestamp,
      cache.lastExtractionCoveredUpTo,
      cache.lastJournalEntry?.type ?? '',
      cache.lastJournalEntry?.type === 'marker' ? (cache.lastJournalEntry.marker ?? '') : '',
      cache.lastHmac ?? '',
    ].join(':');
  }
  private syncLightweightCacheFromIndexEntry(cache: ChannelCache, indexEntry: ChannelIndexEntry): void {
    if (cache.fullyLoaded) return;
    const previousFingerprint = this.buildRecentEntriesFingerprint(cache);
    cache.activeTurnTombstoneCount = normalizeOptionalNonNegativeNumber(indexEntry.activeTurnTombstoneCount) ?? 0;
    cache.nextId = (normalizeOptionalNonNegativeNumber(indexEntry.maxId) ?? 0) + 1;
    cache.lastHmac = indexEntry.lastHmac ?? null;
    cache.lastExtractionCoveredUpTo = normalizeOptionalNonNegativeNumber(indexEntry.lastExtractionCoveredUpTo) ?? 0;
    cache.lastJournalEntry = rehydrateLastJournalEntry(cache.channelId, indexEntry);
    cache.messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
    cache.lastTimestamp = normalizeOptionalNonNegativeNumber(indexEntry.lastTimestamp) ?? 0;
    cache.lastMessageTimestamp = normalizeOptionalNonNegativeNumber(indexEntry.lastMessageTimestamp) ?? 0;
    cache.lastMessageRole = normalizeOptionalSessionEntryRole(indexEntry.lastMessageRole) ?? null;
    cache.lastMessageAuthorName = normalizeOptionalString(indexEntry.lastMessageAuthorName);
    cache.lastMessagePreview = normalizeOptionalString(indexEntry.lastMessagePreview) ?? '';
    if (this.buildRecentEntriesFingerprint(cache) !== previousFingerprint) {
      cache.recentEntriesByLimit.clear();
    }
  }
  private readCachedRecentEntries(cache: ChannelCache, limit: number): SessionEntry[] | null {
    const cached = cache.recentEntriesByLimit.get(limit);
    if (!cached) return null;
    if (cached.fingerprint !== this.buildRecentEntriesFingerprint(cache)) return null;
    return [...cached.entries];
  }
  private writeCachedRecentEntries(cache: ChannelCache, limit: number, entries: SessionEntry[]): void {
    if (cache.fullyLoaded) return;
    cache.recentEntriesByLimit.set(limit, {
      fingerprint: this.buildRecentEntriesFingerprint(cache),
      entries: [...entries],
    });
    while (cache.recentEntriesByLimit.size > MAX_RECENT_ENTRY_CACHE_LIMITS) {
      const oldestKey = cache.recentEntriesByLimit.keys().next().value;
      if (oldestKey === undefined) break;
      cache.recentEntriesByLimit.delete(oldestKey);
    }
  }
  listLegacyImportManifests(filters: LegacyChatImportManifestFilter = {}): LegacyChatImportManifest[] {
    return listLegacyImportManifests(this.importManifestPath, filters);
  }
  importLegacyChatFromFile(request: LegacyChatImportRequest): LegacyChatImportResult {
    return runLegacyChatImport({
      request,
      importManifestPath: this.importManifestPath,
      readExistingManifests: () => readImportManifests(this.importManifestPath),
      appendImportedRecord: ({ request: importRequest, source, importId, sourceHash }) => {
        if (!source.content || source.timestamp <= 0) {
          return null;
        }
        const id = this.append({
          channelId: importRequest.channelId,
          role: source.role,
          content: source.content,
          timestamp: source.timestamp,
          authorId: source.authorId ?? importRequest.defaultAuthorId,
          authorName: source.authorName ?? importRequest.defaultAuthorName,
          channelVisibility: source.channelVisibility ?? importRequest.defaultChannelVisibility,
          originChannelId: source.originChannelId,
          metadata: buildLegacyImportMetadata({
            importId,
            sourcePath: importRequest.sourcePath,
            sourceHash,
            sourceIndex: source.sourceIndex,
            sourceTimestamp: source.timestamp,
            metadataTag: importRequest.metadataTag,
            sourceMetadata: source.metadata,
          }),
        });
        return { id };
      },
    });
  }
  append(entry: Omit<SessionEntry, 'id'>): number {
    return this.withLockedChannelWrite(
      entry.channelId,
      {
        timestamp: entry.timestamp,
        authorId: entry.authorId,
        authorName: entry.authorName,
      },
      (cache) => {
        const id = cache.nextId;
        const full: SessionEntry = { ...entry, id };
        const previousNextId = cache.nextId;
        const previousEntriesLength = cache.entries.length;
        const previousMessageCount = cache.messageCount;
        const previousLastTimestamp = cache.lastTimestamp;
        const previousLastMessageTimestamp = cache.lastMessageTimestamp;
        const previousLastMessageRole = cache.lastMessageRole;
        const previousLastMessageAuthorName = cache.lastMessageAuthorName;
        const previousLastMessagePreview = cache.lastMessagePreview;
        cache.nextId = id + 1;
        if (cache.fullyLoaded) {
          cache.entries.push(full);
        }
        cache.messageCount += 1;
        cache.lastTimestamp = entry.timestamp;
        applyLastMessageMetadata(cache, entry);
        const journal = buildMessageJournalEntry(id, entry);
        try {
          this.writeJournalEntry(cache, journal);
        } catch (error) {
          cache.nextId = previousNextId;
          cache.messageCount = previousMessageCount;
          cache.lastTimestamp = previousLastTimestamp;
          cache.lastMessageTimestamp = previousLastMessageTimestamp;
          cache.lastMessageRole = previousLastMessageRole;
          cache.lastMessageAuthorName = previousLastMessageAuthorName;
          cache.lastMessagePreview = previousLastMessagePreview;
          if (cache.fullyLoaded) {
            cache.entries.length = previousEntriesLength;
          }
          throw error;
        }
        this.indexSessionEntry(full);
        return id;
      },
    );
  }
  appendTurnRecord(record: TurnRecord): void {
    this.turnRecordStore.appendTurnRecord(record);
  }
  getRecentTurnRecords(channelId: string, limit: number): TurnRecord[] {
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    const hasTombstones = (cached?.activeTurnTombstoneCount ?? 0) > 0;
    const records = this.turnRecordStore.readRecentTurnRecords(
      sessionId,
      hasTombstones ? Number.MAX_SAFE_INTEGER : limit,
    );
    if (!hasTombstones) {
      return records;
    }

    const loaded = this.ensureChannelFullyLoaded(channelId);
    if (!loaded || loaded.turnTombstones.size === 0) {
      if (records.length <= limit) return records;
      return records.slice(-limit);
    }

    const filtered = records.filter(record => !loaded.turnTombstones.has(record.turnId));
    if (filtered.length <= limit) return filtered;
    return filtered.slice(-limit);
  }
  async searchByKeywords(query: string, limit = 10): Promise<SessionSearchHit[]> {
    if (!this.transcriptSearch) return [];
    return await this.transcriptSearch.searchByKeywords(query, limit);
  }
  rebuildSearchIndex(): void {
    this.backfillTranscriptProjectionFromDisk();
  }
  getRecent(channelId: string, limit: number): SessionEntry[] {
    if (limit <= 0) return [];
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded) {
      if (cached.entries.length <= limit) return [...cached.entries];
      return cached.entries.slice(-limit);
    }
    if (cached && cached.activeTurnTombstoneCount > 0) {
      const full = this.ensureChannelFullyLoaded(channelId);
      if (!full) return [];
      if (full.entries.length <= limit) return [...full.entries];
      return full.entries.slice(-limit);
    }
    const resolved = cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePath: cached.resolvedPath,
      }
      : this.resolveExistingSession(channelId);
    if (!resolved) return [];
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePath);
    if (cached) {
      this.syncLightweightCacheFromIndexEntry(cached, indexEntry);
    }
    const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
    if (messageCount === 0) return [];
    if ((normalizeOptionalNonNegativeNumber(indexEntry.activeTurnTombstoneCount) ?? 0) > 0) {
      const full = this.ensureChannelFullyLoaded(channelId);
      if (!full) return [];
      if (full.entries.length <= limit) return [...full.entries];
      return full.entries.slice(-limit);
    }
    if (messageCount <= limit) {
      const full = this.ensureChannelFullyLoaded(channelId);
      if (!full) return [];
      if (full.entries.length <= limit) return [...full.entries];
      return full.entries.slice(-limit);
    }
    const recentCacheHit = cached ? this.readCachedRecentEntries(cached, limit) : null;
    if (recentCacheHit) {
      return recentCacheHit;
    }
    const recentEntries = this.readRecentEntriesFromTail(resolved.channelId, resolved.filePath, limit);
    if (cached) {
      this.writeCachedRecentEntries(cached, limit, recentEntries);
    }
    return recentEntries;
  }
  getLastEntry(channelId: string): SessionEntry | undefined {
    const entries = this.getRecent(channelId, 1);
    return entries[entries.length - 1];
  }
  getEntriesInRange(channelId: string, startId: number, endId: number): SessionEntry[] {
    if (!Number.isFinite(startId) || !Number.isFinite(endId)) return [];
    const normalizedStart = Math.max(0, Math.floor(Math.min(startId, endId)));
    const normalizedEnd = Math.max(0, Math.floor(Math.max(startId, endId)));
    if (normalizedEnd < normalizedStart) return [];
    const cache = this.ensureChannelFullyLoaded(channelId);
    if (!cache) return [];
    return cache.entries.filter(entry => entry.id >= normalizedStart && entry.id <= normalizedEnd);
  }
  getRecentDiscordMessageIds(channelId: string, limit: number): Set<string> {
    const entries = this.getRecent(channelId, limit);
    const ids = entries
      .map((entry) => entry.discordMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return new Set(ids);
  }
  count(channelId: string): number {
    const cached = this.getLoadedCache(channelId);
    if (cached) return cached.messageCount;
    const resolved = this.resolveExistingSession(channelId);
    if (!resolved) return 0;
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePath);
    return normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
  }
  getCompactionSummaries(channelId: string): CompactionSummary[] {
    const cache = this.ensureChannelFullyLoaded(channelId);
    return cache ? [...cache.compactions] : [];
  }
  getSessionActivity(channelId: string): SessionActivitySummary | null {
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.getLoadedCache(channelId) ?? this.loadExistingChannelCache(channelId);
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

    const resolved = this.resolveExistingSession(channelId);
    if (!resolved) return null;
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePath);
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
  listSessionsByRecentActivity(limit = 20): SessionActivitySummary[] {
    if (limit <= 0) return [];
    this.primeChannelIndexFromDisk();
    const sessions: SessionActivitySummary[] = [];

    for (const [sessionId, indexEntry] of this.channelIndex.entries()) {
      const logicalChannelId = indexedChannelId(sessionId, indexEntry);
      const filePath = join(this.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;

      const ensured = this.ensureChannelIndexEntry(sessionId, logicalChannelId, filePath);
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

    return sessions.slice(0, limit);
  }
  getLatestSessionByTimestamp(): LatestSessionSummary | null {
    const latest = this.listSessionsByRecentActivity(1)[0];
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- array index may be undefined at runtime
    if (!latest) return null;
    return {
      sessionId: latest.sessionId,
      timestamp: latest.lastActivityAt,
      channelType: latest.channelType,
    };
  }
  listChannels(): Array<{ sessionId: string; channelId: string; messageCount: number }> {
    this.primeChannelIndexFromDisk();
    const channels: Array<{ sessionId: string; channelId: string; messageCount: number }> = [];
    for (const [sessionId, indexEntry] of this.channelIndex.entries()) {
      const logicalChannelId = indexedChannelId(sessionId, indexEntry);
      const filePath = join(this.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;
      const ensured = this.ensureChannelIndexEntry(sessionId, logicalChannelId, filePath);
      channels.push({
        sessionId,
        channelId: logicalChannelId,
        messageCount: normalizeOptionalNonNegativeNumber(ensured.messageCount) ?? 0,
      });
    }
    return channels;
  }
  insertCompaction(channelId: string, summary: string, coveredUpTo: number): void {
    const now = Date.now();
    this.withLockedChannelWrite(
      channelId,
      {
        timestamp: now,
        authorId: 'system',
        authorName: 'system',
      },
      (cache) => {
        const id = cache.nextId;
        const previousNextId = cache.nextId;
        const previousCompactionLength = cache.compactions.length;
        cache.nextId = id + 1;
        if (cache.fullyLoaded) {
          cache.compactions.push({ id, channelId, summary, coveredUpTo, createdAt: now });
        }
        const journal = buildCompactionJournalEntry(id, channelId, summary, coveredUpTo, now);
        try {
          this.writeJournalEntry(cache, journal);
        } catch (error) {
          cache.nextId = previousNextId;
          if (cache.fullyLoaded) {
            cache.compactions.length = previousCompactionLength;
          }
          throw error;
        }
      },
    );
  }
  insertExtractionMarker(channelId: string, coveredUpTo: number, timestamp = Date.now()): void {
    if (!Number.isFinite(coveredUpTo)) return;
    const markerCoveredUpTo = Math.max(0, Math.floor(coveredUpTo));
    this.withLockedExistingChannelWrite(channelId, (cache) => {
      const id = cache.nextId;
      const previousNextId = cache.nextId;
      cache.nextId = id + 1;
      const journal = buildExtractionMarkerJournalEntry(id, cache.channelId, markerCoveredUpTo, timestamp);
      try {
        this.writeJournalEntry(cache, journal);
      } catch (error) {
        cache.nextId = previousNextId;
        throw error;
      }
    });
  }
  private appendTurnTombstone(
    channelId: string,
    turnId: string,
    action: 'redact' | 'restore',
    options: { actor?: string; reason?: string; timestamp?: number } = {},
  ): void {
    const parsedTurnId = parseTurnId(turnId, 'turnId');
    if (!parsedTurnId) {
      throw new Error('Turn tombstone requires a valid TurnID');
    }

    const timestamp = options.timestamp ?? Date.now();
    this.withLockedChannelWrite(
      channelId,
      {
        timestamp,
        authorId: options.actor,
        authorName: options.actor,
      },
      (cache) => {
        const id = cache.nextId;
        const previousNextId = cache.nextId;
        cache.nextId = id + 1;

        const journal = buildTurnTombstoneJournalEntry(id, channelId, {
          turnId: parsedTurnId,
          action,
          timestamp,
          actor: options.actor,
          reason: options.reason,
        });

        try {
          this.writeJournalEntry(cache, journal);
        } catch (error) {
          cache.nextId = previousNextId;
          throw error;
        }

        const full = cache.fullyLoaded ? cache : this.ensureChannelFullyLoaded(channelId);
        if (full) {
          full.entries = this.applyTurnTombstonesToEntries(full.entries, full.turnTombstones);
          full.messageCount = full.entries.length;
          full.activeTurnTombstoneCount = full.turnTombstones.size;
          syncLastMessageMetadataFromEntries(full);
          this.upsertChannelIndex(channelId, snapshotIndexEntry(full));
          this.syncTranscriptProjectionForChannel(channelId, full.entries);
        }
      },
    );
  }
  redactTurn(
    channelId: string,
    turnId: string,
    options: { actor?: string; reason?: string; timestamp?: number } = {},
  ): void {
    this.appendTurnTombstone(channelId, turnId, 'redact', options);
  }
  restoreTurn(
    channelId: string,
    turnId: string,
    options: { actor?: string; reason?: string; timestamp?: number } = {},
  ): void {
    this.appendTurnTombstone(channelId, turnId, 'restore', options);
  }
  markGracefulShutdownForActiveChannels(
    timestamp = Date.now(),
    options: { skipChannels?: ReadonlySet<string> } = {},
  ): string[] {
    const marked: string[] = [];
    const skipChannels = options.skipChannels;
    for (const [channelId, cache] of this.channels.entries()) {
      if (skipChannels?.has(channelId)) {
        continue;
      }

      withJournalWriteLock(cache.resolvedPath, () => {
        const currentCache = this.reconcileWriteCache(cache);
        if (!currentCache.lastJournalEntry || isGracefulShutdownEntry(currentCache.lastJournalEntry)) {
          return;
        }

        const id = currentCache.nextId;
        currentCache.nextId = id + 1;
        const journal = buildGracefulShutdownMarkerJournalEntry(id, currentCache.channelId, timestamp);

        try {
          this.writeJournalEntry(currentCache, journal);
          marked.push(channelId);
        } catch (error) {
          currentCache.nextId = id;
          log.warn('Failed to write graceful shutdown marker for channel; continuing shutdown', {
            channelId,
            error: toErrorMessage(error),
          });
        }
      });
    }

    return marked;
  }
  getUncleanShutdownChannels(): string[] {
    return getUncleanShutdownChannels({
      sessionsDir: this.sessionsDir,
      channelIndex: this.channelIndex,
      primeChannelIndexFromDisk: () => this.primeChannelIndexFromDisk(),
      ensureChannelIndexEntry: (channelId, filePath) => {
        const indexEntry = this.channelIndex.get(channelId);
        const logicalChannelId = indexEntry ? indexedChannelId(channelId, indexEntry) : channelId;
        return this.ensureChannelIndexEntry(channelId, logicalChannelId, filePath);
      },
      rehydrateLastJournalEntry: (channelId, indexEntry) => (
        this.rehydrateLastJournalEntry(indexedChannelId(channelId, indexEntry), indexEntry)
      ),
    });
  }
  getCrashRecoveryExtractionCandidates(): CrashRecoveryExtractionCandidate[] {
    return getCrashRecoveryExtractionCandidates({
      getUncleanShutdownChannels: () => this.getUncleanShutdownChannels(),
      ensureChannelFullyLoaded: (channelId) => this.ensureChannelFullyLoaded(channelId),
    });
  }
}
