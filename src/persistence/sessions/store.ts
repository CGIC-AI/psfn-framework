import { existsSync, mkdirSync, statSync } from 'node:fs';
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
  L0_SESSION_FILE_MAX_BYTES,
  createKeyringIntegrityProvider,
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
import {
  type SessionSearchHit,
  supportsKeywordSearch,
  type TranscriptProjectionPort,
  type TranscriptSearchOptions,
} from './transcript-projection-port.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';
import type {
  TurnRecordPage,
  TurnRecordPageCursor,
  TurnRecordRecoveryScanOptions,
  TurnRecordStorePort,
  TurnRecordUsageRecord,
} from './turn-record-store-port.js';
import type { TurnRecordEligibilityFencePort } from './turn-record-eligibility-fence-port.js';
import type { TranscriptSearchPort } from './transcript-search-port.js';
import {
  getCrashRecoveryExtractionCandidates,
  getUncleanShutdownChannels,
  isGracefulShutdownEntry,
} from './store/crash-recovery.js';
import {
  createLightweightCache,
  ensureChannelIndexEntry,
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
import {
  TurnRecordEligibilitySnapshotChangedError,
  TurnRecordEligibilitySnapshotInvalidError,
  type SourceTurnRecordEligibility,
} from './store/turn-record-operations.js';
import { indexedChannelId, resolvePrimarySessionId } from './store/session-index-keys.js';
import { withSessionJournalWriteLock } from './store/session-journal-write-lock.js';
import { rollSessionArchiveIfNeeded } from './store/session-rollover.js';
import {
  applyLastMessageMetadata,
  syncLastMessageMetadataFromEntries,
} from './store/session-cache-metadata.js';
import {
  fingerprintSessionJournalChain,
  fullyLoadedSessionChainIsCurrent,
  loadSessionJournalChain,
  readSessionJournalChain,
  reconcileSessionWriteChain,
  syncLightweightSessionCacheFromIndex,
} from './store/session-chain-cache.js';
import { SessionTurnRecordOperations } from './store/turn-record-operations.js';
import { SessionTailOperations } from './store/tail-operations.js';
import {
  buildCogSecTombstoneDiagnostics,
  SessionCogSecOperations,
  type CogSecCompactionInvalidationOptions,
  type CogSecCompactionInvalidationResult,
  type CogSecCompactionRegenerationOptions,
  type CogSecCompactionRegenerationResult,
  type CogSecL0TombstoneOptions,
  type CogSecL0TombstoneResult,
  type CogSecTombstoneDiagnostic,
} from './store/cogsec-operations.js';
import { SessionCursorOperations } from './store/cursor-operations.js';
import type { LatestSessionSummary, SessionActivitySummary } from './store/cursor-operations.js';

const log = createComponentLogger('SessionStore');

export type { LatestSessionSummary, SessionActivitySummary } from './store/cursor-operations.js';

export {
  L0_SESSION_FILE_MAX_BYTES,
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
export type {
  CogSecCompactionInvalidationOptions,
  CogSecCompactionInvalidationResult,
  CogSecCompactionRegenerationOptions,
  CogSecCompactionRegenerationResult,
  CogSecL0TombstoneOptions,
  CogSecL0TombstoneResult,
  CogSecTombstoneDiagnostic,
} from './store/cogsec-operations.js';



export {
  TurnRecordEligibilitySnapshotChangedError,
  TurnRecordEligibilitySnapshotInvalidError,
};
export type { SourceTurnRecordEligibility };

export class SessionStore implements TranscriptSearchPort {
  // Bead ofa1: default per-companion hot-cache window. A class field, not a
  // module-level const, so it stays outside the hardcoded-settings scanner while
  // remaining overridable via SessionStoreOptions.maxHotChannels.
  private static readonly DEFAULT_HOT_CHANNEL_LIMIT = 1000;
  private sessionsDir: string;
  private channels: Map<string, ChannelCache> = new Map();
  private readonly maxHotChannels: number;
  private channelIndex: Map<string, ChannelIndexEntry> = new Map();
  private channelIndexPath: string;
  private channelIndexFingerprint: string | null = null;
  private journalTombstoneAuthority = new Map<string, {
    archiveFingerprint: string;
    tombstones: Set<string>;
  }>();
  private readonly recoveryAuthoritySnapshotHook:
    ((ownerSessionId: string) => void | Promise<void>) | undefined;
  private readonly turnRecordOperations: SessionTurnRecordOperations;
  private importManifestPath: string;
  private transcriptProjection: TranscriptProjectionPort | null = null;
  private transcriptSearch: TranscriptSearchPort | null = null;
  private turnRecordStore: TurnRecordStorePort;
  private turnRecordEligibilityFence: TurnRecordEligibilityFencePort | null;
  private journalRuntime: SessionJournalRuntime;
  private channelIndexFailureLogged = false;
  private readonly tailOperations: SessionTailOperations;
  private readonly cogSecOperations: SessionCogSecOperations;
  private readonly cursorOperations: SessionCursorOperations;
  constructor(sessionsDir: string, options: SessionStoreOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.maxHotChannels = Math.max(
      1,
      Math.floor(options.maxHotChannels ?? SessionStore.DEFAULT_HOT_CHANNEL_LIMIT),
    );
    this.channelIndexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
    this.importManifestPath = join(sessionsDir, IMPORT_MANIFEST_FILENAME);
    const integrityProvider = options.integrityProvider
      ?? createKeyringIntegrityProvider(options.integrityKeyring ?? null);
    this.journalRuntime = new SessionJournalRuntime(
      integrityProvider,
      options.sessionArchivePort ?? createFilesystemSessionArchivePort(),
      options.integrityObserver ?? null,
    );
    mkdirSync(sessionsDir, { recursive: true });
    if (options.transcriptProjection !== undefined) {
      this.transcriptProjection = options.transcriptProjection;
    }
    if (options.transcriptSearch !== undefined) {
      this.transcriptSearch = options.transcriptSearch;
    } else if (supportsKeywordSearch(this.transcriptProjection)) {
      this.transcriptSearch = this.transcriptProjection;
    }
    this.turnRecordStore = options.turnRecordStore ?? createFilesystemTurnRecordStorePort(this.sessionsDir);
    this.turnRecordEligibilityFence = options.turnRecordEligibilityFence ?? null;
    this.cursorOperations = new SessionCursorOperations({
      sessionsDir: this.sessionsDir,
      journalRuntime: this.journalRuntime,
      refreshChannelIndexFromDisk: () => this.refreshChannelIndexFromDisk(),
      resolveSessionId: (channelId) => this.resolveSessionId(channelId),
      resolveExistingSession: (channelId) => this.resolveExistingSession(channelId),
      getLoadedCache: (channelId) => this.getLoadedCache(channelId),
      loadExistingChannelCache: (channelId) => this.loadExistingChannelCache(channelId),
      ensureChannelFullyLoaded: (channelId) => this.ensureChannelFullyLoaded(channelId),
      resolveJournalAuthoritativeTurnTombstones: (params) => this.resolveJournalAuthoritativeTurnTombstones(params),
      ensureChannelIndexEntry: (sessionId, channelId, filePaths) => this.ensureChannelIndexEntry(sessionId, channelId, filePaths),
      fullyLoadedCacheIsCurrent: (cache) => this.fullyLoadedCacheIsCurrent(cache),
      fingerprintArchive: (cache) => this.fingerprintArchive(cache),
      getChannelIndexEntries: () => [...this.channelIndex.entries()],
      primeChannelIndexFromDisk: () => this.primeChannelIndexFromDisk(),
    });
    this.tailOperations = new SessionTailOperations({
      tailCache: options.tailCache ?? null,
      resolveChannelKey: (channelId) => this.resolveSessionId(channelId) ?? channelId,
      getRecent: this.cursorOperations.getRecent.bind(this.cursorOperations),
    });
    this.recoveryAuthoritySnapshotHook = options.recoveryAuthoritySnapshotHook;
    for (const rootPath of this.journalRuntime.listPendingJournalChainRewriteRoots(this.sessionsDir)) {
      withSessionJournalWriteLock(rootPath, () => {
        this.journalRuntime.recoverJournalChainRewrite(rootPath);
      });
    }
    loadChannelIndex(this.channelIndexPath, this.channelIndex);
    this.primeChannelIndexFromDisk();
    this.backfillTranscriptProjectionFromDisk();
    this.channelIndexFingerprint = this.fingerprintChannelIndex();
    this.cogSecOperations = new SessionCogSecOperations({
      journalRuntime: this.journalRuntime,
      bumpSessionTailEpoch: this.tailOperations.bumpSessionTailEpoch.bind(this.tailOperations),
      withPostRewriteTailFence: this.tailOperations.withPostRewriteTailFence.bind(this.tailOperations),
      withLockedExistingChannelWrite: this.withLockedExistingChannelWrite.bind(this),
      readJournalChain: this.readJournalChain.bind(this),
      loadJournalChain: this.loadJournalChain.bind(this),
      syncTranscriptProjectionForChannel: this.syncTranscriptProjectionForChannel.bind(this),
      resolveCacheSessionKey: this.resolveCacheSessionKey.bind(this),
      setChannelCache: this.setChannelCache.bind(this),
      upsertChannelIndex: this.upsertChannelIndex.bind(this),
    });
    this.turnRecordOperations = new SessionTurnRecordOperations({
      sessionsDir: this.sessionsDir,
      journalRuntime: this.journalRuntime,
      turnRecordStore: this.turnRecordStore,
      turnRecordEligibilityFence: this.turnRecordEligibilityFence,
      recoveryAuthoritySnapshotHook: this.recoveryAuthoritySnapshotHook,
      resolveSessionId: this.resolveSessionId.bind(this),
      resolveExistingSession: this.resolveExistingSession.bind(this),
      getChannelIndexEntry: (sessionId) => this.channelIndex.get(sessionId),
      ensureChannelIndexEntry: this.ensureChannelIndexEntry.bind(this),
      getLoadedCache: this.getLoadedCache.bind(this),
      loadExistingChannelCache: this.loadExistingChannelCache.bind(this),
      ensureChannelFullyLoaded: this.ensureChannelFullyLoaded.bind(this),
      resolveJournalAuthoritativeTurnTombstones: this.resolveJournalAuthoritativeTurnTombstones.bind(this),
      syncTranscriptProjectionForChannel: this.syncTranscriptProjectionForChannel.bind(this),
      upsertChannelIndex: this.upsertChannelIndex.bind(this),
      getEntriesInRange: this.cursorOperations.getEntriesInRange.bind(this.cursorOperations),
      refreshChannelIndexFromDisk: this.refreshChannelIndexFromDisk.bind(this),
    });
  }

  // Cursor/query operations
  getRecent(channelId: string, limit: number): SessionEntry[] {
    return this.cursorOperations.getRecent(channelId, limit);
  }
  getLastEntry(channelId: string): SessionEntry | undefined {
    return this.cursorOperations.getLastEntry(channelId);
  }
  findLatestEntries(
    channelId: string,
    predicate: (entry: SessionEntry) => boolean,
    limit = 1,
    options: { stopBeforeTimestamp?: number } = {},
  ): SessionEntry[] {
    return this.cursorOperations.findLatestEntries(channelId, predicate, limit, options);
  }
  getEntriesBefore(channelId: string, beforeId: number, limit: number): SessionEntry[] {
    return this.cursorOperations.getEntriesBefore(channelId, beforeId, limit);
  }
  async getEntriesBeforeAsync(channelId: string, beforeId: number, limit: number): Promise<SessionEntry[]> {
    return this.cursorOperations.getEntriesBeforeAsync(channelId, beforeId, limit);
  }
  getEntriesInRange(channelId: string, startId: number, endId: number): SessionEntry[] {
    return this.cursorOperations.getEntriesInRange(channelId, startId, endId);
  }
  count(channelId: string): number {
    return this.cursorOperations.count(channelId);
  }
  getCompactionSummaries(channelId: string): CompactionSummary[] {
    return this.cursorOperations.getCompactionSummaries(channelId);
  }
  getSessionActivity(channelId: string): SessionActivitySummary | null {
    return this.cursorOperations.getSessionActivity(channelId);
  }
  listSessionsByRecentActivity(limit = 20, offset = 0): SessionActivitySummary[] {
    return this.cursorOperations.listSessionsByRecentActivity(limit, offset);
  }
  getLatestSessionByTimestamp(): LatestSessionSummary | null {
    return this.cursorOperations.getLatestSessionByTimestamp();
  }
  listChannels(): Array<{ sessionId: string; channelId: string; messageCount: number }> {
    return this.cursorOperations.listChannels();
  }
  getRecentDiscordMessageIds(channelId: string, limit: number): Set<string> {
    return this.cursorOperations.getRecentDiscordMessageIds(channelId, limit);
  }
  private fingerprintChannelIndex(): string | null {
    try {
      const stats = statSync(this.channelIndexPath);
      return [stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs].join(':');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  private refreshChannelIndexFromDisk(): void {
    const observed = this.fingerprintChannelIndex();
    if (observed === this.channelIndexFingerprint) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const refreshed = new Map<string, ChannelIndexEntry>();
      loadChannelIndex(this.channelIndexPath, refreshed);
      const afterRead = this.fingerprintChannelIndex();
      if (afterRead !== observed && attempt === 0) continue;
      this.channelIndex = refreshed;
      this.channelIndexFingerprint = afterRead;
      return;
    }
  }
  private ensureChannelIndexEntry(
    sessionId: string,
    channelId: string,
    filePaths: readonly string[],
  ): ChannelIndexEntry {
    return ensureChannelIndexEntry({
      sessionId,
      channelId,
      filePaths,
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
  private resolveJournalAuthoritativeTurnTombstones(params: {
    sessionId: string;
    channelId: string;
    filePaths: readonly string[];
    cache?: ChannelCache;
  }): ReadonlySet<string> {
    const archives = params.filePaths.map(filePath => (
      this.journalRuntime.openArchive(params.channelId, filePath)
    ));
    const archiveFingerprint = this.journalRuntime.fingerprintArchiveChain(archives);
    if (!archiveFingerprint) {
      throw new Error(`Cannot establish turn-tombstone authority for missing L0 session ${params.sessionId}`);
    }
    const remembered = this.journalTombstoneAuthority.get(params.sessionId);
    if (remembered?.archiveFingerprint === archiveFingerprint) {
      this.syncCacheTurnTombstoneAuthority(params.cache, remembered.tombstones);
      return new Set(remembered.tombstones);
    }
    if (params.cache?.fullyLoaded && params.cache.archiveFingerprint === archiveFingerprint) {
      const tombstones = new Set(params.cache.turnTombstones);
      this.journalTombstoneAuthority.set(params.sessionId, { archiveFingerprint, tombstones });
      return new Set(tombstones);
    }

    // The channel index is an unsigned derived cache. On a fresh process it
    // cannot authorize removal of a redaction merely because its archive
    // fingerprint is current. Scan authenticated tombstone actions once per
    // immutable archive generation without replaying every message row.
    const scanned = this.journalRuntime.readTurnTombstoneAuthorityFromChain(
      archives,
      params.cache?.turnTombstones,
    );
    if (!scanned) {
      const loaded = this.journalRuntime.loadChannelChain(archives);
      const loadedFingerprint = loaded.archiveFingerprint;
      if (!loadedFingerprint) {
        throw new Error(`Cannot establish turn-tombstone authority for L0 session ${params.sessionId}`);
      }
      const tombstones = new Set(loaded.turnTombstones);
      this.journalTombstoneAuthority.set(params.sessionId, {
        archiveFingerprint: loadedFingerprint,
        tombstones,
      });
      this.syncCacheTurnTombstoneAuthority(params.cache, tombstones);
      return new Set(tombstones);
    }
    const tombstones = new Set(scanned.tombstones);
    this.journalTombstoneAuthority.set(params.sessionId, {
      archiveFingerprint: scanned.archiveFingerprint,
      tombstones,
    });
    this.syncCacheTurnTombstoneAuthority(params.cache, tombstones);
    return new Set(tombstones);
  }
  private syncCacheTurnTombstoneAuthority(
    cache: ChannelCache | undefined,
    tombstones: ReadonlySet<string>,
  ): void {
    if (!cache || cache.fullyLoaded) return;
    const unchanged = cache.turnTombstones.size === tombstones.size
      && [...tombstones].every(turnId => cache.turnTombstones.has(turnId));
    if (unchanged) return;
    cache.turnTombstones = new Set(tombstones);
    cache.activeTurnTombstoneCount = tombstones.size;
    cache.recentEntriesByLimit.clear();
  }
  private upsertChannelIndex(channelId: string, entry: ChannelIndexEntry): void {
    upsertChannelIndex(channelId, entry, this.channelIndexPath, this.channelIndex);
    this.channelIndexFingerprint = this.fingerprintChannelIndex();
  }
  private resolveSessionId(lookupKey: string): string | null {
    return resolvePrimarySessionId(lookupKey, this.channelIndex);
  }
  /**
   * Bead ofa1: single write seam for the hot-cache. Sets the channel cache then
   * evicts the oldest channels beyond the recent window. The on-disk journal is
   * authoritative (appends are written through immediately), so an evicted
   * channel re-hydrates correctly on the next read via loadExistingChannelCache
   * / ensureChannelForWrite. Replacing an existing key does not grow the map, so
   * it never triggers eviction — safe to call from within channel iterations
   * (reconcileWriteCache).
   */
  private setChannelCache(sessionKey: string, cache: ChannelCache): void {
    this.channels.set(sessionKey, cache);
    while (this.channels.size > this.maxHotChannels) {
      let evicted = false;
      for (const key of this.channels.keys()) {
        if (key === sessionKey) continue;
        this.channels.delete(key);
        evicted = true;
        break;
      }
      if (!evicted) break;
    }
  }

  /** Bead ofa1: test/diagnostic hook — number of channels resident in the hot-cache. */
  getLoadedChannelCount(): number {
    return this.channels.size;
  }

  private getLoadedCache(lookupKey: string): ChannelCache | undefined {
    loadChannelIndex(this.channelIndexPath, this.channelIndex);
    const sessionId = this.resolveSessionId(lookupKey) ?? lookupKey;
    const cache = this.channels.get(sessionId);
    const indexEntry = this.channelIndex.get(sessionId);
    if (cache && indexEntry && !cache.fullyLoaded) {
      syncLightweightSessionCacheFromIndex({ cache, indexEntry, sessionsDir: this.sessionsDir });
    }
    return cache;
  }
  private resolveExistingSession(lookupKey: string) {
    return resolveExistingSession(this.sessionsDir, lookupKey, this.channelIndex);
  }
  private rehydrateLastJournalEntry(channelId: string, indexEntry: ChannelIndexEntry): JournalEntry | null {
    return rehydrateLastJournalEntry(channelId, indexEntry);
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
    for (const [sessionId, entry] of this.channelIndex.entries()) {
      const filePaths = entry.filenames.map(filename => join(this.sessionsDir, filename));
      if (filePaths.some(filePath => !existsSync(filePath))) continue;
      const channelId = indexedChannelId(sessionId, entry);
      const archives = filePaths.map(filePath => this.journalRuntime.openArchive(channelId, filePath));
      const archiveFingerprint = this.journalRuntime.fingerprintArchiveChain(archives);
      if (!archiveFingerprint) continue;
      if (this.journalTombstoneAuthority.get(sessionId)?.archiveFingerprint === archiveFingerprint) continue;
      const metadata = archives.map(archive => this.journalRuntime.scanArchiveMetadata(archive));
      if (metadata.every(result => result.turnTombstoneCount === 0 && result.quarantined.length === 0)) {
        this.journalTombstoneAuthority.set(sessionId, {
          archiveFingerprint,
          tombstones: new Set(),
        });
        continue;
      }
      const scanned = this.journalRuntime.readTurnTombstoneAuthorityFromChain(
        archives,
        new Set(entry.activeTurnTombstoneIds ?? []),
      );
      if (!scanned) continue;
      this.journalTombstoneAuthority.set(sessionId, {
        archiveFingerprint: scanned.archiveFingerprint,
        tombstones: new Set(scanned.tombstones),
      });
    }
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
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
    const cache = createLightweightCache(resolved.channelId, resolved.filePaths, indexEntry);
    this.setChannelCache(resolved.sessionId, cache);
    return cache;
  }
  /**
   * A fullyLoaded cache may only be served while the journal file on disk is
   * byte-identical to what the cache loaded or last wrote. Other processes
   * (gateway, garden) append through their own SessionStore instances over the
   * same sessions dir, so an unverified fullyLoaded cache silently serves a
   * stale window (psfn-framework-hgw3.1: duplicate replies from a context
   * missing the previous turn's assistant entry). `null === null` only holds
   * while the archive file does not exist yet (empty new channel).
   */
  private fullyLoadedCacheIsCurrent(cache: ChannelCache): boolean {
    loadChannelIndex(this.channelIndexPath, this.channelIndex);
    const sessionId = this.resolveCacheSessionKey(cache);
    return fullyLoadedSessionChainIsCurrent({
      cache,
      indexEntry: this.channelIndex.get(sessionId),
      sessionsDir: this.sessionsDir,
      runtime: this.journalRuntime,
    });
  }
  private ensureChannelFullyLoaded(channelId: string): ChannelCache | null {
    const resolvedSessionId = this.resolveSessionId(channelId) ?? channelId;
    const existing = this.getLoadedCache(channelId);
    if (existing?.fullyLoaded && this.fullyLoadedCacheIsCurrent(existing)) return existing;
    const resolved = this.resolveExistingSession(channelId) ?? (existing
      ? {
        sessionId: resolvedSessionId,
        channelId: existing.channelId,
        filePaths: existing.archivePaths,
        filePath: existing.resolvedPath,
      }
      : null);
    if (!resolved) return null;
    const loaded = this.journalRuntime.loadChannelChain(
      resolved.filePaths.map(filePath => this.journalRuntime.openArchive(resolved.channelId, filePath)),
    );
    this.setChannelCache(resolved.sessionId, loaded);
    this.upsertChannelIndex(resolved.sessionId, snapshotIndexEntry(loaded));
    return loaded;
  }
  private indexSessionEntry(entry: SessionEntry): void {
    this.journalRuntime.indexSessionEntry(entry, this.transcriptProjection);
  }
  private ensureChannelForWrite(channelId: string, seed: SessionFileSeed): ChannelCache {
    // A sibling process may have rolled this logical session since this store
    // was constructed. Refresh the index before resolving the write chain so
    // a stale writer cannot append to the retired root segment or reuse an id.
    this.refreshChannelIndexFromDisk();
    const resolvedSessionId = this.resolveSessionId(channelId) ?? channelId;
    const existing = this.channels.get(resolvedSessionId);
    if (existing) return existing;
    const resolved = this.resolveExistingSession(channelId);
    if (resolved) {
      const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
      const cache = createLightweightCache(resolved.channelId, resolved.filePaths, indexEntry);
      this.setChannelCache(resolved.sessionId, cache);
      return cache;
    }
    const archive = this.journalRuntime.createArchive(this.sessionsDir, channelId, seed);
    const newPath = this.journalRuntime.resolveArchivePath(archive);
    const cache: ChannelCache = {
      channelId,
      entries: [],
      compactions: [],
      compactionArchivePaths: new Set(),
      turnTombstones: new Set(),
      activeTurnTombstoneCount: 0,
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      archivePaths: [newPath],
      resolvedPath: newPath,
      archiveFingerprint: null,
      messageCount: 0,
      lastTimestamp: 0,
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: '',
      fullyLoaded: true,
      recentEntriesByLimit: new Map(),
    };
    this.setChannelCache(channelId, cache);
    this.upsertChannelIndex(channelId, snapshotIndexEntry(cache));
    return cache;
  }
  private writeJournalEntry(cache: ChannelCache, journal: JournalEntry): void {
    cache.recentEntriesByLimit.clear();
    const archives = cache.archivePaths.map(filePath => (
      this.journalRuntime.openArchive(cache.channelId, filePath)
    ));
    const archive = archives.at(-1)!;
    const sessionId = this.resolveCacheSessionKey(cache);
    this.journalRuntime.writeJournalEntry({
      cache,
      archive,
      journal,
    });
    let archiveFingerprint: string | null;
    try {
      // Every caller holds the cross-process journal write lock here, so the
      // refreshed chain fingerprint cannot absorb a concurrent foreign append.
      archiveFingerprint = this.journalRuntime.fingerprintArchiveChain(archives);
    } catch (error) {
      cache.archiveFingerprint = null;
      log.warn('Session archive fingerprint refresh failed after journal append; write cache invalidated', {
        channelId: cache.channelId,
        error: toErrorMessage(error),
      });
      return;
    }
    if (archiveFingerprint === null) {
      cache.archiveFingerprint = null;
      throw new Error(`Session archive is missing after journal append for ${cache.channelId}`);
    }
    cache.archiveFingerprint = archiveFingerprint;
    try {
      this.upsertChannelIndex(sessionId, snapshotIndexEntry(cache));
    } catch (error) {
      if (!this.channelIndexFailureLogged) {
        this.channelIndexFailureLogged = true;
        log.warn('Session channel index write failed after journal append; continuing without interruption', {
          channelId: cache.channelId,
          error: toErrorMessage(error),
        });
      }
    }
  }
  private readJournalChain(cache: ChannelCache) {
    return readSessionJournalChain(this.journalRuntime, cache);
  }
  private loadJournalChain(cache: ChannelCache): ChannelCache {
    return loadSessionJournalChain(this.journalRuntime, cache);
  }
  private resolveCacheSessionKey(cache: ChannelCache): string {
    for (const [sessionId, candidate] of this.channels.entries()) {
      if (candidate === cache) return sessionId;
    }
    return this.resolveSessionId(cache.channelId) ?? cache.channelId;
  }
  private reconcileWriteCache(cache: ChannelCache): ChannelCache {
    const sessionId = this.resolveCacheSessionKey(cache);
    loadChannelIndex(this.channelIndexPath, this.channelIndex);
    const reconciled = reconcileSessionWriteChain({
      cache,
      indexEntry: this.channelIndex.get(sessionId),
      sessionsDir: this.sessionsDir,
      runtime: this.journalRuntime,
    });
    if (reconciled.cache === cache) return cache;
    this.setChannelCache(sessionId, reconciled.cache);
    if (reconciled.refreshIndex) {
      this.upsertChannelIndex(sessionId, snapshotIndexEntry(reconciled.cache));
    }
    this.syncTranscriptProjectionForChannel(reconciled.cache.channelId, reconciled.cache.entries);
    return reconciled.cache;
  }
  private withLockedChannelWrite<T>(
    channelId: string,
    seed: SessionFileSeed,
    writer: (cache: ChannelCache, renewLease: () => void) => T,
  ): T {
    const cache = this.ensureChannelForWrite(channelId, seed);
    return withSessionJournalWriteLock(cache.archivePaths[0]!, (renewLease) => (
      writer(this.reconcileWriteCache(cache), renewLease)
    ));
  }
  private withLockedExistingChannelWrite<T>(
    channelId: string,
    writer: (cache: ChannelCache, renewLease: () => void) => T,
  ): T | null {
    const cache = this.getLoadedCache(channelId) ?? this.loadExistingChannelCache(channelId);
    if (!cache) return null;
    return withSessionJournalWriteLock(cache.archivePaths[0]!, (renewLease) => (
      writer(this.reconcileWriteCache(cache), renewLease)
    ));
  }
  private fingerprintArchive(cache: ChannelCache): string | null {
    return fingerprintSessionJournalChain(this.journalRuntime, cache);
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
  async fetchSessionTailWindow(
    channelId: string,
    options: { expectedMinEntryId?: number } = {},
  ): Promise<SessionEntry[] | null> {
    return this.tailOperations.fetchSessionTailWindow(channelId, options);
  }
  async flushSessionTailWrites(): Promise<void> {
    await this.tailOperations.flushSessionTailWrites();
  }
  private syncTranscriptProjectionForChannel(
    channelId: string,
    entries: readonly SessionEntry[],
    options: { redaction?: boolean } = {},
  ): void {
    if (!this.transcriptProjection) return;
    this.transcriptProjection.replaceChannelEntries(channelId, entries, options);
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
      (writeCache) => {
        const cache = rollSessionArchiveIfNeeded({
          cache: writeCache,
          nextRole: entry.role,
          archiveByteLength: filePath => this.journalRuntime.archiveByteLength(
            this.journalRuntime.openArchive(writeCache.channelId, filePath),
          ),
          materializeEmptyArchive: (filePath) => {
            this.journalRuntime.rewriteJournalEntries(
              this.journalRuntime.openArchive(writeCache.channelId, filePath),
              [],
            );
          },
          persistIndex: (rolledCache) => this.upsertChannelIndex(
            this.resolveCacheSessionKey(rolledCache),
            snapshotIndexEntry(rolledCache),
          ),
        });
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
        this.tailOperations.writeSessionTailThrough(entry.channelId, full);
        return id;
      },
    );
  }
  async appendTurnRecord(record: TurnRecord): Promise<void> {
    return this.turnRecordOperations.appendTurnRecord(record);
  }
  async withSourceTurnRecordEligibilityFence<T>(
    sourceChannelId: string,
    logicalSessionId: string,
    turnId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.turnRecordOperations.withSourceTurnRecordEligibilityFence(
      sourceChannelId,
      logicalSessionId,
      turnId,
      operation,
      signal,
    );
  }
  async withStableTurnRecordEligibilitySnapshot<T>(
    logicalSessionId: string,
    requiredTurnIds: readonly string[],
    readSnapshot: () => SessionEntry[],
    operation: (entries: readonly SessionEntry[]) => Promise<T>,
  ): Promise<T> {
    return this.turnRecordOperations.withStableTurnRecordEligibilitySnapshot(
      logicalSessionId,
      requiredTurnIds,
      readSnapshot,
      operation,
    );
  }
  private async withTurnRecordEligibilityMutationFence<T>(
    logicalSessionId: string,
    turnId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.turnRecordOperations.withTurnRecordEligibilityMutationFence(
      logicalSessionId,
      turnId,
      operation,
    );
  }
  findTurnRecord(channelId: string, turnId: string): TurnRecord | null {
    return this.turnRecordOperations.findTurnRecord(channelId, turnId);
  }
  findSourceTurnRecord(
    sourceChannelId: string,
    logicalSessionId: string,
    turnId: string,
  ): TurnRecord | null {
    return this.turnRecordOperations.findSourceTurnRecord(
      sourceChannelId,
      logicalSessionId,
      turnId,
    );
  }
  async findUniqueSourceTurnRecord(
    sourceChannelId: string,
    turnId: string,
  ): Promise<TurnRecord | null> {
    return this.turnRecordOperations.findUniqueSourceTurnRecord(
      sourceChannelId,
      turnId,
    );
  }
  async findEligibleSourceTurnRecord(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<TurnRecord | null> {
    return this.turnRecordOperations.findEligibleSourceTurnRecord(
      sourceChannelId,
      ownerSessionId,
      turnId,
      signal,
    );
  }
  async lookupSourceTurnRecordEligibility(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<SourceTurnRecordEligibility> {
    return this.turnRecordOperations.lookupSourceTurnRecordEligibility(
      sourceChannelId,
      ownerSessionId,
      turnId,
      signal,
    );
  }
  getRecentTurnRecords(channelId: string, limit: number): TurnRecord[] {
    return this.turnRecordOperations.getRecentTurnRecords(channelId, limit);
  }
  getRecentTurnRecordUsage(channelId: string, limit: number): TurnRecordUsageRecord[] {
    return this.turnRecordOperations.getRecentTurnRecordUsage(channelId, limit);
  }
  getRecentSourceTurnRecords(sourceChannelId: string, limit: number): TurnRecord[] {
    return this.turnRecordOperations.getRecentSourceTurnRecords(sourceChannelId, limit);
  }
  async readSourceTurnRecordPage(
    sourceChannelId: string,
    limit: number,
    cursor?: TurnRecordPageCursor,
  ): Promise<TurnRecordPage> {
    return this.turnRecordOperations.readSourceTurnRecordPage(
      sourceChannelId,
      limit,
      cursor,
    );
  }
  async *streamRecoverableBackgroundWorkTurnRecords(
    sourceChannelIds: readonly string[],
    options: TurnRecordRecoveryScanOptions = {},
  ): AsyncGenerator<TurnRecord> {
    yield* this.turnRecordOperations.streamRecoverableBackgroundWorkTurnRecords(
      sourceChannelIds,
      options,
    );
  }
  async isSourceTurnRecordEligible(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
  ): Promise<boolean> {
    return this.turnRecordOperations.isSourceTurnRecordEligible(
      sourceChannelId,
      ownerSessionId,
      turnId,
    );
  }
  async searchByKeywords(
    query: string,
    limit = 10,
    options: TranscriptSearchOptions = {},
  ): Promise<SessionSearchHit[]> {
    if (!this.transcriptSearch) return [];
    const firstMessageId = options.firstMessageId;
    const lastMessageId = options.lastMessageId;
    if (
      (firstMessageId !== undefined && (!Number.isSafeInteger(firstMessageId) || firstMessageId < 1))
      || (lastMessageId !== undefined && (!Number.isSafeInteger(lastMessageId) || lastMessageId < 1))
      || (firstMessageId !== undefined && lastMessageId !== undefined && firstMessageId > lastMessageId)
    ) {
      return [];
    }
    const requestedChannelId = options.channelId?.trim();
    if (!requestedChannelId) {
      if (firstMessageId === undefined && lastMessageId === undefined) {
        return await this.transcriptSearch.searchByKeywords(query, limit);
      }
      const hits = await this.transcriptSearch.searchByKeywords(query, limit, {
        ...(firstMessageId !== undefined ? { firstMessageId } : {}),
        ...(lastMessageId !== undefined ? { lastMessageId } : {}),
      });
      return hits.filter(hit => (
        (firstMessageId === undefined || hit.messageId >= firstMessageId)
        && (lastMessageId === undefined || hit.messageId <= lastMessageId)
      ));
    }
    const scopedChannelId = this.resolveSessionId(requestedChannelId) ?? requestedChannelId;
    const hits = await this.transcriptSearch.searchByKeywords(query, limit, {
      channelId: scopedChannelId,
      ...(firstMessageId !== undefined ? { firstMessageId } : {}),
      ...(lastMessageId !== undefined ? { lastMessageId } : {}),
    });
    // Fail closed: never return out-of-scope rows even if an injected search
    // backend ignores the channel filter.
    return hits.filter(hit => (
      hit.channelId === scopedChannelId
      && (firstMessageId === undefined || hit.messageId >= firstMessageId)
      && (lastMessageId === undefined || hit.messageId <= lastMessageId)
    ));
  }
  rebuildSearchIndex(): void {
    this.backfillTranscriptProjectionFromDisk();
  }
  /**
   * Drop every in-memory view of the channel and reload it from the archive
   * on disk. Detect-and-heal hook for readers that observe a session window
   * missing an entry the write path already assigned an id past
   * (psfn-framework-hgw3.1). Returns null when no archive exists.
   */
  async reloadChannelFromDisk(channelId: string): Promise<{ maxEntryId: number; lastMessageEntryId: number | null } | null> {
    // The stale window being healed may have come FROM the shared tail, and
    // a post-repair reload means the journal on disk was rewritten out of
    // band: bump the epoch so EVERY process drops its pre-reload tail. The
    // bump precedes any state mutation and throws on failure (fail-closed).
    await this.tailOperations.bumpSessionTailEpoch(channelId, 'reload_channel_from_disk');
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    this.channels.delete(sessionId);
    if (sessionId !== channelId) {
      this.channels.delete(channelId);
    }
    const loaded = this.ensureChannelFullyLoaded(channelId);
    if (!loaded) return null;
    return {
      maxEntryId: loaded.nextId - 1,
      lastMessageEntryId: loaded.entries.at(-1)?.id ?? null,
    };
  }

  async applyCogSecTombstones(options: CogSecL0TombstoneOptions): Promise<CogSecL0TombstoneResult> {
    return this.cogSecOperations.applyCogSecTombstones(options);
  }
  listCogSecTombstoneDiagnostics(options: { channelId?: string } = {}): CogSecTombstoneDiagnostic[] {
    const targets = options.channelId
      ? [options.channelId]
      : this.listChannels().map(channel => channel.sessionId);
    const inputs = [];
    for (const target of targets) {
      const cache = this.ensureChannelFullyLoaded(target);
      if (!cache) continue;
      inputs.push({ channelId: cache.channelId, entries: cache.entries });
    }
    return buildCogSecTombstoneDiagnostics(inputs);
  }
  async applyCogSecCompactionInvalidations(
    options: CogSecCompactionInvalidationOptions,
  ): Promise<CogSecCompactionInvalidationResult> {
    return this.cogSecOperations.applyCogSecCompactionInvalidations(options);
  }
  async applyCogSecCompactionRegenerations(
    options: CogSecCompactionRegenerationOptions,
  ): Promise<CogSecCompactionRegenerationResult> {
    return this.cogSecOperations.applyCogSecCompactionRegenerations(options);
  }
  /**
   * Longest prefix that a scalar compaction boundary may safely cover.
   * Read projections override this when they can temporarily hide a row that
   * may become visible later; the raw journal has no such projection gaps.
   */
  getCompactionBoundarySafePrefix(
    _channelId: string,
    proposedEntries: readonly SessionEntry[],
  ): SessionEntry[] {
    return [...proposedEntries];
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
        // Compactions consume an entry id: keep the tail's contiguity
        // invariant with an explicit placeholder.
        this.tailOperations.writeSessionTailGapThrough(channelId, id);
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
      // Extraction markers consume an entry id: keep the tail's contiguity
      // invariant with an explicit placeholder.
      this.tailOperations.writeSessionTailGapThrough(cache.channelId, id);
    });
  }
  private async appendTurnTombstone(
    channelId: string,
    turnId: string,
    action: 'redact' | 'restore',
    options: { actor?: string; reason?: string; timestamp?: number } = {},
  ): Promise<void> {
    this.refreshChannelIndexFromDisk();
    const logicalSessionId = this.resolveSessionId(channelId) ?? channelId;
    await this.withTurnRecordEligibilityMutationFence(
      logicalSessionId,
      turnId,
      () => this.appendTurnTombstoneUnderFence(channelId, turnId, action, options),
    );
  }
  private async appendTurnTombstoneUnderFence(
    channelId: string,
    turnId: string,
    action: 'redact' | 'restore',
    options: { actor?: string; reason?: string; timestamp?: number } = {},
  ): Promise<void> {
    const parsedTurnId = parseTurnId(turnId, 'turnId');
    if (!parsedTurnId) {
      throw new Error('Turn tombstone requires a valid TurnID');
    }

    // Redact/restore changes the visible entry set: fence the shared tail
    // BEFORE the tombstone lands so no process can keep serving the
    // pre-tombstone window. A failed bump aborts the redaction (fail-closed).
    await this.tailOperations.bumpSessionTailEpoch(channelId, `turn_tombstone_${action}`);
    const timestamp = options.timestamp ?? Date.now();
    // Second fence AFTER the tombstone landed, exception-safe: closes the
    // race where another process repopulated the post-bump epoch from a
    // pre-tombstone journal read, even when a post-journal step (cache
    // rebuild, index/projection sync) throws (see applyCogSecTombstones).
    await this.tailOperations.withPostRewriteTailFence(channelId, `turn_tombstone_${action}`, (markRewritten) => this.withLockedChannelWrite(
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
        markRewritten();

        const full = cache.fullyLoaded ? cache : this.ensureChannelFullyLoaded(channelId);
        if (full) {
          full.entries = this.applyTurnTombstonesToEntries(full.entries, full.turnTombstones);
          full.messageCount = full.entries.length;
          full.activeTurnTombstoneCount = full.turnTombstones.size;
          syncLastMessageMetadataFromEntries(full);
          this.upsertChannelIndex(channelId, snapshotIndexEntry(full));
          // Turn redaction removes entries from the projected set, so a failed
          // sync may leave redacted content searchable — fail closed (bead
          // 6oott). A restore failure only over-hides, which is safe as
          // ordinary best-effort drift.
          this.syncTranscriptProjectionForChannel(channelId, full.entries, {
            redaction: action === 'redact',
          });
        }
      },
    ));
  }
  async redactTurn(
    channelId: string,
    turnId: string,
    options: { actor?: string; reason?: string; timestamp?: number } = {},
  ): Promise<void> {
    await this.appendTurnTombstone(channelId, turnId, 'redact', options);
  }
  async restoreTurn(
    channelId: string,
    turnId: string,
    options: { actor?: string; reason?: string; timestamp?: number } = {},
  ): Promise<void> {
    await this.appendTurnTombstone(channelId, turnId, 'restore', options);
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

      withSessionJournalWriteLock(cache.archivePaths[0]!, () => {
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
          // Shutdown markers consume an entry id: keep the tail's contiguity
          // invariant with an explicit placeholder.
          this.tailOperations.writeSessionTailGapThrough(channelId, id);
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
      ensureChannelIndexEntry: (channelId, filePaths) => {
        const indexEntry = this.channelIndex.get(channelId);
        const logicalChannelId = indexEntry ? indexedChannelId(channelId, indexEntry) : channelId;
        return this.ensureChannelIndexEntry(channelId, logicalChannelId, filePaths);
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
