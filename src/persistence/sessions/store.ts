import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEntry, CompactionSummary, JournalEntry } from '../../core/session/types.js';
import type { CogSecEventStore, CogSecAction } from '../../core/cogsec/events.js';
import type { CogSecForensicArchive } from '../../core/cogsec/forensic-archive.js';
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
  type TranscriptSearchOptions,
} from './transcript-projection-port.js';
import { createFilesystemSessionArchivePort } from '../journals/journal/port.js';
import {
  validateSessionTailWindow,
  type SessionTailCachePort,
  type SessionTailRow,
} from './session-tail-cache-port.js';
import { createFilesystemTurnRecordStorePort } from './turn-records.js';
import { withCrossProcessWriteLock } from './cross-process-write-lock.js';
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
import {
  buildCogSecInvalidatedSummaryContent,
  buildCogSecTombstoneContent,
  buildCogSecTombstoneMetadata,
  isCogSecInvalidatedSummaryContent,
  normalizeCogSecCaseId,
  parseCogSecTombstoneCaseId,
} from '../../core/cogsec/tombstones.js';
import {
  buildCogSecInvalidatedCompactionJournalEntry,
  buildCogSecTombstoneJournalEntry,
  isSelectedCogSecMessage,
  normalizeCogSecRegeneratedSummary,
  normalizeCogSecSelector,
  normalizeEntryId,
  uniqueStrings,
} from './store/cogsec-journal-helpers.js';
const log = createComponentLogger('SessionStore');
const MAX_RECENT_ENTRY_CACHE_LIMITS = 8;
const JOURNAL_WRITE_LOCK_SUFFIX = '.write-lock';
const JOURNAL_WRITE_LOCK_POLL_MS = 10;
const JOURNAL_WRITE_LOCK_STALE_MS = 30_000;
const JOURNAL_WRITE_LOCK_TIMEOUT_MS = 5_000;
/**
 * Total records the tombstone-filtering turn-record read is allowed to scan.
 * One active tombstone must never turn a bounded tail read into a full-history
 * scan of a multi-GiB archive; hitting this cap warns loudly and serves a
 * partial window instead.
 */
const TURN_RECORD_TOMBSTONE_OVERSCAN_MAX_RECORDS = 2_048;
/** Initial overscan multiplier for tombstone-filtered turn-record reads. */
const TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR = 4;
const TAIL_DEGRADED_WARN_INTERVAL_MS = 30_000;
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

type CogSecEventMetadataStore = Pick<CogSecEventStore, 'getEvent' | 'updateEvent'>;
type CogSecForensicArchiveWriter = Pick<CogSecForensicArchive, 'sealArtifact'>;

export interface CogSecL0TombstoneOptions {
  channelId: string;
  caseId: string;
  eventStore: CogSecEventMetadataStore;
  forensicArchive: CogSecForensicArchiveWriter;
  messageIds?: readonly number[];
  startEntryId?: number;
  endEntryId?: number;
  actor?: string;
  timestamp?: number;
}

export interface CogSecL0TombstoneResult {
  caseId: string;
  sourceChannelId: string;
  logicalSessionId: string;
  tombstonedL0RowCount: number;
  tombstonedMessageIds: number[];
  sealedForensicPayloadRef?: string;
  sealedForensicPayloadHash?: string;
}

export interface CogSecTombstoneChannelDiagnostic {
  channelId: string;
  rowCount: number;
  messageIds: number[];
}

export interface CogSecTombstoneDiagnostic {
  caseId: string;
  rowCount: number;
  channels: CogSecTombstoneChannelDiagnostic[];
}

export interface CogSecCompactionInvalidationOptions {
  channelId: string;
  caseId: string;
  compactionIds: readonly number[];
}

export interface CogSecCompactionInvalidationResult {
  caseId: string;
  channelId: string;
  invalidatedCompactionIds: number[];
}

export interface CogSecCompactionRegenerationSummary {
  compactionId: number;
  summary: string;
}

export interface CogSecCompactionRegenerationOptions {
  channelId: string;
  caseId: string;
  summaries: readonly CogSecCompactionRegenerationSummary[];
}

export interface CogSecCompactionRegenerationResult {
  caseId: string;
  channelId: string;
  regeneratedCompactionIds: number[];
  skippedCompactionIds: number[];
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

function withJournalWriteLock<T>(filePath: string, operation: () => T): T {
  return withCrossProcessWriteLock(`${filePath}${JOURNAL_WRITE_LOCK_SUFFIX}`, {
    pollMs: JOURNAL_WRITE_LOCK_POLL_MS,
    staleMs: JOURNAL_WRITE_LOCK_STALE_MS,
    timeoutMs: JOURNAL_WRITE_LOCK_TIMEOUT_MS,
  }, operation);
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
  /** Optional shared hot tail (psfn-framework-hgw3.5); null = file-only behavior. */
  private tailCache: SessionTailCachePort | null;
  /** Serializes fire-and-forget tail writes so per-channel ops keep call order. */
  private tailWriteChain: Promise<void> = Promise.resolve();
  /**
   * Channels whose Redis tail must not be trusted until repopulated: a tail
   * write failed (possible gap) or a journal rewrite invalidated the window.
   * Local-process poison flag backing the cross-process DEL.
   */
  private tailRefreshRequiredChannels = new Set<string>();
  private tailDegradedLastWarnAt = 0;
  private tailDegradedSuppressedCount = 0;
  constructor(sessionsDir: string, options: SessionStoreOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.channelIndexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
    this.importManifestPath = join(sessionsDir, IMPORT_MANIFEST_FILENAME);
    const integrityProvider = options.integrityProvider
      ?? createKeyringIntegrityProvider(options.integrityKeyring ?? null);
    this.journalRuntime = new SessionJournalRuntime(
      integrityProvider,
      options.sessionArchivePort ?? createFilesystemSessionArchivePort(),
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
    this.tailCache = options.tailCache ?? null;
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
    if (!cache.fullyLoaded) return false;
    return cache.archiveFingerprint === this.fingerprintArchive(cache);
  }
  private ensureChannelFullyLoaded(channelId: string): ChannelCache | null {
    const resolvedSessionId = this.resolveSessionId(channelId) ?? channelId;
    const existing = this.channels.get(resolvedSessionId);
    if (existing?.fullyLoaded && this.fullyLoadedCacheIsCurrent(existing)) return existing;
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
      archiveFingerprint: this.journalRuntime.fingerprintArchive(archive),
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
  private readEntriesBeforeFromArchive(
    channelId: string,
    filePath: string,
    beforeId: number,
    limit: number,
  ): SessionEntry[] {
    return this.journalRuntime.readEntriesBefore(
      this.journalRuntime.openArchive(channelId, filePath),
      beforeId,
      limit,
    );
  }
  private fingerprintArchive(cache: ChannelCache): string | null {
    return this.journalRuntime.fingerprintArchive(
      this.journalRuntime.openArchive(cache.channelId, cache.resolvedPath),
    );
  }
  private resolveTailChannelKey(channelId: string): string {
    return this.resolveSessionId(channelId) ?? channelId;
  }
  /**
   * Redis degraded: LOUD warn, rate-limited per occurrence window. A companion
   * that stops replying because Redis blipped is worse than one on slow file
   * reads, so tail failures degrade to the journal path and are logged, never
   * hidden and never rethrown into the turn.
   */
  private markSessionTailDegraded(channelKey: string, operation: string, error: unknown): void {
    this.tailRefreshRequiredChannels.add(channelKey);
    const now = Date.now();
    if (now - this.tailDegradedLastWarnAt < TAIL_DEGRADED_WARN_INTERVAL_MS) {
      this.tailDegradedSuppressedCount += 1;
      return;
    }
    const suppressed = this.tailDegradedSuppressedCount;
    this.tailDegradedLastWarnAt = now;
    this.tailDegradedSuppressedCount = 0;
    log.warn('Session tail cache degraded; serving journal reads until the tail repopulates', {
      channelKey,
      operation,
      suppressedSinceLastWarn: suppressed,
      error: toErrorMessage(error),
    });
  }
  /**
   * Serialize fire-and-forget tail writes. The journal write already
   * succeeded by the time these run; a tail failure only poisons the channel
   * tail (forced refresh) and warns — it never fails the caller.
   */
  private queueSessionTailWrite(
    channelKey: string,
    operation: string,
    op: () => Promise<void>,
  ): void {
    this.tailWriteChain = this.tailWriteChain.then(async () => {
      try {
        await op();
      } catch (error) {
        this.markSessionTailDegraded(channelKey, operation, error);
      }
    });
  }
  /** Write-through after a durable journal append (write path holds the journal lock). */
  private writeSessionTailRowThrough(channelId: string, row: SessionTailRow): void {
    const port = this.tailCache;
    if (!port) return;
    const channelKey = this.resolveTailChannelKey(channelId);
    // Capture the epoch AT ENQUEUE time (the GET is issued now, while the row
    // data is fresh under the journal lock), never at write-execution time: a
    // queued append that captured pre-rewrite content must land under the
    // pre-rewrite epoch key, where a rewrite's fence bumps make it
    // structurally unreadable. Rejections surface when the queued op awaits
    // the promise; the no-op catch only prevents a spurious
    // unhandled-rejection between enqueue and execution.
    const epochAtEnqueue = port.getEpoch(channelKey);
    epochAtEnqueue.catch(() => { /* handled where awaited on the write chain */ });
    this.queueSessionTailWrite(channelKey, 'append', async () => {
      const epoch = await epochAtEnqueue;
      if (this.tailRefreshRequiredChannels.has(channelKey)) {
        // A prior tail write failed: the tail may hide a gap. Drop it before
        // appending so readers fall back to the journal until repopulation.
        await port.invalidateChannel(channelKey, epoch);
        this.tailRefreshRequiredChannels.delete(channelKey);
      }
      await port.appendRow(channelKey, epoch, row);
    });
  }
  private writeSessionTailThrough(channelId: string, entry: SessionEntry): void {
    this.writeSessionTailRowThrough(channelId, { kind: 'message', entry });
  }
  /**
   * Non-message journal entries (compactions, extraction markers, shutdown
   * markers) consume entry ids too. Write an explicit id-gap placeholder so
   * the tail's ID CONTIGUITY invariant keeps holding: without it every
   * non-message append would read as a lost tail write and force a miss.
   */
  private writeSessionTailGapThrough(channelId: string, id: number): void {
    this.writeSessionTailRowThrough(channelId, { kind: 'id_gap', id });
  }
  /**
   * Advance the shared per-channel tail epoch. Every journal REWRITE path
   * (CogSec tombstone/compaction rewrites, turn tombstones, post-repair
   * reloads) MUST await this before the rewrite completes: the epoch bump is
   * what makes every pre-rewrite tail row unreadable in EVERY process, so
   * security redactions can never be resurrected from Redis. Fail-closed: a
   * failed bump aborts the rewrite loudly instead of leaving other processes
   * able to serve pre-rewrite content.
   *
   * Queued tail writes are drained first so a repopulation captured before
   * the rewrite can only ever land under the old (fenced-off) epoch.
   */
  private async bumpSessionTailEpoch(channelId: string, reason: string): Promise<void> {
    const port = this.tailCache;
    if (!port) return;
    const channelKey = this.resolveTailChannelKey(channelId);
    this.tailRefreshRequiredChannels.add(channelKey);
    await this.tailWriteChain;
    try {
      await port.bumpEpoch(channelKey);
    } catch (error) {
      throw new Error(
        `Session tail epoch bump failed for channel ${channelKey} (${reason}); `
        + `refusing to complete the journal rewrite while other processes could `
        + `serve the pre-rewrite tail: ${toErrorMessage(error)}`,
      );
    }
    this.tailRefreshRequiredChannels.delete(channelKey);
  }
  /**
   * Run a journal-rewrite body and GUARANTEE the post-rewrite epoch bump
   * executes once the journal mutation is durable — even when a step between
   * the rewrite and the bump throws (projection sync, index update, event
   * store bookkeeping). The body calls `markRewritten()` immediately after
   * the journal mutation lands; if it was called, the second fence runs on
   * BOTH the success and the failure path. `bumpSessionTailEpoch` poisons the
   * local tail (refresh flag) before attempting the INCR, so even a failed
   * bump leaves local state safe while still throwing loudly (fail-closed).
   */
  private async withPostRewriteTailFence<T>(
    channelId: string,
    reason: string,
    body: (markRewritten: () => void) => T,
  ): Promise<T> {
    const state = { rewritten: false };
    let result: T;
    try {
      result = body(() => {
        state.rewritten = true;
      });
    } catch (error) {
      if (state.rewritten) {
        try {
          await this.bumpSessionTailEpoch(channelId, `${reason}:post`);
        } catch (bumpError) {
          // Neither failure may be swallowed: the caller sees both.
          throw new AggregateError(
            [error, bumpError],
            `Journal rewrite failed after mutating the journal AND the post-rewrite `
            + `tail fence failed for channel ${channelId} (${reason}): `
            + `${toErrorMessage(error)}; ${toErrorMessage(bumpError)}`,
          );
        }
      }
      throw error;
    }
    if (state.rewritten) {
      await this.bumpSessionTailEpoch(channelId, `${reason}:post`);
    }
    return result;
  }
  /** Rebuild the Redis tail from the journal-backed recent window (fire-and-forget). */
  private repopulateSessionTail(channelId: string, channelKey: string): void {
    const port = this.tailCache;
    if (!port) return;
    this.queueSessionTailWrite(channelKey, 'repopulate', async () => {
      // ORDER MATTERS: resolve the epoch BEFORE capturing the journal data,
      // then write to that captured epoch's key only. Under the two-bump
      // rewrite protocol this is airtight: data captured after an epoch read
      // that predates the post-rewrite bump lands under a key that bump
      // supersedes, and an epoch read after the post-rewrite bump can only
      // see post-rewrite journal state. Resolving the epoch at write time
      // (or capturing data before the epoch) would let a delayed
      // repopulation resurrect pre-rewrite content under the new epoch.
      const epoch = await port.getEpoch(channelKey);
      const entries = this.getRecent(channelId, port.maxEntriesPerChannel);
      const rows: SessionTailRow[] = [];
      let previousId: number | null = null;
      for (const entry of entries) {
        if (previousId !== null && entry.id - previousId > port.maxEntriesPerChannel) {
          // Absurd id jump (corrupt window): keep only the newest contiguous
          // run instead of synthesizing an unbounded placeholder range.
          rows.length = 0;
        } else if (previousId !== null) {
          for (let gapId = previousId + 1; gapId < entry.id; gapId += 1) {
            rows.push({ kind: 'id_gap', id: gapId });
          }
        }
        rows.push({ kind: 'message', entry });
        previousId = entry.id;
      }
      await port.replaceTail(channelKey, epoch, rows);
      this.tailRefreshRequiredChannels.delete(channelKey);
    });
  }
  /**
   * Fetch the shared hot tail for a capture read (psfn-framework-hgw3.5).
   * Returns null when the tail cache is disabled, degraded, poisoned,
   * epoch-fenced (a journal rewrite bumped the channel epoch, making every
   * pre-rewrite row unreadable), non-contiguous (a lost tail write from any
   * process leaves an id hole the max-id freshness check alone would miss),
   * or BEHIND the just-recorded entry id (`expectedMinEntryId`) — callers
   * then stay on the journal-backed path (byte-identical behavior) while the
   * tail repopulates in the background. Integrates with the hgw3.1
   * stale-window heal guard: `reloadChannelFromDisk` bumps the epoch, so a
   * heal recapture never re-reads the window that was just diagnosed as
   * stale.
   */
  async fetchSessionTailWindow(
    channelId: string,
    options: { expectedMinEntryId?: number } = {},
  ): Promise<SessionEntry[] | null> {
    const port = this.tailCache;
    if (!port) return null;
    const channelKey = this.resolveTailChannelKey(channelId);
    if (!this.tailRefreshRequiredChannels.has(channelKey)) {
      let messages: SessionEntry[] = [];
      let maxRowId: number | null = null;
      try {
        ({ messages, maxRowId } = validateSessionTailWindow(await port.getTail(channelKey)));
      } catch (error) {
        // Fall through to repopulation: duplicate/gapped windows and Redis
        // errors alike degrade loudly to the journal path. If Redis is down
        // the repopulation fails quietly on the queued chain and the channel
        // stays poisoned until it recovers.
        this.markSessionTailDegraded(channelKey, 'read', error);
        messages = [];
        maxRowId = null;
      }
      if (messages.length > 0 && maxRowId !== null) {
        if (options.expectedMinEntryId === undefined || maxRowId >= options.expectedMinEntryId) {
          return messages;
        }
        log.warn('Session tail cache is behind the just-recorded entry; falling back to journal reads and repopulating', {
          channelKey,
          tailMaxEntryId: maxRowId,
          expectedMinEntryId: options.expectedMinEntryId,
        });
      }
    }
    this.repopulateSessionTail(channelId, channelKey);
    return null;
  }
  /** Flush queued tail writes (tests and shutdown). */
  async flushSessionTailWrites(): Promise<void> {
    await this.tailWriteChain;
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
    if (cached.archiveFingerprint !== this.fingerprintArchive(cache)) return null;
    return [...cached.entries];
  }
  private writeCachedRecentEntries(
    cache: ChannelCache,
    limit: number,
    entries: SessionEntry[],
    archiveFingerprintBeforeRead: string | null,
  ): void {
    if (cache.fullyLoaded) return;
    const archiveFingerprint = this.fingerprintArchive(cache);
    if (!archiveFingerprint || archiveFingerprint !== archiveFingerprintBeforeRead) {
      return;
    }
    cache.recentEntriesByLimit.set(limit, {
      fingerprint: this.buildRecentEntriesFingerprint(cache),
      archiveFingerprint,
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
        this.writeSessionTailThrough(entry.channelId, full);
        return id;
      },
    );
  }
  appendTurnRecord(record: TurnRecord): void {
    this.turnRecordStore.appendTurnRecord(record);
  }
  getRecentTurnRecords(channelId: string, limit: number): TurnRecord[] {
    if (limit <= 0) return [];
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    let cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    // Fingerprint gate (same guarantee as fullyLoadedCacheIsCurrent for entry
    // reads, psfn-framework-hgw3.1): cached tombstone state — INCLUDING a
    // cached count of zero — is only trustworthy while the journal on disk is
    // the file this process last saw. Another process's tombstone-adding
    // journal rewrite replaces the archive, so reload before trusting it.
    if (cached && !this.fullyLoadedCacheIsCurrent(cached)) {
      cached = this.ensureChannelFullyLoaded(channelId) ?? cached;
    }
    const tombstones = cached?.fullyLoaded ? cached.turnTombstones : null;
    if (!tombstones || tombstones.size === 0) {
      return this.turnRecordStore.readRecentTurnRecords(sessionId, limit);
    }
    return this.readTombstoneFilteredTurnRecords(sessionId, limit, tombstones);
  }
  /**
   * Bounded iterative overscan for tombstone-filtered turn-record reads:
   * request a small multiple of the limit, filter tombstoned turns, and only
   * widen (doubling) while the segment files still have older records to
   * offer. Capped at TURN_RECORD_TOMBSTONE_OVERSCAN_MAX_RECORDS so one active
   * tombstone can never force a full-history scan of a large archive.
   */
  private readTombstoneFilteredTurnRecords(
    sessionId: string,
    limit: number,
    tombstones: ReadonlySet<string>,
  ): TurnRecord[] {
    const scanCap = Math.max(TURN_RECORD_TOMBSTONE_OVERSCAN_MAX_RECORDS, limit);
    let requested = Math.min(limit * TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR, scanCap);
    for (;;) {
      const records = this.turnRecordStore.readRecentTurnRecords(sessionId, requested);
      const filtered = records.filter(record => !tombstones.has(record.turnId));
      // Fewer records than requested means the whole archive is already read.
      const exhaustedHistory = records.length < requested;
      if (filtered.length >= limit || exhaustedHistory) {
        return filtered.length > limit ? filtered.slice(-limit) : filtered;
      }
      if (requested >= scanCap) {
        log.warn('Turn-record tombstone overscan hit its scan cap; serving a partial window', {
          sessionId,
          limit,
          scannedRecords: records.length,
          scanCap,
          survivingRecords: filtered.length,
        });
        return filtered;
      }
      requested = Math.min(requested * 2, scanCap);
    }
  }
  async searchByKeywords(
    query: string,
    limit = 10,
    options: TranscriptSearchOptions = {},
  ): Promise<SessionSearchHit[]> {
    if (!this.transcriptSearch) return [];
    const requestedChannelId = options.channelId?.trim();
    if (!requestedChannelId) {
      return await this.transcriptSearch.searchByKeywords(query, limit);
    }
    const scopedChannelId = this.resolveSessionId(requestedChannelId) ?? requestedChannelId;
    const hits = await this.transcriptSearch.searchByKeywords(query, limit, { channelId: scopedChannelId });
    // Fail closed: never return out-of-scope rows even if an injected search
    // backend ignores the channel filter.
    return hits.filter(hit => hit.channelId === scopedChannelId);
  }
  rebuildSearchIndex(): void {
    this.backfillTranscriptProjectionFromDisk();
  }
  getRecent(channelId: string, limit: number): SessionEntry[] {
    if (limit <= 0) return [];
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded) {
      const current = this.fullyLoadedCacheIsCurrent(cached)
        ? cached
        : this.ensureChannelFullyLoaded(channelId);
      if (!current) return [];
      if (current.entries.length <= limit) return [...current.entries];
      return current.entries.slice(-limit);
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
    const archiveFingerprintBeforeRead = cached ? this.fingerprintArchive(cached) : null;
    const recentEntries = this.readRecentEntriesFromTail(resolved.channelId, resolved.filePath, limit);
    if (cached) {
      this.writeCachedRecentEntries(cached, limit, recentEntries, archiveFingerprintBeforeRead);
    }
    return recentEntries;
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
    await this.bumpSessionTailEpoch(channelId, 'reload_channel_from_disk');
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
  getLastEntry(channelId: string): SessionEntry | undefined {
    const entries = this.getRecent(channelId, 1);
    return entries[entries.length - 1];
  }
  getEntriesBefore(channelId: string, beforeId: number, limit: number): SessionEntry[] {
    if (!Number.isFinite(beforeId) || !Number.isFinite(limit)) return [];
    const normalizedBeforeId = Math.max(0, Math.floor(beforeId));
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedBeforeId <= 0 || normalizedLimit <= 0) return [];

    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded) {
      const current = this.fullyLoadedCacheIsCurrent(cached)
        ? cached
        : this.ensureChannelFullyLoaded(channelId);
      if (!current) return [];
      const eligible = current.entries.filter(entry => entry.id < normalizedBeforeId);
      return eligible.length <= normalizedLimit ? eligible : eligible.slice(-normalizedLimit);
    }

    const resolved = cached
      ? { sessionId, channelId: cached.channelId, filePath: cached.resolvedPath }
      : this.resolveExistingSession(channelId);
    if (!resolved) return [];
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePath);
    if (cached) this.syncLightweightCacheFromIndexEntry(cached, indexEntry);
    if ((normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0) === 0) return [];

    // Active tombstones require global turn state; preserve the existing
    // fail-closed projection by replaying the archive before slicing.
    if ((normalizeOptionalNonNegativeNumber(indexEntry.activeTurnTombstoneCount) ?? 0) > 0) {
      const full = this.ensureChannelFullyLoaded(channelId);
      if (!full) return [];
      const eligible = full.entries.filter(entry => entry.id < normalizedBeforeId);
      return eligible.length <= normalizedLimit ? eligible : eligible.slice(-normalizedLimit);
    }

    return this.readEntriesBeforeFromArchive(
      resolved.channelId,
      resolved.filePath,
      normalizedBeforeId,
      normalizedLimit,
    );
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
  async applyCogSecTombstones(options: CogSecL0TombstoneOptions): Promise<CogSecL0TombstoneResult> {
    const caseId = normalizeCogSecCaseId(options.caseId);
    const event = options.eventStore.getEvent(caseId);
    if (!event) {
      throw new Error(`CogSec event not found: ${caseId}`);
    }
    const selector = normalizeCogSecSelector(options);
    const timestamp = options.timestamp ?? Date.now();
    const redactedAt = new Date(timestamp).toISOString();

    // Fence the shared tail BEFORE rewriting: a failed bump aborts the
    // redaction while the journal is still untouched (fail-closed).
    await this.bumpSessionTailEpoch(options.channelId, 'cogsec_tombstone_rewrite');
    // Second fence AFTER the rewrite (exception-safe): closes the race where
    // another process repopulated the post-bump epoch from a journal read
    // taken before the rewrite landed. Runs even when a post-rewrite step
    // (reload, projection sync, event bookkeeping) throws.
    const result = await this.withPostRewriteTailFence(options.channelId, 'cogsec_tombstone_rewrite', (markRewritten) => this.withLockedExistingChannelWrite(options.channelId, (cache) => {
      const archive = this.journalRuntime.openArchive(cache.channelId, cache.resolvedPath);
      const rawEntries = this.journalRuntime.readJournalEntries(archive);
      const selectedRows = rawEntries.filter(entry => isSelectedCogSecMessage(entry, selector));
      const selectedMessageIds = selectedRows.map(entry => entry.id);
      if (selectedRows.length === 0) {
        return {
          caseId,
          sourceChannelId: event.sourceChannelId,
          logicalSessionId: cache.channelId,
          tombstonedL0RowCount: 0,
          tombstonedMessageIds: [],
        } satisfies CogSecL0TombstoneResult;
      }

      const sealed = options.forensicArchive.sealArtifact({
        caseId,
        kind: 'l0_rows',
        sourceChannelId: event.sourceChannelId,
        logicalSessionId: cache.channelId,
        payload: {
          caseId,
          sourceChannelId: event.sourceChannelId,
          logicalSessionId: cache.channelId,
          selectedMessageIds,
          rows: selectedRows,
        },
      });

      const tombstoneContent = buildCogSecTombstoneContent(caseId);
      const tombstoneMetadata = buildCogSecTombstoneMetadata({
        caseId,
        redactedAt,
        actor: options.actor,
      });
      const selectedIdSet = new Set(selectedMessageIds);
      const rewrittenEntries = rawEntries.map(entry => (
        entry.type === 'message' && selectedIdSet.has(entry.id)
          ? buildCogSecTombstoneJournalEntry(entry, tombstoneContent, tombstoneMetadata)
          : entry
      ));

      this.journalRuntime.rewriteJournalEntries(archive, rewrittenEntries);
      markRewritten();
      const reloaded = this.journalRuntime.loadChannel(archive);
      const sessionKey = this.resolveCacheSessionKey(cache);
      this.channels.set(sessionKey, reloaded);
      this.upsertChannelIndex(sessionKey, snapshotIndexEntry(reloaded));
      this.syncTranscriptProjectionForChannel(reloaded.channelId, reloaded.entries);

      const currentEvent = options.eventStore.getEvent(caseId) ?? event;
      const affectedMessageRanges = [
        ...currentEvent.affectedMessageRanges,
        {
          sourceChannelId: event.sourceChannelId,
          logicalSessionId: cache.channelId,
          messageIds: selectedMessageIds,
        },
      ];
      const nextActions = uniqueStrings([
        ...currentEvent.actions,
        'seal',
        'tombstone',
      ] satisfies CogSecAction[]);

      options.eventStore.updateEvent(caseId, {
        affectedLogicalSessionIds: uniqueStrings([
          ...currentEvent.affectedLogicalSessionIds,
          cache.channelId,
        ]),
        affectedMessageRanges,
        sealedForensicPayloadRefs: uniqueStrings([
          ...currentEvent.sealedForensicPayloadRefs,
          sealed.ref,
        ]),
        sealedForensicPayloadHashes: uniqueStrings([
          ...currentEvent.sealedForensicPayloadHashes,
          sealed.sha256,
        ]),
        tombstonedL0RowCount: currentEvent.tombstonedL0RowCount + selectedRows.length,
        actions: nextActions,
        resultCounters: {
          ...currentEvent.resultCounters,
          sealedArtifacts: (currentEvent.resultCounters.sealedArtifacts ?? 0) + 1,
          tombstonedL0Rows: (currentEvent.resultCounters.tombstonedL0Rows ?? 0) + selectedRows.length,
        },
      });

      return {
        caseId,
        sourceChannelId: event.sourceChannelId,
        logicalSessionId: cache.channelId,
        tombstonedL0RowCount: selectedRows.length,
        tombstonedMessageIds: selectedMessageIds,
        sealedForensicPayloadRef: sealed.ref,
        sealedForensicPayloadHash: sealed.sha256,
      } satisfies CogSecL0TombstoneResult;
    }));

    if (!result) {
      throw new Error(`Session channel not found for CogSec tombstone: ${options.channelId}`);
    }
    return result;
  }
  listCogSecTombstoneDiagnostics(options: { channelId?: string } = {}): CogSecTombstoneDiagnostic[] {
    const targets = options.channelId
      ? [options.channelId]
      : this.listChannels().map(channel => channel.sessionId);
    const byCase = new Map<string, Map<string, number[]>>();

    for (const target of targets) {
      const cache = this.ensureChannelFullyLoaded(target);
      if (!cache) continue;
      for (const entry of cache.entries) {
        const caseId = parseCogSecTombstoneCaseId(entry);
        if (!caseId) continue;
        let channels = byCase.get(caseId);
        if (!channels) {
          channels = new Map<string, number[]>();
          byCase.set(caseId, channels);
        }
        const messageIds = channels.get(cache.channelId) ?? [];
        messageIds.push(entry.id);
        channels.set(cache.channelId, messageIds);
      }
    }

    return [...byCase.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([caseId, channelsById]) => {
        const channels = [...channelsById.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([channelId, messageIds]) => ({
            channelId,
            messageIds: [...messageIds].sort((left, right) => left - right),
            rowCount: messageIds.length,
          }));
        return {
          caseId,
          rowCount: channels.reduce((sum, channel) => sum + channel.rowCount, 0),
          channels,
        };
      });
  }
  async applyCogSecCompactionInvalidations(
    options: CogSecCompactionInvalidationOptions,
  ): Promise<CogSecCompactionInvalidationResult> {
    const caseId = normalizeCogSecCaseId(options.caseId);
    const compactionIds = new Set(options.compactionIds.map((id, index) => (
      normalizeEntryId(id, `compactionIds[${index}]`)
    )));
    if (compactionIds.size === 0) {
      throw new Error('CogSec compaction invalidation requires at least one compaction ID');
    }

    // Fence the shared tail BEFORE rewriting (fail-closed redaction).
    await this.bumpSessionTailEpoch(options.channelId, 'cogsec_compaction_invalidation');
    // Second fence AFTER the rewrite, exception-safe (see applyCogSecTombstones).
    const result = await this.withPostRewriteTailFence(options.channelId, 'cogsec_compaction_invalidation', (markRewritten) => this.withLockedExistingChannelWrite(options.channelId, (cache) => {
      const archive = this.journalRuntime.openArchive(cache.channelId, cache.resolvedPath);
      const rawEntries = this.journalRuntime.readJournalEntries(archive);
      const selectedIds = rawEntries
        .filter(entry => entry.type === 'compaction' && compactionIds.has(entry.id))
        .map(entry => entry.id);
      if (selectedIds.length === 0) {
        return {
          caseId,
          channelId: cache.channelId,
          invalidatedCompactionIds: [],
        } satisfies CogSecCompactionInvalidationResult;
      }

      const invalidatedSummary = buildCogSecInvalidatedSummaryContent(caseId);
      const selectedIdSet = new Set(selectedIds);
      const rewrittenEntries = rawEntries.map(entry => (
        entry.type === 'compaction' && selectedIdSet.has(entry.id)
          ? buildCogSecInvalidatedCompactionJournalEntry(entry, invalidatedSummary)
          : entry
      ));

      this.journalRuntime.rewriteJournalEntries(archive, rewrittenEntries);
      markRewritten();
      const reloaded = this.journalRuntime.loadChannel(archive);
      const sessionKey = this.resolveCacheSessionKey(cache);
      this.channels.set(sessionKey, reloaded);
      this.upsertChannelIndex(sessionKey, snapshotIndexEntry(reloaded));

      return {
        caseId,
        channelId: cache.channelId,
        invalidatedCompactionIds: selectedIds,
      } satisfies CogSecCompactionInvalidationResult;
    }));

    if (!result) {
      throw new Error(`Session channel not found for CogSec compaction invalidation: ${options.channelId}`);
    }
    return result;
  }
  async applyCogSecCompactionRegenerations(
    options: CogSecCompactionRegenerationOptions,
  ): Promise<CogSecCompactionRegenerationResult> {
    const caseId = normalizeCogSecCaseId(options.caseId);
    const summariesById = new Map<number, string>();
    for (const [index, summary] of options.summaries.entries()) {
      const compactionId = normalizeEntryId(summary.compactionId, `summaries[${index}].compactionId`);
      summariesById.set(
        compactionId,
        normalizeCogSecRegeneratedSummary(summary.summary, `summaries[${index}].summary`),
      );
    }
    if (summariesById.size === 0) {
      throw new Error('CogSec compaction regeneration requires at least one summary');
    }

    // Fence the shared tail BEFORE rewriting (fail-closed redaction).
    await this.bumpSessionTailEpoch(options.channelId, 'cogsec_compaction_regeneration');
    // Second fence AFTER the rewrite, exception-safe (see applyCogSecTombstones).
    const result = await this.withPostRewriteTailFence(options.channelId, 'cogsec_compaction_regeneration', (markRewritten) => this.withLockedExistingChannelWrite(options.channelId, (cache) => {
      const archive = this.journalRuntime.openArchive(cache.channelId, cache.resolvedPath);
      const rawEntries = this.journalRuntime.readJournalEntries(archive);
      const regeneratedIds: number[] = [];
      const skippedIds: number[] = [];
      const rewrittenEntries = rawEntries.map(entry => {
        if (entry.type !== 'compaction' || !summariesById.has(entry.id)) return entry;
        const currentSummary = entry.summary ?? '';
        if (!isCogSecInvalidatedSummaryContent(currentSummary)) {
          skippedIds.push(entry.id);
          return entry;
        }
        regeneratedIds.push(entry.id);
        return buildCogSecInvalidatedCompactionJournalEntry(entry, summariesById.get(entry.id)!);
      });

      for (const id of summariesById.keys()) {
        if (!regeneratedIds.includes(id) && !skippedIds.includes(id)) {
          skippedIds.push(id);
        }
      }

      if (regeneratedIds.length > 0) {
        this.journalRuntime.rewriteJournalEntries(archive, rewrittenEntries);
        markRewritten();
        const reloaded = this.journalRuntime.loadChannel(archive);
        const sessionKey = this.resolveCacheSessionKey(cache);
        this.channels.set(sessionKey, reloaded);
        this.upsertChannelIndex(sessionKey, snapshotIndexEntry(reloaded));
      }

      return {
        caseId,
        channelId: cache.channelId,
        regeneratedCompactionIds: regeneratedIds,
        skippedCompactionIds: skippedIds,
      } satisfies CogSecCompactionRegenerationResult;
    }));

    if (!result) {
      throw new Error(`Session channel not found for CogSec compaction regeneration: ${options.channelId}`);
    }
    return result;
  }
  getRecentDiscordMessageIds(channelId: string, limit: number): Set<string> {
    const entries = this.getRecent(channelId, limit);
    const ids = entries
      .map((entry) => entry.discordMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return new Set(ids);
  }
  count(channelId: string): number {
    let cached = this.getLoadedCache(channelId);
    // Frozen fullyLoaded caches must not serve counts across a sibling
    // process's journal rewrite (same fingerprint gate as entry reads).
    if (cached?.fullyLoaded && !this.fullyLoadedCacheIsCurrent(cached)) {
      cached = this.ensureChannelFullyLoaded(channelId) ?? cached;
    }
    if (cached) return cached.messageCount;
    const resolved = this.resolveExistingSession(channelId);
    if (!resolved) return 0;
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePath);
    return normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
  }
  getCompactionSummaries(channelId: string): CompactionSummary[] {
    // Compaction projection still requires canonical full-archive replay.
    // Garden's older-page requests use messagesOnly and skip this method; a
    // bounded compaction index belongs with the future L0 segment writer/index
    // contract rather than duplicating segment metadata in this read path.
    const cache = this.ensureChannelFullyLoaded(channelId);
    return cache ? [...cache.compactions] : [];
  }
  getSessionActivity(channelId: string): SessionActivitySummary | null {
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    let cached = this.getLoadedCache(channelId) ?? this.loadExistingChannelCache(channelId);
    // Same fingerprint gate as count(): a frozen fullyLoaded cache must not
    // serve activity metadata across a sibling process's journal rewrite.
    if (cached?.fullyLoaded && !this.fullyLoadedCacheIsCurrent(cached)) {
      cached = this.ensureChannelFullyLoaded(channelId) ?? cached;
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
        // Compactions consume an entry id: keep the tail's contiguity
        // invariant with an explicit placeholder.
        this.writeSessionTailGapThrough(channelId, id);
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
      this.writeSessionTailGapThrough(cache.channelId, id);
    });
  }
  private async appendTurnTombstone(
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
    await this.bumpSessionTailEpoch(channelId, `turn_tombstone_${action}`);
    const timestamp = options.timestamp ?? Date.now();
    // Second fence AFTER the tombstone landed, exception-safe: closes the
    // race where another process repopulated the post-bump epoch from a
    // pre-tombstone journal read, even when a post-journal step (cache
    // rebuild, index/projection sync) throws (see applyCogSecTombstones).
    await this.withPostRewriteTailFence(channelId, `turn_tombstone_${action}`, (markRewritten) => this.withLockedChannelWrite(
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
          this.syncTranscriptProjectionForChannel(channelId, full.entries);
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
          // Shutdown markers consume an entry id: keep the tail's contiguity
          // invariant with an explicit placeholder.
          this.writeSessionTailGapThrough(channelId, id);
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
