import { mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, CompactionSummary, JournalEntry } from './types.js';
import type { TurnRecord } from '../types.js';
import { createComponentLogger } from '../logger.js';
import {
  buildExtractionMarkerJournalEntry,
  buildCompactionJournalEntry,
  buildGracefulShutdownMarkerJournalEntry,
  buildMessageJournalEntry,
} from './journal-utils.js';
import { SessionSearchIndex, type SessionSearchHit } from './search-index.js';
import { toErrorMessage } from '../utils/errors.js';
import {
  CHANNEL_INDEX_FILENAME,
  IMPORT_MANIFEST_FILENAME,
  createKeyringIntegrityProvider,
  normalizeOptionalNonNegativeNumber,
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
  type SessionIntegrityProvider,
  type SessionStoreOptions,
} from './store-primitives.js';
import { inferSessionChannelType } from './session-id.js';
import {
  getCrashRecoveryExtractionCandidates,
  getUncleanShutdownChannels,
  isGracefulShutdownEntry,
} from './store/crash-recovery.js';
import {
  createLightweightCache,
  ensureChannelIndexEntry,
  makeReadableFilePath,
  migrateLegacyFilenames,
  primeChannelIndexFromDisk,
  rehydrateLastJournalEntry,
  resolveExistingPath,
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
import { appendTurnRecord, readRecentTurnRecords } from './turn-records.js';
import { SessionJournalRuntime } from './store/journal-runtime.js';
const log = createComponentLogger('SessionStore');
export {
  sanitizeChannelId,
  unsanitizeChannelId,
};
export type {
  CrashRecoveryExtractionCandidate,
  LegacyChatImportManifest,
  LegacyChatImportManifestFilter,
  LegacyChatImportRequest,
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

export class SessionStore {
  private sessionsDir: string;
  private channels: Map<string, ChannelCache> = new Map();
  private channelIndex: Map<string, ChannelIndexEntry> = new Map();
  private channelIndexPath: string;
  private importManifestPath: string;
  private searchIndex: SessionSearchIndex | null = null;
  private journalRuntime: SessionJournalRuntime;
  constructor(sessionsDir: string, options: SessionStoreOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.channelIndexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
    this.importManifestPath = join(sessionsDir, IMPORT_MANIFEST_FILENAME);
    const integrityProvider = options.integrityProvider
      ?? createKeyringIntegrityProvider(options.integrityKeyring ?? null);
    this.journalRuntime = new SessionJournalRuntime(integrityProvider);
    mkdirSync(sessionsDir, { recursive: true });
    if (!options.disableSearchIndex) {
      try {
        this.searchIndex = new SessionSearchIndex(
          options.searchIndexPath ?? join(this.sessionsDir, 'session-search.sqlite'),
        );
      } catch (error) {
        log.warn('Session search index unavailable; keyword search disabled', {
          error: toErrorMessage(error),
        });
        this.searchIndex = null;
      }
    }
    loadChannelIndex(this.channelIndexPath, this.channelIndex);
    this.migrateLegacyFilenames();
    this.primeChannelIndexFromDisk();
    this.backfillSearchIndexFromDisk();
  }
  private ensureChannelIndexEntry(channelId: string, filePath: string): ChannelIndexEntry {
    return ensureChannelIndexEntry({
      channelId,
      filePath,
      channelIndexPath: this.channelIndexPath,
      channelIndex: this.channelIndex,
      warnAboutQuarantinedEntries: (id, path, quarantined, loaded) => {
        this.journalRuntime.warnAboutQuarantinedEntries(id, path, quarantined, loaded);
      },
    });
  }
  private upsertChannelIndex(channelId: string, entry: ChannelIndexEntry): void {
    upsertChannelIndex(channelId, entry, this.channelIndexPath, this.channelIndex);
  }
  private resolveExistingPath(channelId: string): string | null {
    return resolveExistingPath(this.sessionsDir, channelId, this.channelIndex);
  }
  private rehydrateLastJournalEntry(channelId: string, indexEntry: ChannelIndexEntry): JournalEntry | null {
    return rehydrateLastJournalEntry(channelId, indexEntry);
  }
  private makeReadableFilePath(channelId: string, seed: SessionFileSeed): string {
    return makeReadableFilePath(this.sessionsDir, channelId, seed);
  }
  private migrateLegacyFilenames(): void {
    migrateLegacyFilenames({
      sessionsDir: this.sessionsDir,
      channelIndexPath: this.channelIndexPath,
      channelIndex: this.channelIndex,
      warnAboutQuarantinedEntries: (channelId, filePath, quarantinedCount, loadedCount) => {
        this.journalRuntime.warnAboutQuarantinedEntries(channelId, filePath, quarantinedCount, loadedCount);
      },
    });
  }
  private primeChannelIndexFromDisk(): void {
    primeChannelIndexFromDisk({
      sessionsDir: this.sessionsDir,
      channelIndexPath: this.channelIndexPath,
      channelIndex: this.channelIndex,
      warnAboutQuarantinedEntries: (channelId, filePath, quarantinedCount, loadedCount) => {
        this.journalRuntime.warnAboutQuarantinedEntries(channelId, filePath, quarantinedCount, loadedCount);
      },
    });
  }
  private backfillSearchIndexFromDisk(): void {
    this.journalRuntime.backfillSearchIndexFromDisk({
      searchIndex: this.searchIndex,
      channelIndex: this.channelIndex,
      sessionsDir: this.sessionsDir,
    });
  }
  private loadExistingChannelCache(channelId: string): ChannelCache | null {
    const existing = this.channels.get(channelId);
    if (existing) return existing;
    const resolvedPath = this.resolveExistingPath(channelId);
    if (!resolvedPath) return null;
    const indexEntry = this.ensureChannelIndexEntry(channelId, resolvedPath);
    const cache = createLightweightCache(channelId, resolvedPath, indexEntry);
    this.channels.set(channelId, cache);
    return cache;
  }
  private ensureChannelFullyLoaded(channelId: string): ChannelCache | null {
    const existing = this.channels.get(channelId);
    if (existing?.fullyLoaded) return existing;
    const resolvedPath = existing?.resolvedPath ?? this.resolveExistingPath(channelId);
    if (!resolvedPath) return null;
    const loaded = this.journalRuntime.loadChannelFromPath(channelId, resolvedPath);
    this.channels.set(channelId, loaded);
    this.upsertChannelIndex(channelId, snapshotIndexEntry(loaded));
    return loaded;
  }
  private indexSessionEntry(entry: SessionEntry): void {
    this.journalRuntime.indexSessionEntry(entry, this.searchIndex);
  }
  private ensureChannelForWrite(channelId: string, seed: SessionFileSeed): ChannelCache {
    const existing = this.channels.get(channelId);
    if (existing) return existing;
    const resolvedPath = this.resolveExistingPath(channelId);
    if (resolvedPath) {
      const indexEntry = this.ensureChannelIndexEntry(channelId, resolvedPath);
      const cache = createLightweightCache(channelId, resolvedPath, indexEntry);
      this.channels.set(channelId, cache);
      return cache;
    }
    const newPath = this.makeReadableFilePath(channelId, seed);
    const cache: ChannelCache = {
      entries: [],
      compactions: [],
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      resolvedPath: newPath,
      messageCount: 0,
      lastTimestamp: 0,
      fullyLoaded: true,
    };
    this.channels.set(channelId, cache);
    this.upsertChannelIndex(channelId, snapshotIndexEntry(cache));
    return cache;
  }
  private writeJournalEntry(cache: ChannelCache, journal: JournalEntry): void {
    this.journalRuntime.writeJournalEntry({
      cache,
      journal,
      upsertChannelIndex: (channelId, entry) => this.upsertChannelIndex(channelId, entry),
    });
  }
  private readRecentEntriesFromTail(channelId: string, filePath: string, limit: number): SessionEntry[] {
    return this.journalRuntime.readRecentEntriesFromTail(channelId, filePath, limit);
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
    const cache = this.ensureChannelForWrite(entry.channelId, {
      timestamp: entry.timestamp,
      authorId: entry.authorId,
      authorName: entry.authorName,
    });
    const id = cache.nextId;
    const full: SessionEntry = { ...entry, id };
    const previousNextId = cache.nextId;
    const previousEntriesLength = cache.entries.length;
    const previousMessageCount = cache.messageCount;
    const previousLastTimestamp = cache.lastTimestamp;
    cache.nextId = id + 1;
    if (cache.fullyLoaded) {
      cache.entries.push(full);
    }
    cache.messageCount += 1;
    cache.lastTimestamp = entry.timestamp;
    const journal = buildMessageJournalEntry(id, entry);
    try {
      this.writeJournalEntry(cache, journal);
    } catch (error) {
      cache.nextId = previousNextId;
      cache.messageCount = previousMessageCount;
      cache.lastTimestamp = previousLastTimestamp;
      if (cache.fullyLoaded) {
        cache.entries.length = previousEntriesLength;
      }
      throw error;
    }
    this.indexSessionEntry(full);
    return id;
  }
  appendTurnRecord(record: TurnRecord): void {
    appendTurnRecord(this.sessionsDir, record);
  }
  getRecentTurnRecords(channelId: string, limit: number): TurnRecord[] {
    return readRecentTurnRecords(this.sessionsDir, channelId, limit);
  }
  searchByKeywords(query: string, limit = 10): SessionSearchHit[] {
    if (!this.searchIndex) return [];
    return this.searchIndex.searchByKeywords(query, limit);
  }
  rebuildSearchIndex(): void {
    this.backfillSearchIndexFromDisk();
  }
  getRecent(channelId: string, limit: number): SessionEntry[] {
    if (limit <= 0) return [];
    const cached = this.channels.get(channelId);
    if (cached?.fullyLoaded) {
      if (cached.entries.length <= limit) return [...cached.entries];
      return cached.entries.slice(-limit);
    }
    const resolvedPath = cached?.resolvedPath ?? this.resolveExistingPath(channelId);
    if (!resolvedPath) return [];
    const indexEntry = this.ensureChannelIndexEntry(channelId, resolvedPath);
    const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
    if (messageCount === 0) return [];
    if (messageCount <= limit) {
      const full = this.ensureChannelFullyLoaded(channelId);
      if (!full) return [];
      if (full.entries.length <= limit) return [...full.entries];
      return full.entries.slice(-limit);
    }
    return this.readRecentEntriesFromTail(channelId, resolvedPath, limit);
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
    const cached = this.channels.get(channelId);
    if (cached) return cached.messageCount;
    const resolvedPath = this.resolveExistingPath(channelId);
    if (!resolvedPath) return 0;
    const indexEntry = this.ensureChannelIndexEntry(channelId, resolvedPath);
    return normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
  }
  getCompactionSummaries(channelId: string): CompactionSummary[] {
    const cache = this.ensureChannelFullyLoaded(channelId);
    return cache ? [...cache.compactions] : [];
  }
  getSessionActivity(channelId: string): SessionActivitySummary | null {
    const messageCount = this.count(channelId);
    if (messageCount <= 0) return null;
    const lastEntry = this.getLastEntry(channelId);
    if (!lastEntry || !Number.isFinite(lastEntry.timestamp) || lastEntry.timestamp <= 0) return null;
    return {
      sessionId: channelId,
      channelType: inferSessionChannelType(channelId),
      lastActivityAt: lastEntry.timestamp,
      messageCount,
      lastRole: lastEntry.role,
      lastAuthorName: lastEntry.authorName,
      lastMessagePreview: toMessagePreview(lastEntry.content),
    };
  }
  listSessionsByRecentActivity(limit = 20): SessionActivitySummary[] {
    if (limit <= 0) return [];
    this.primeChannelIndexFromDisk();
    const sessions: SessionActivitySummary[] = [];

    for (const [channelId, indexEntry] of this.channelIndex.entries()) {
      const filePath = join(this.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;

      const ensured = this.ensureChannelIndexEntry(channelId, filePath);
      const messageCount = normalizeOptionalNonNegativeNumber(ensured.messageCount) ?? 0;
      if (messageCount <= 0) continue;

      const summary = this.getSessionActivity(channelId);
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
  listChannels(): Array<{ channelId: string; messageCount: number }> {
    this.primeChannelIndexFromDisk();
    const channels: Array<{ channelId: string; messageCount: number }> = [];
    for (const [channelId, indexEntry] of this.channelIndex.entries()) {
      const filePath = join(this.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;
      const ensured = this.ensureChannelIndexEntry(channelId, filePath);
      channels.push({
        channelId,
        messageCount: normalizeOptionalNonNegativeNumber(ensured.messageCount) ?? 0,
      });
    }
    return channels;
  }
  insertCompaction(channelId: string, summary: string, coveredUpTo: number): void {
    const now = Date.now();
    const cache = this.ensureChannelForWrite(channelId, {
      timestamp: now,
      authorId: 'system',
      authorName: 'system',
    });
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
  }
  insertExtractionMarker(channelId: string, coveredUpTo: number, timestamp = Date.now()): void {
    if (!Number.isFinite(coveredUpTo)) return;
    const cache = this.channels.get(channelId) ?? this.loadExistingChannelCache(channelId);
    if (!cache) return;
    const markerCoveredUpTo = Math.max(0, Math.floor(coveredUpTo));
    const id = cache.nextId;
    const previousNextId = cache.nextId;
    cache.nextId = id + 1;
    const journal = buildExtractionMarkerJournalEntry(id, channelId, markerCoveredUpTo, timestamp);
    try {
      this.writeJournalEntry(cache, journal);
    } catch (error) {
      cache.nextId = previousNextId;
      throw error;
    }
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
      if (!cache.lastJournalEntry || isGracefulShutdownEntry(cache.lastJournalEntry)) {
        continue;
      }

      const id = cache.nextId;
      cache.nextId = id + 1;
      const journal = buildGracefulShutdownMarkerJournalEntry(id, channelId, timestamp);

      try {
        this.writeJournalEntry(cache, journal);
        marked.push(channelId);
      } catch (error) {
        cache.nextId = id;
        log.warn('Failed to write graceful shutdown marker for channel; continuing shutdown', {
          channelId,
          error: toErrorMessage(error),
        });
      }
    }

    return marked;
  }
  getUncleanShutdownChannels(): string[] {
    return getUncleanShutdownChannels({
      sessionsDir: this.sessionsDir,
      channelIndex: this.channelIndex,
      primeChannelIndexFromDisk: () => this.primeChannelIndexFromDisk(),
      ensureChannelIndexEntry: (channelId, filePath) => this.ensureChannelIndexEntry(channelId, filePath),
      rehydrateLastJournalEntry: (channelId, indexEntry) => this.rehydrateLastJournalEntry(channelId, indexEntry),
    });
  }
  getCrashRecoveryExtractionCandidates(): CrashRecoveryExtractionCandidate[] {
    return getCrashRecoveryExtractionCandidates({
      getUncleanShutdownChannels: () => this.getUncleanShutdownChannels(),
      ensureChannelFullyLoaded: (channelId) => this.ensureChannelFullyLoaded(channelId),
    });
  }
}
