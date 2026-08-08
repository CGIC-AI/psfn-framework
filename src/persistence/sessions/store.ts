import { createHash } from 'node:crypto';
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
  journalToTurnTombstoneEntry,
} from '../journals/journal-utils.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  CHANNEL_INDEX_FILENAME,
  IMPORT_MANIFEST_FILENAME,
  L0_SESSION_FILE_MAX_BYTES,
  createKeyringIntegrityProvider,
  normalizeOptionalHmac,
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
import { readTurnTombstoneAuthoritySnapshot } from './turn-tombstone-authority.js';
import {
  slimTurnRecordSessionEntriesForAppend,
  resolveTurnRecordSessionEntries,
  type TurnRecordContinuityWithheld,
  type TurnRecordMessageWithheld,
  type TurnRecordRecentEntryHealDrop,
  type TurnRecordWireBodyWithheld,
} from './turn-record-session-refs.js';
import { slimTurnRecordMemoryCandidatesForAppend } from './turn-record-memory-refs.js';
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
  selectEligibleTurnRecordSnapshotEntries,
  sessionEntrySnapshotMatches,
  TurnRecordEligibilitySnapshotChangedError,
  TurnRecordEligibilitySnapshotInvalidError,
  type SourceTurnRecordEligibility,
} from './turn-record-eligibility-snapshot.js';
import { isTurnRecordRecoveryEvidenceError } from '../../core/agent/background-work/recovery-contract.js';
import { indexedChannelId, resolvePrimarySessionId } from './store/session-index-keys.js';
import { withSessionJournalWriteLock } from './store/session-journal-write-lock.js';
import { rollSessionArchiveIfNeeded } from './store/session-rollover.js';
import {
  applyLastMessageMetadata,
  syncLastMessageMetadataFromEntries,
} from './store/session-cache-metadata.js';
import {
  buildRecentEntriesFingerprint,
  fingerprintSessionJournalChain,
  fullyLoadedSessionChainIsCurrent,
  loadSessionJournalChain,
  readSessionJournalChain,
  reconcileSessionWriteChain,
  syncLightweightSessionCacheFromIndex,
} from './store/session-chain-cache.js';
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

const log = createComponentLogger('SessionStore');

/**
 * Process-lifetime count of turn-record `recentEntries` heal-drops (an id-backed
 * entry that was dropped on read because its L0 row is gone). Emitted as a stable
 * structured event with a running counter — mirroring the turn-record quarantine
 * telemetry in turn-records.ts, since no telemetry port is reachable from the
 * persistence layer. Lets operators distinguish legitimate redaction/rolloff
 * drops (this signal, expected) from structural ref corruption (fails closed
 * upstream and throws, never reaching here). See bead psfn-framework-hgw3.10.
 */
let recentEntryHealDropCount = 0;
function emitRecentEntryHealDrop(drop: TurnRecordRecentEntryHealDrop): void {
  recentEntryHealDropCount += 1;
  log.info('turn_record_recent_entry_heal_drop', {
    ...drop,
    healDropsThisProcess: recentEntryHealDropCount,
  });
}

/**
 * Process-lifetime count of captured wire bodies withheld on read because a
 * source L0 entry they embedded was redacted/removed (bead psfn-framework-eb14).
 * Emitted as a stable structured event with a running counter, mirroring the
 * recentEntries heal-drop telemetry above — no telemetry port is reachable from
 * the persistence layer. Lets operators see redaction propagating into the
 * observability wire surface.
 */
let wireBodyWithheldCount = 0;
function emitWireBodyWithheld(event: TurnRecordWireBodyWithheld): void {
  wireBodyWithheldCount += 1;
  log.info('turn_record_wire_body_withheld', {
    ...event,
    wireBodiesWithheldThisProcess: wireBodyWithheldCount,
  });
}

let turnMessageWithheldCount = 0;
function emitTurnMessageWithheld(event: TurnRecordMessageWithheld): void {
  turnMessageWithheldCount += 1;
  log.info('turn_record_message_withheld', {
    ...event,
    messagesWithheldThisProcess: turnMessageWithheldCount,
  });
}

let continuityWithheldCount = 0;
function emitContinuityWithheld(event: TurnRecordContinuityWithheld): void {
  continuityWithheldCount += 1;
  log.info('turn_record_continuity_withheld', {
    ...event,
    continuityEntriesWithheldThisProcess: continuityWithheldCount,
  });
}

const MAX_RECENT_ENTRY_CACHE_LIMITS = 8;
/** Initial overscan multiplier for tombstone-filtered turn-record reads. */
const TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR = 4;
/** Hard bound preventing a post-turn effect from turning one session into an unbounded lock set. */
const MAX_TURN_RECORD_ELIGIBILITY_SNAPSHOT_FENCES = 512;
const TAIL_DEGRADED_WARN_INTERVAL_MS = 30_000;
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
  private static readonly RECOVERY_AUTHORITY_LIMITS = Object.freeze({
    cacheOwners: 8,
    maxActionBytes: 256 * 1024,
    maxActions: 4_096,
    maxResultBytes: 2 * 1024 * 1024,
    maxRowBytes: 32 * 1024 * 1024,
    maxTombstones: 4_096,
    scanChunkBytes: 64 * 1024,
  });
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
  private recoveryTombstoneAuthority = new Map<string, {
    archiveFingerprint: string;
    baselineFingerprint: string;
    tombstones: Set<string>;
  }>();
  private readonly recoveryAuthoritySnapshotHook:
    ((ownerSessionId: string) => void | Promise<void>) | undefined;
  private importManifestPath: string;
  private transcriptProjection: TranscriptProjectionPort | null = null;
  private transcriptSearch: TranscriptSearchPort | null = null;
  private turnRecordStore: TurnRecordStorePort;
  private turnRecordEligibilityFence: TurnRecordEligibilityFencePort | null;
  private journalRuntime: SessionJournalRuntime;
  private channelIndexFailureLogged = false;
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
  private readonly cogSecOperations: SessionCogSecOperations;
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
    this.tailCache = options.tailCache ?? null;
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
      bumpSessionTailEpoch: this.bumpSessionTailEpoch.bind(this),
      withPostRewriteTailFence: this.withPostRewriteTailFence.bind(this),
      withLockedExistingChannelWrite: this.withLockedExistingChannelWrite.bind(this),
      readJournalChain: this.readJournalChain.bind(this),
      loadJournalChain: this.loadJournalChain.bind(this),
      syncTranscriptProjectionForChannel: this.syncTranscriptProjectionForChannel.bind(this),
      resolveCacheSessionKey: this.resolveCacheSessionKey.bind(this),
      setChannelCache: this.setChannelCache.bind(this),
      upsertChannelIndex: this.upsertChannelIndex.bind(this),
    });
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
  private readRecentEntriesFromTail(
    channelId: string,
    filePaths: readonly string[],
    limit: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    return this.journalRuntime.readRecentEntriesFromTailChain(
      filePaths.map(filePath => this.journalRuntime.openArchive(channelId, filePath)),
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
    return this.journalRuntime.readEntriesBefore(
      this.journalRuntime.openArchive(channelId, filePath),
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
    return await this.journalRuntime.readEntriesBeforeAsync(
      this.journalRuntime.openArchive(channelId, filePath),
      beforeId,
      limit,
      tombstones,
    );
  }
  private fingerprintArchive(cache: ChannelCache): string | null {
    return fingerprintSessionJournalChain(this.journalRuntime, cache);
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
  private syncTranscriptProjectionForChannel(
    channelId: string,
    entries: readonly SessionEntry[],
    options: { redaction?: boolean } = {},
  ): void {
    if (!this.transcriptProjection) return;
    this.transcriptProjection.replaceChannelEntries(channelId, entries, options);
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
    const archiveFingerprint = this.fingerprintArchive(cache);
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
        this.writeSessionTailThrough(entry.channelId, full);
        return id;
      },
    );
  }
  async appendTurnRecord(record: TurnRecord): Promise<void> {
    await this.withTurnRecordEligibilityMutationFence(
      record.sessionId ?? record.channelId,
      record.turnId,
      async () => {
        this.turnRecordStore.appendTurnRecord(
          slimTurnRecordMemoryCandidatesForAppend(
            slimTurnRecordSessionEntriesForAppend(record),
          ),
        );
      },
    );
  }
  async withSourceTurnRecordEligibilityFence<T>(
    sourceChannelId: string,
    logicalSessionId: string,
    turnId: string,
    operation: () => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!sourceChannelId.trim()) {
      throw new Error('TurnRecord eligibility fence sourceChannelId cannot be empty');
    }
    if (!this.turnRecordEligibilityFence) {
      throw new Error('TurnRecord eligibility fence is not configured');
    }
    return this.turnRecordEligibilityFence.withTurnRecordEligibilityFence({
      logicalSessionId,
      turnId,
    }, operation, { signal });
  }
  /**
   * Captures a bounded content window, locks every TurnID represented in that
   * window plus the required source IDs, then re-reads and validates the exact
   * snapshot before exposing it to a durable effect.
   */
  async withStableTurnRecordEligibilitySnapshot<T>(
    logicalSessionId: string,
    requiredTurnIds: readonly string[],
    readSnapshot: () => SessionEntry[],
    operation: (entries: readonly SessionEntry[]) => Promise<T>,
  ): Promise<T> {
    const normalizedSessionId = logicalSessionId.trim();
    if (!normalizedSessionId) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        'TurnRecord eligibility snapshot logicalSessionId cannot be empty',
      );
    }
    if (!this.turnRecordEligibilityFence) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        'TurnRecord eligibility fence is not configured',
      );
    }

    const initial = readSnapshot();
    const consumed = initial.map((entry) => ({
      sourceChannelId: entry.originChannelId?.trim() || entry.channelId,
      turnId: resolveSessionEntryTurnContext(entry).turnId,
    }));
    const turnIds = new Set<string>();
    for (const turnId of requiredTurnIds) {
      const normalized = turnId.trim();
      if (!normalized) {
        throw new TurnRecordEligibilitySnapshotInvalidError(
          'TurnRecord eligibility snapshot required TurnID cannot be empty',
        );
      }
      turnIds.add(normalized);
    }
    for (const reference of consumed) turnIds.add(reference.turnId);
    if (turnIds.size === 0) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        'TurnRecord eligibility snapshot must contain at least one TurnID',
      );
    }
    if (turnIds.size > MAX_TURN_RECORD_ELIGIBILITY_SNAPSHOT_FENCES) {
      throw new TurnRecordEligibilitySnapshotInvalidError(
        `TurnRecord eligibility snapshot exceeds ${MAX_TURN_RECORD_ELIGIBILITY_SNAPSHOT_FENCES} TurnIDs`,
      );
    }

    return this.turnRecordEligibilityFence.withTurnRecordEligibilityFences(
      [...turnIds].map(turnId => ({ logicalSessionId: normalizedSessionId, turnId })),
      async () => {
        const current = readSnapshot();
        if (!sessionEntrySnapshotMatches(initial, current)) {
          throw new TurnRecordEligibilitySnapshotChangedError();
        }

        const eligibleEntries = await selectEligibleTurnRecordSnapshotEntries({
          entries: current,
          logicalSessionId: normalizedSessionId,
          lookupEligibility: (sourceChannelId, logicalOwnerSessionId, turnId) => (
            this.lookupSourceTurnRecordEligibility(
              sourceChannelId,
              logicalOwnerSessionId,
              turnId,
            )
          ),
        });
        return operation(eligibleEntries);
      },
    );
  }
  private async withTurnRecordEligibilityMutationFence<T>(
    logicalSessionId: string,
    turnId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!this.turnRecordEligibilityFence) return operation();
    return this.turnRecordEligibilityFence.withTurnRecordEligibilityFence({
      logicalSessionId,
      turnId,
    }, operation);
  }
  /**
   * Reconstruct L0-referenced session entries and redaction-gate the rendered
   * view (bead psfn-framework-9ree) at the persistence read boundary, so every
   * consumer above the store sees fully inline, journal-current records. Pre-9ree
   * "old fat" records (inline recentEntries, no ref) are redaction-gated against
   * L0 here too (bead psfn-framework-hgw3.10); id-backed heal-drops emit
   * structured telemetry via emitRecentEntryHealDrop. The captured provider wire
   * body is withheld here if a source L0 entry it embedded was redacted/removed
   * (bead psfn-framework-eb14), emitting telemetry via emitWireBodyWithheld.
   */
  private resolveTurnRecordSessionRefs(record: TurnRecord): TurnRecord {
    return resolveTurnRecordSessionEntries(
      record,
      (channelId, minId, maxId) => this.getEntriesInRange(channelId, minId, maxId),
      emitRecentEntryHealDrop,
      emitWireBodyWithheld,
      emitTurnMessageWithheld,
      emitContinuityWithheld,
    );
  }
  findTurnRecord(channelId: string, turnId: string): TurnRecord | null {
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const record = this.turnRecordStore.findTurnRecord(sessionId, turnId);
    return record ? this.resolveTurnRecordSessionRefs(record) : null;
  }
  /**
   * Find one canonical turn by its physical source channel while proving that
   * it belongs to the expected logical session. Background work uses this
   * exact scope so a later route reset cannot redirect an old durable job to a
   * newer logical session on the same transport channel.
   */
  findSourceTurnRecord(
    sourceChannelId: string,
    logicalSessionId: string,
    turnId: string,
  ): TurnRecord | null {
    const record = this.turnRecordStore.findTurnRecord(sourceChannelId, turnId);
    if (!record || record.channelId !== sourceChannelId) return null;
    return (record.sessionId ?? sourceChannelId) === logicalSessionId
      ? this.resolveTurnRecordSessionRefs(record)
      : null;
  }
  /**
   * Resolves the sole eligible durable owner for an exact physical source and
   * turn. Recovery callers do not yet know the logical owner, so this lookup
   * derives it from the canonical record while preserving the same duplicate
   * and tombstone fences used by background work. Null means no record exists;
   * an existing ambiguous or ineligible source fails closed.
   */
  private async lookupSourceTurnRecordIdentity(
    sourceChannelId: string,
    turnId: string,
    signal?: AbortSignal,
  ) {
    const normalizedSourceChannelId = sourceChannelId.trim();
    const normalizedTurnId = turnId.trim();
    if (!normalizedSourceChannelId || !normalizedTurnId) {
      throw new Error('Source TurnRecord lookup requires a physical channel and turn id');
    }
    const lookup = this.turnRecordStore.lookupTurnRecordIdentity;
    if (!lookup) {
      throw new Error('TurnRecord store does not support snapshot-consistent exact identity lookup');
    }
    return await lookup.call(
      this.turnRecordStore,
      normalizedSourceChannelId,
      normalizedTurnId,
      { signal },
    );
  }
  private resolveEligibleSourceTurnRecord(
    sourceChannelId: string,
    ownerSessionId: string | null,
    turnId: string,
    record: TurnRecord,
  ): TurnRecord | null {
    const normalizedSourceChannelId = sourceChannelId.trim();
    const normalizedTurnId = turnId.trim();
    const declaredOwnerSessionId = record.sessionId ?? normalizedSourceChannelId;
    if (record.channelId !== normalizedSourceChannelId
      || (ownerSessionId !== null && declaredOwnerSessionId !== ownerSessionId.trim())) {
      return null;
    }
    const owner = this.ensureChannelFullyLoaded(declaredOwnerSessionId);
    if (owner === null || owner.turnTombstones.has(normalizedTurnId)) return null;
    return this.resolveTurnRecordSessionRefs(record);
  }
  async findUniqueSourceTurnRecord(
    sourceChannelId: string,
    turnId: string,
  ): Promise<TurnRecord | null> {
    const lookup = await this.lookupSourceTurnRecordIdentity(sourceChannelId, turnId);
    if (lookup.kind === 'missing') return null;
    if (lookup.kind === 'duplicated') {
      throw new Error('Source TurnRecord is duplicated and cannot establish a recovery identity');
    }
    const eligible = this.resolveEligibleSourceTurnRecord(
      sourceChannelId,
      null,
      turnId,
      lookup.record,
    );
    if (!eligible) {
      throw new Error('Source TurnRecord is tombstoned, missing its owner, or belongs to another source');
    }
    return eligible;
  }
  async findEligibleSourceTurnRecord(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<TurnRecord | null> {
    const eligibility = await this.lookupSourceTurnRecordEligibility(
      sourceChannelId,
      ownerSessionId,
      turnId,
      signal,
    );
    return eligibility.kind === 'eligible' ? eligibility.record : null;
  }
  async lookupSourceTurnRecordEligibility(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
    signal?: AbortSignal,
  ): Promise<SourceTurnRecordEligibility> {
    if (!ownerSessionId.trim()) {
      throw new Error('Source TurnRecord eligibility requires an owner session id');
    }
    const lookup = await this.lookupSourceTurnRecordIdentity(sourceChannelId, turnId, signal);
    signal?.throwIfAborted();
    if (lookup.kind === 'missing') return { kind: 'missing' };
    if (lookup.kind === 'duplicated') return { kind: 'ineligible' };
    const record = this.resolveEligibleSourceTurnRecord(
      sourceChannelId,
      ownerSessionId,
      turnId,
      lookup.record,
    );
    return record
      ? { kind: 'eligible', record }
      : { kind: 'ineligible' };
  }
  getRecentTurnRecords(channelId: string, limit: number): TurnRecord[] {
    if (limit <= 0) return [];
    this.refreshChannelIndexFromDisk();
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    const resolved = this.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
      }
      : null);
    if (!resolved) {
      return this.turnRecordStore.readRecentTurnRecords(sessionId, limit)
        .map(record => this.resolveTurnRecordSessionRefs(record));
    }
    const indexEntry = this.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.sessionsDir });
    }
    const tombstones = this.resolveJournalAuthoritativeTurnTombstones({
      sessionId: resolved.sessionId,
      channelId: resolved.channelId,
      filePaths: resolved.filePaths,
      cache: cached ?? undefined,
    });
    if (tombstones.size === 0) {
      return this.turnRecordStore.readRecentTurnRecords(sessionId, limit)
        .map(record => this.resolveTurnRecordSessionRefs(record));
    }
    return this.readTombstoneFilteredTurnRecords(sessionId, limit, tombstones)
      .map(record => this.resolveTurnRecordSessionRefs(record));
  }
  /**
   * Content-free deterministic-analytics read. Unlike getRecentTurnRecords,
   * this path never reconstructs session context or captured provider bodies,
   * so a metadata-only background task cannot resurrect, retain, or repeatedly
   * heal historical conversation content.
   */
  getRecentTurnRecordUsage(channelId: string, limit: number): TurnRecordUsageRecord[] {
    if (limit <= 0) return [];
    const readUsage = this.turnRecordStore.readRecentTurnRecordUsage;
    if (!readUsage) {
      throw new Error('TurnRecord store does not support the content-free usage projection');
    }
    this.refreshChannelIndexFromDisk();
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    const resolved = this.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
      }
      : null);
    if (!resolved) {
      return readUsage.call(this.turnRecordStore, sessionId, limit);
    }
    const indexEntry = this.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached) {
      syncLightweightSessionCacheFromIndex({
        cache: cached,
        indexEntry,
        sessionsDir: this.sessionsDir,
      });
    }
    const tombstones = this.resolveJournalAuthoritativeTurnTombstones({
      sessionId: resolved.sessionId,
      channelId: resolved.channelId,
      filePaths: resolved.filePaths,
      cache: cached ?? undefined,
    });
    if (tombstones.size === 0) {
      return readUsage.call(this.turnRecordStore, sessionId, limit);
    }
    return this.readTombstoneFilteredTurnRecordUsage(
      sessionId,
      limit,
      tombstones,
      readUsage,
    );
  }
  /**
   * Bounded iterative overscan for tombstone-filtered turn-record reads:
   * request a small multiple of the limit, filter tombstoned turns, and only
   * widen (doubling) while the segment files still have older records to
   * offer. Exactness wins when an unusually dense tombstone window requires
   * reading farther back: returning a partial logical window would violate
   * the public limit contract.
   */
  private readTombstoneFilteredTurnRecords(
    sessionId: string,
    limit: number,
    tombstones: ReadonlySet<string>,
  ): TurnRecord[] {
    let requested = Math.max(limit, limit * TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR);
    for (;;) {
      const records = this.turnRecordStore.readRecentTurnRecords(sessionId, requested);
      const filtered = records.filter(record => !tombstones.has(record.turnId));
      // Fewer records than requested means the whole archive is already read.
      const exhaustedHistory = records.length < requested;
      if (filtered.length >= limit || exhaustedHistory) {
        return filtered.length > limit ? filtered.slice(-limit) : filtered;
      }
      requested = Math.min(Number.MAX_SAFE_INTEGER, requested * 2);
    }
  }
  private readTombstoneFilteredTurnRecordUsage(
    sessionId: string,
    limit: number,
    tombstones: ReadonlySet<string>,
    readUsage: NonNullable<TurnRecordStorePort['readRecentTurnRecordUsage']>,
  ): TurnRecordUsageRecord[] {
    let requested = Math.max(limit, limit * TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR);
    for (;;) {
      const records = readUsage.call(this.turnRecordStore, sessionId, requested);
      const filtered = records.filter(record => !tombstones.has(record.turnId));
      const exhaustedHistory = records.length < requested;
      if (filtered.length >= limit || exhaustedHistory) {
        return filtered.length > limit ? filtered.slice(-limit) : filtered;
      }
      requested = Math.min(Number.MAX_SAFE_INTEGER, requested * 2);
    }
  }
  /**
   * Reads the physical turn-record stream for an exact source channel without
   * resolving it through a logical-session alias. Introspection consent is
   * channel-exact, so routed sessions must use this path instead of widening a
   * source-channel decision to the whole logical session.
   */
  getRecentSourceTurnRecords(sourceChannelId: string, limit: number): TurnRecord[] {
    if (limit <= 0) return [];
    const target = limit;
    let requested = Math.min(
      Number.MAX_SAFE_INTEGER,
      Math.max(target, target * TURN_RECORD_TOMBSTONE_OVERSCAN_FACTOR),
    );
    for (;;) {
      const records = this.turnRecordStore.readRecentTurnRecords(
        sourceChannelId,
        requested,
      );
      const filtered = records.filter((record) => {
        const ownerSessionId = record.sessionId ?? sourceChannelId;
        const owner = this.ensureChannelFullyLoaded(ownerSessionId);
        if (!owner) return false;
        return !owner.turnTombstones.has(record.turnId);
      });
      const exhaustedHistory = records.length < requested;
      if (filtered.length >= target || exhaustedHistory) {
        return filtered.slice(-limit)
          .map(record => this.resolveTurnRecordSessionRefs(record));
      }
      requested = Math.min(Number.MAX_SAFE_INTEGER, requested * 2);
    }
  }
  private async isRecoveryTurnEligible(
    ownerSessionId: string,
    turnId: string,
    options: TurnRecordRecoveryScanOptions,
  ): Promise<boolean> {
    const limits = SessionStore.RECOVERY_AUTHORITY_LIMITS;
    const resolveEvidence = (): {
      archiveFingerprint: string;
      archives: ReturnType<SessionJournalRuntime['openArchive']>[];
      baselineFingerprint: string;
      baselineTombstones: Set<string>;
      channelId: string;
      filePaths: string[];
      sessionId: string;
    } | null => {
      this.refreshChannelIndexFromDisk();
      const resolved = this.resolveExistingSession(ownerSessionId);
      if (!resolved) return null;
      const indexed = this.channelIndex.get(resolved.sessionId);
      const indexedCount = normalizeOptionalNonNegativeNumber(
        indexed?.activeTurnTombstoneCount,
      ) ?? 0;
      const baselineTombstones = new Set(indexed?.activeTurnTombstoneIds ?? []);
      if (baselineTombstones.size !== indexedCount) {
        throw this.recoveryAuthorityError(
          `Unsigned L0 index tombstone evidence is inconsistent for ${ownerSessionId}`,
        );
      }
      if (baselineTombstones.size > limits.maxTombstones) {
        throw this.recoveryAuthorityError(
          `L0 tombstone authority for ${ownerSessionId} exceeds `
          + `${limits.maxTombstones} retained ids`,
          'EOVERFLOW',
        );
      }
      const archives = resolved.filePaths.map(filePath => (
        this.journalRuntime.openArchive(resolved.channelId, filePath)
      ));
      const archiveFingerprint = this.journalRuntime.fingerprintArchiveChain(archives);
      if (!archiveFingerprint) return null;
      const baselineFingerprint = createHash('sha256')
        .update([...baselineTombstones].sort().join('\0'))
        .digest('hex');
      return {
        archiveFingerprint,
        archives,
        baselineFingerprint,
        baselineTombstones,
        channelId: resolved.channelId,
        filePaths: [...resolved.filePaths],
        sessionId: resolved.sessionId,
      };
    };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      options.signal?.throwIfAborted();
      const before = resolveEvidence();
      if (!before) return false;
      const cached = this.recoveryTombstoneAuthority.get(before.sessionId);
      if (
        cached?.archiveFingerprint === before.archiveFingerprint
        && cached.baselineFingerprint === before.baselineFingerprint
      ) {
        this.recoveryTombstoneAuthority.delete(before.sessionId);
        this.recoveryTombstoneAuthority.set(before.sessionId, cached);
        return !cached.tombstones.has(turnId);
      }

      let snapshot;
      try {
        snapshot = await readTurnTombstoneAuthoritySnapshot({
          channelId: before.channelId,
          filePaths: before.filePaths,
          maxActionBytes: limits.maxActionBytes,
          maxActions: limits.maxActions,
          maxResultBytes: limits.maxResultBytes,
          maxRowBytes: limits.maxRowBytes,
          onSnapshot: async () => {
            await this.recoveryAuthoritySnapshotHook?.(ownerSessionId);
          },
          scanChunkBytes: limits.scanChunkBytes,
          signal: options.signal,
        });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESTALE' && attempt === 0) continue;
        throw error;
      }
      const after = resolveEvidence();
      if (
        !after
        || after.sessionId !== before.sessionId
        || after.archiveFingerprint !== before.archiveFingerprint
        || after.baselineFingerprint !== before.baselineFingerprint
      ) {
        if (attempt === 0) continue;
        throw this.recoveryAuthorityError(
          `L0 tombstone authority for ${ownerSessionId} changed repeatedly during recovery`,
          'ESTALE',
        );
      }

      const tombstones = new Set(before.baselineTombstones);
      for (const action of snapshot.actions) {
        const normalized = this.journalRuntime.verifyAndNormalizeEntry(
          action.entry,
          [action.previousHmac],
        );
        const tombstone = journalToTurnTombstoneEntry(normalized.entry);
        if (!tombstone) {
          throw this.recoveryAuthorityError(
            `L0 authority action for ${ownerSessionId} is not a valid turn tombstone`,
            'EBADMSG',
          );
        }
        if (tombstone.action === 'redact' || !normalized.verified) {
          tombstones.add(tombstone.targetId);
        } else {
          tombstones.delete(tombstone.targetId);
        }
        if (tombstones.size > limits.maxTombstones) {
          throw this.recoveryAuthorityError(
            `L0 tombstone authority for ${ownerSessionId} exceeds `
            + `${limits.maxTombstones} retained ids`,
            'EOVERFLOW',
          );
        }
      }

      this.recoveryTombstoneAuthority.delete(before.sessionId);
      this.recoveryTombstoneAuthority.set(before.sessionId, {
        archiveFingerprint: before.archiveFingerprint,
        baselineFingerprint: before.baselineFingerprint,
        tombstones,
      });
      while (this.recoveryTombstoneAuthority.size > limits.cacheOwners) {
        const oldest = this.recoveryTombstoneAuthority.keys().next().value as string | undefined;
        if (!oldest) break;
        this.recoveryTombstoneAuthority.delete(oldest);
      }
      const stats = options.stats;
      if (stats) {
        stats.authorityActionsReturned = (stats.authorityActionsReturned ?? 0)
          + snapshot.stats.actionsReturned;
        stats.authorityBytesRead = (stats.authorityBytesRead ?? 0) + snapshot.stats.bytesRead;
        stats.authorityFilesScanned = (stats.authorityFilesScanned ?? 0)
          + snapshot.stats.filesScanned;
        stats.authorityMainMessageBytesRetained = 0;
        stats.authorityOwnersScanned = (stats.authorityOwnersScanned ?? 0) + 1;
        stats.authorityPeakOpenFilesOffPrimary = Math.max(
          stats.authorityPeakOpenFilesOffPrimary ?? 0,
          snapshot.stats.peakOpenFiles,
        );
        stats.authorityPeakCachedOwners = Math.max(
          stats.authorityPeakCachedOwners ?? 0,
          this.recoveryTombstoneAuthority.size,
        );
        stats.authorityPeakCachedTombstones = Math.max(
          stats.authorityPeakCachedTombstones ?? 0,
          ...[...this.recoveryTombstoneAuthority.values()].map(value => value.tombstones.size),
        );
        stats.authorityPeakResultBytes = Math.max(
          stats.authorityPeakResultBytes ?? 0,
          snapshot.stats.actionBytesReturned,
        );
        stats.authorityPeakRowBytesOffPrimary = Math.max(
          stats.authorityPeakRowBytesOffPrimary ?? 0,
          snapshot.stats.peakRowBytes,
        );
        stats.authorityRowsScanned = (stats.authorityRowsScanned ?? 0)
          + snapshot.stats.rowsScanned;
      }
      return !tombstones.has(turnId);
    }
    return false;
  }
  private recoveryAuthorityError(message: string, code?: string): Error {
    const error = new Error(message) as NodeJS.ErrnoException;
    error.name = 'TurnRecordRecoveryEvidenceError';
    if (code) error.code = code;
    return error;
  }
  /**
   * Bounded physical paging for introspection/metacognition.
   *
   * Tombstoned or missing-owner rows consume their physical page slot instead
   * of triggering overscan. `exhausted` and `nextCursor` therefore describe
   * the complete fixed persistence snapshot, even when every returned record
   * is filtered out. Shared refs and L0 session refs resolve only for the
   * retained rows in this one page.
   */
  async readSourceTurnRecordPage(
    sourceChannelId: string,
    limit: number,
    cursor?: TurnRecordPageCursor,
  ): Promise<TurnRecordPage> {
    const readPage = this.turnRecordStore.readTurnRecordPage;
    if (!readPage) {
      throw new Error('TurnRecord store does not support bounded cursor paging');
    }
    const page = await readPage.call(this.turnRecordStore, sourceChannelId, limit, cursor);
    const records = page.records
      .filter((record) => {
        if (record.channelId !== sourceChannelId) return false;
        const ownerSessionId = record.sessionId ?? sourceChannelId;
        const owner = this.ensureChannelFullyLoaded(ownerSessionId);
        return owner !== null && !owner.turnTombstones.has(record.turnId);
      })
      .map(record => this.resolveTurnRecordSessionRefs(record));
    return {
      records,
      exhausted: page.exhausted,
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
  }
  /**
   * One process-lifetime historical handoff snapshot. The filesystem adapter
   * proves physical uniqueness and global order in one disk-backed pass, so no
   * per-identity state or old-fat archive is retained on the main thread.
   *
   * Owner/tombstone state is re-read from the authoritative L0 journal before a
   * candidate is returned. No history is truncated or accepted on partial
   * evidence.
   */
  async *streamRecoverableBackgroundWorkTurnRecords(
    sourceChannelIds: readonly string[],
    options: TurnRecordRecoveryScanOptions = {},
  ): AsyncGenerator<TurnRecord> {
    const streamSource = this.turnRecordStore.streamTurnRecordsForRecovery;
    if (!streamSource) {
      throw new Error('TurnRecord store does not support bounded background-work recovery scans');
    }
    const uniqueSourceSet = new Set(sourceChannelIds);
    const uniqueSources = [...uniqueSourceSet];
    const evidenceBlockedOwners = new Set<string>();
    for await (const record of streamSource.call(this.turnRecordStore, uniqueSources, options)) {
      const sourceChannelId = record.channelId;
      if (!uniqueSourceSet.has(sourceChannelId)) continue;
      const logicalSessionId = record.sessionId ?? sourceChannelId;
      if (evidenceBlockedOwners.has(logicalSessionId)) continue;
      try {
        if (!await this.isRecoveryTurnEligible(logicalSessionId, record.turnId, options)) continue;
      } catch (error) {
        if (!isTurnRecordRecoveryEvidenceError(error)) throw error;
        evidenceBlockedOwners.add(logicalSessionId);
        const rawCode = (error as NodeJS.ErrnoException).code;
        const errno = typeof rawCode === 'string' && rawCode ? rawCode : 'UNKNOWN';
        log.warn(
          `Skipping background-work handoff recovery owner ${logicalSessionId} (${errno})`,
          { errno, ownerSessionId: logicalSessionId },
        );
        options.onEvidenceOwnerSkipped?.({ errno, ownerSessionId: logicalSessionId });
        continue;
      }
      yield record;
    }
  }
  async isSourceTurnRecordEligible(
    sourceChannelId: string,
    ownerSessionId: string,
    turnId: string,
  ): Promise<boolean> {
    return await this.findEligibleSourceTurnRecord(
      sourceChannelId,
      ownerSessionId,
      turnId,
    ) !== null;
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
    this.refreshChannelIndexFromDisk();
    if (limit <= 0) return [];
    this.refreshChannelIndexFromDisk();
    const cached = this.getLoadedCache(channelId) ?? this.loadExistingChannelCache(channelId);
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    if (cached?.fullyLoaded) {
      if (this.fullyLoadedCacheIsCurrent(cached)) {
        if (cached.entries.length <= limit) return [...cached.entries];
        return cached.entries.slice(-limit);
      }
    }
    const resolved = this.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
        filePath: cached.resolvedPath,
      }
      : null);
    if (!resolved) return [];
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
    if (cached) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.sessionsDir });
    }
    const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
    if (messageCount === 0) return [];
    const tombstones = this.resolveJournalAuthoritativeTurnTombstones({
      sessionId: resolved.sessionId,
      channelId: resolved.channelId,
      filePaths: resolved.filePaths,
      cache: cached ?? undefined,
    });
    const archiveFingerprintBeforeRead = cached ? this.fingerprintArchive(cached) : null;
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
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded || (cached?.activeTurnTombstoneCount ?? 0) > 0) {
      const full = cached?.fullyLoaded ? cached : this.ensureChannelFullyLoaded(channelId);
      return full ? full.entries.filter(matchesWindow).slice(-normalizedLimit).reverse() : [];
    }
    const resolved = cached
      ? { channelId: cached.channelId, filePath: cached.resolvedPath }
      : this.resolveExistingSession(channelId);
    if (!resolved) return [];
    const found = this.journalRuntime.findLatestEntries(
      this.journalRuntime.openArchive(resolved.channelId, resolved.filePath),
      predicate,
      normalizedLimit,
      stopBeforeTimestamp,
    );
    if (found) return found;
    const full = this.ensureChannelFullyLoaded(channelId);
    return full ? full.entries.filter(matchesWindow).slice(-normalizedLimit).reverse() : [];
  }

  private prepareEntriesBeforeRead(
    channelId: string,
    beforeId: number,
    limit: number,
  ): EntriesBeforeReadPlan {
    this.refreshChannelIndexFromDisk();
    if (!Number.isFinite(beforeId) || !Number.isFinite(limit)) {
      return { kind: 'complete', entries: [] };
    }
    const normalizedBeforeId = Math.max(0, Math.floor(beforeId));
    const normalizedLimit = Math.max(0, Math.floor(limit));
    if (normalizedBeforeId <= 0 || normalizedLimit <= 0) {
      return { kind: 'complete', entries: [] };
    }

    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.channels.get(sessionId) ?? this.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded) {
      const current = this.fullyLoadedCacheIsCurrent(cached)
        ? cached
        : this.ensureChannelFullyLoaded(channelId);
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
      : this.resolveExistingSession(channelId);
    if (!resolved) return { kind: 'complete', entries: [] };
    const indexEntry = this.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached && !cached.fullyLoaded) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.sessionsDir });
    }
    if ((normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0) === 0) {
      return { kind: 'complete', entries: [] };
    }

    const activeTurnTombstoneCount = normalizeOptionalNonNegativeNumber(indexEntry.activeTurnTombstoneCount) ?? 0;
    const indexedTurnTombstones = new Set(indexEntry.activeTurnTombstoneIds ?? []);
    // Legacy/incomplete tombstone metadata cannot safely drive a bounded
    // privacy filter. Fall back to canonical replay only for that stale shape.
    if (activeTurnTombstoneCount > 0 && indexedTurnTombstones.size !== activeTurnTombstoneCount) {
      const full = this.ensureChannelFullyLoaded(channelId);
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
    this.refreshChannelIndexFromDisk();
    if (!Number.isFinite(startId) || !Number.isFinite(endId)) return [];
    const normalizedStart = Math.max(0, Math.floor(Math.min(startId, endId)));
    const normalizedEnd = Math.max(0, Math.floor(Math.max(startId, endId)));
    if (normalizedEnd < normalizedStart) return [];
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.getLoadedCache(channelId) ?? this.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded && this.fullyLoadedCacheIsCurrent(cached)) {
      return cached.entries.filter(entry => entry.id >= normalizedStart && entry.id <= normalizedEnd);
    }
    const resolved = this.resolveExistingSession(channelId) ?? (cached
      ? {
        sessionId,
        channelId: cached.channelId,
        filePaths: cached.archivePaths,
      }
      : null);
    if (!resolved) return [];
    const indexEntry = this.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached && !cached.fullyLoaded) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.sessionsDir });
    }
    const tombstones = this.resolveJournalAuthoritativeTurnTombstones({
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
      const found = this.journalRuntime.findEntriesInRange(
        this.journalRuntime.openArchive(resolved.channelId, resolved.filePaths[0]!),
        normalizedStart,
        normalizedEnd,
      );
      if (found) return found;
    }
    return this.journalRuntime.readEntriesInRangeFromChain(
      resolved.filePaths.map(filePath => this.journalRuntime.openArchive(resolved.channelId, filePath)),
      normalizedStart,
      normalizedEnd,
      tombstones,
    );
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
  getRecentDiscordMessageIds(channelId: string, limit: number): Set<string> {
    const entries = this.getRecent(channelId, limit);
    const ids = entries
      .map((entry) => entry.discordMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return new Set(ids);
  }
  count(channelId: string): number {
    this.refreshChannelIndexFromDisk();
    let cached = this.getLoadedCache(channelId);
    // Frozen fullyLoaded caches must not serve counts across a sibling
    // process's journal rewrite (same fingerprint gate as entry reads).
    if (cached?.fullyLoaded && !this.fullyLoadedCacheIsCurrent(cached)) {
      cached = this.ensureChannelFullyLoaded(channelId) ?? cached;
    }
    if (cached) return cached.messageCount;
    const resolved = this.resolveExistingSession(channelId);
    if (!resolved) return 0;
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
    return normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
  }
  getCompactionSummaries(channelId: string): CompactionSummary[] {
    this.refreshChannelIndexFromDisk();
    const sessionId = this.resolveSessionId(channelId) ?? channelId;
    const cached = this.getLoadedCache(channelId) ?? this.loadExistingChannelCache(channelId);
    if (cached?.fullyLoaded && this.fullyLoadedCacheIsCurrent(cached)) {
      return [...cached.compactions];
    }
    const resolved = this.resolveExistingSession(channelId) ?? (cached
      ? { sessionId, channelId: cached.channelId, filePaths: cached.archivePaths }
      : null);
    if (!resolved) return [];
    const indexEntry = this.ensureChannelIndexEntry(
      resolved.sessionId,
      resolved.channelId,
      resolved.filePaths,
    );
    if (cached && !cached.fullyLoaded) {
      syncLightweightSessionCacheFromIndex({ cache: cached, indexEntry, sessionsDir: this.sessionsDir });
    }
    const compactionArchivePaths = new Set(
      (indexEntry.compactionFilenames ?? []).map(filename => join(this.sessionsDir, filename)),
    );
    return this.journalRuntime.readCompactionSummariesFromChain(
      resolved.filePaths.map(filePath => this.journalRuntime.openArchive(resolved.channelId, filePath)),
      compactionArchivePaths,
    );
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
  getSessionActivity(channelId: string): SessionActivitySummary | null {
    this.refreshChannelIndexFromDisk();
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
    const indexEntry = this.ensureChannelIndexEntry(resolved.sessionId, resolved.channelId, resolved.filePaths);
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
    this.primeChannelIndexFromDisk();
    const sessions: SessionActivitySummary[] = [];

    // Ensuring a stale entry may atomically replace the backing Map. Iterate a
    // stable snapshot so that replacement cannot revisit already-seen rows.
    for (const [sessionId, indexEntry] of [...this.channelIndex.entries()]) {
      const logicalChannelId = indexedChannelId(sessionId, indexEntry);
      const filePaths = indexEntry.filenames.map(filename => join(this.sessionsDir, filename));
      if (filePaths.some(filePath => !existsSync(filePath))) continue;

      const ensured = this.ensureChannelIndexEntry(sessionId, logicalChannelId, filePaths);
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
    this.primeChannelIndexFromDisk();
    const channels: Array<{ sessionId: string; channelId: string; messageCount: number }> = [];
    // `ensureChannelIndexEntry` can replace the local Map after an index
    // repair; snapshot iteration prevents duplicate rows in this one listing.
    for (const [sessionId, indexEntry] of [...this.channelIndex.entries()]) {
      const logicalChannelId = indexedChannelId(sessionId, indexEntry);
      const filePaths = indexEntry.filenames.map(filename => join(this.sessionsDir, filename));
      if (filePaths.some(filePath => !existsSync(filePath))) continue;
      const ensured = this.ensureChannelIndexEntry(sessionId, logicalChannelId, filePaths);
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
