import {
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { SessionEntry, CompactionSummary, JournalEntry, JournalMarkerType } from './types.js';
import { createComponentLogger } from '../logger.js';
import {
  appendJournalEntry,
  buildExtractionMarkerJournalEntry,
  buildGracefulShutdownMarkerJournalEntry,
  buildCompactionJournalEntry,
  buildMessageJournalEntry,
  journalToCompactionSummary,
  journalToMarkerEntry,
  journalToSessionEntry,
  quarantineSidecarPath,
  readJournalFile,
  readJournalFirstEntry,
  readJournalTailEntries,
  scanJournalFileMetadata,
  signJournalEntry,
  verifyJournalEntryIntegrity,
  wrapUnverifiedHistory,
  type JournalIntegrityVerificationResult,
  type SessionHmacKeyring,
} from './journal-utils.js';
import { SessionSearchIndex, type SessionSearchHit } from './search-index.js';

const log = createComponentLogger('SessionStore');

interface ChannelCache {
  entries: SessionEntry[];
  compactions: CompactionSummary[];
  nextId: number;
  lastHmac: string | null;
  lastExtractionCoveredUpTo: number;
  lastJournalEntry: JournalEntry | null;
  resolvedPath: string;
  messageCount: number;
  lastTimestamp: number;
  fullyLoaded: boolean;
}

interface ChannelIndexEntry {
  filename: string;
  messageCount?: number;
  lastTimestamp?: number;
  maxId?: number;
  lastHmac?: string | null;
  lastExtractionCoveredUpTo?: number;
  lastJournalType?: JournalEntry['type'];
  lastMarker?: JournalMarkerType;
}

interface ChannelIndexFile {
  version: number;
  channels: Record<string, ChannelIndexEntry>;
}

interface SessionFileSeed {
  timestamp: number;
  authorId?: string;
  authorName?: string;
}

export interface SessionStoreOptions {
  integrityProvider?: SessionIntegrityProvider | null;
  integrityKeyring?: SessionHmacKeyring | null;
  searchIndexPath?: string;
  disableSearchIndex?: boolean;
}

export interface SessionIntegrityProvider {
  sign(entry: JournalEntry, previousHmac: string | null): JournalEntry;
  verify(entry: JournalEntry, previousHmac: string | null): JournalIntegrityVerificationResult;
}

function createKeyringIntegrityProvider(keyring: SessionHmacKeyring | null): SessionIntegrityProvider | null {
  if (!keyring) return null;
  return {
    sign: (entry, previousHmac) => signJournalEntry(entry, keyring, previousHmac),
    verify: (entry, previousHmac) => verifyJournalEntryIntegrity(entry, keyring, previousHmac),
  };
}

export interface CrashRecoveryExtractionCandidate {
  channelId: string;
  unextractedEntries: SessionEntry[];
  lastExtractionCoveredUpTo: number;
}

const CHANNEL_INDEX_FILENAME = '_channel_index.json';
const CHANNEL_INDEX_VERSION = 2;
const READABLE_SESSION_FILENAME = /^\d{8}_[a-z0-9-]+_[a-z0-9-]+_\d{6}\.jsonl$/;

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

function toSlug(value: string, maxLength: number): string {
  const normalized = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  if (!normalized) return 'unknown';
  const sliced = normalized.slice(0, maxLength).replace(/-+$/, '');
  return sliced || 'unknown';
}

function formatDateUTC(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear().toString().padStart(4, '0');
  const month = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = date.getUTCDate().toString().padStart(2, '0');
  return `${year}${month}${day}`;
}

function normalizeOptionalNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return undefined;
  }
  return value;
}

function normalizeOptionalHmac(value: unknown): string | null | undefined {
  if (value == null) return null;
  if (typeof value !== 'string') return undefined;
  return value;
}

function normalizeOptionalJournalType(value: unknown): JournalEntry['type'] | undefined {
  if (value === 'message' || value === 'compaction' || value === 'marker') {
    return value;
  }
  return undefined;
}

function normalizeOptionalMarker(value: unknown): JournalMarkerType | undefined {
  if (value === 'extraction' || value === 'graceful_shutdown') {
    return value;
  }
  return undefined;
}

function channelIndexEntryEquals(left: ChannelIndexEntry | undefined, right: ChannelIndexEntry): boolean {
  if (!left) return false;
  return left.filename === right.filename
    && left.messageCount === right.messageCount
    && left.lastTimestamp === right.lastTimestamp
    && left.maxId === right.maxId
    && left.lastHmac === right.lastHmac
    && left.lastExtractionCoveredUpTo === right.lastExtractionCoveredUpTo
    && left.lastJournalType === right.lastJournalType
    && left.lastMarker === right.lastMarker;
}

export class SessionStore {
  private sessionsDir: string;
  private channels: Map<string, ChannelCache> = new Map();
  private channelIndex: Map<string, ChannelIndexEntry> = new Map();
  private channelIndexPath: string;
  private searchIndex: SessionSearchIndex | null = null;
  private quarantineWarningKeysByPath: Map<string, string> = new Map();
  private integrityProvider: SessionIntegrityProvider | null;
  private integritySignFailureLogged = false;
  private integrityVerifyFailureLogged = false;
  private searchIndexFailureLogged = false;

  constructor(sessionsDir: string, options: SessionStoreOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.channelIndexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
    this.integrityProvider = options.integrityProvider
      ?? createKeyringIntegrityProvider(options.integrityKeyring ?? null);
    mkdirSync(sessionsDir, { recursive: true });
    if (!options.disableSearchIndex) {
      try {
        this.searchIndex = new SessionSearchIndex(
          options.searchIndexPath ?? join(this.sessionsDir, 'session-search.sqlite'),
        );
      } catch (error) {
        log.warn('Session search index unavailable; keyword search disabled', {
          error: error instanceof Error ? error.message : String(error),
        });
        this.searchIndex = null;
      }
    }
    this.loadChannelIndex();
    this.migrateLegacyFilenames();
    this.primeChannelIndexFromDisk();
    this.backfillSearchIndexFromDisk();
  }

  private encodedFilePath(channelId: string): string {
    return join(this.sessionsDir, sanitizeChannelId(channelId) + '.jsonl');
  }

  /** Legacy sanitization (pre-%XX encoding): : → -, / → _ */
  private legacyFilePath(channelId: string): string {
    const legacy = channelId.replace(/\//g, '_').replace(/:/g, '-');
    return join(this.sessionsDir, legacy + '.jsonl');
  }

  private parseChannelIndexEntry(raw: unknown): ChannelIndexEntry | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    if (typeof row.filename !== 'string' || row.filename.length === 0) return null;

    const entry: ChannelIndexEntry = {
      filename: row.filename,
    };

    const messageCount = normalizeOptionalNonNegativeNumber(row.messageCount);
    if (messageCount !== undefined) entry.messageCount = messageCount;

    const lastTimestamp = normalizeOptionalNonNegativeNumber(row.lastTimestamp);
    if (lastTimestamp !== undefined) entry.lastTimestamp = lastTimestamp;

    const maxId = normalizeOptionalNonNegativeNumber(row.maxId);
    if (maxId !== undefined) entry.maxId = maxId;

    const lastHmac = normalizeOptionalHmac(row.lastHmac);
    if (lastHmac !== undefined) entry.lastHmac = lastHmac;

    const lastExtractionCoveredUpTo = normalizeOptionalNonNegativeNumber(row.lastExtractionCoveredUpTo);
    if (lastExtractionCoveredUpTo !== undefined) {
      entry.lastExtractionCoveredUpTo = lastExtractionCoveredUpTo;
    }

    const lastJournalType = normalizeOptionalJournalType(row.lastJournalType);
    if (lastJournalType) entry.lastJournalType = lastJournalType;

    const lastMarker = normalizeOptionalMarker(row.lastMarker);
    if (lastMarker) entry.lastMarker = lastMarker;

    return entry;
  }

  private loadChannelIndex(): void {
    if (!existsSync(this.channelIndexPath)) return;

    try {
      const raw = readFileSync(this.channelIndexPath, 'utf-8');
      const parsed = JSON.parse(raw) as ChannelIndexFile;
      const version = typeof parsed === 'object' && parsed !== null
        ? (parsed as { version?: unknown }).version
        : undefined;

      if (!parsed || (version !== 1 && version !== CHANNEL_INDEX_VERSION) || typeof parsed.channels !== 'object') {
        log.warn('Ignoring invalid channel index payload', {
          path: this.channelIndexPath,
          version,
        });
        return;
      }

      for (const [channelId, rawEntry] of Object.entries(parsed.channels)) {
        const entry = this.parseChannelIndexEntry(rawEntry);
        if (!entry) continue;
        this.channelIndex.set(channelId, entry);
      }
    } catch (err) {
      log.warn('Failed to parse channel index file; falling back to disk scan', {
        path: this.channelIndexPath,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private saveChannelIndex(): void {
    const payload: ChannelIndexFile = {
      version: CHANNEL_INDEX_VERSION,
      channels: Object.fromEntries(this.channelIndex.entries()),
    };
    const tmp = this.channelIndexPath + '.tmp';
    writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf-8');
    renameSync(tmp, this.channelIndexPath);
  }

  private upsertChannelIndex(channelId: string, entry: ChannelIndexEntry): void {
    const existing = this.channelIndex.get(channelId);
    if (channelIndexEntryEquals(existing, entry)) return;
    this.channelIndex.set(channelId, entry);
    this.saveChannelIndex();
  }

  private isIndexEntryComplete(entry: ChannelIndexEntry): boolean {
    if (!entry.filename) return false;
    if (normalizeOptionalNonNegativeNumber(entry.messageCount) === undefined) return false;
    if (normalizeOptionalNonNegativeNumber(entry.lastTimestamp) === undefined) return false;

    const maxId = normalizeOptionalNonNegativeNumber(entry.maxId);
    if (maxId === undefined) return false;

    if (normalizeOptionalNonNegativeNumber(entry.lastExtractionCoveredUpTo) === undefined) return false;

    if (maxId === 0) return true;

    const type = normalizeOptionalJournalType(entry.lastJournalType);
    if (!type) return false;
    if (type === 'marker' && !normalizeOptionalMarker(entry.lastMarker)) return false;

    return true;
  }

  private buildIndexEntry(channelId: string, filePath: string): ChannelIndexEntry {
    const filename = basename(filePath);
    const metadata = scanJournalFileMetadata(filePath);
    if (metadata.quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(channelId, filePath, metadata.quarantined.length, metadata.entryCount);
    }

    const marker = metadata.lastEntry ? journalToMarkerEntry(metadata.lastEntry) : null;

    return {
      filename,
      messageCount: metadata.messageCount,
      lastTimestamp: metadata.lastTimestamp,
      maxId: metadata.maxId,
      lastHmac: metadata.lastHmac,
      lastExtractionCoveredUpTo: metadata.lastExtractionCoveredUpTo,
      lastJournalType: metadata.lastEntry?.type,
      lastMarker: marker?.marker,
    };
  }

  private ensureChannelIndexEntry(channelId: string, filePath: string): ChannelIndexEntry {
    const filename = basename(filePath);
    const existing = this.channelIndex.get(channelId);

    if (existing && existing.filename === filename && this.isIndexEntryComplete(existing)) {
      return existing;
    }

    const rebuilt = this.buildIndexEntry(channelId, filePath);
    this.upsertChannelIndex(channelId, rebuilt);
    return rebuilt;
  }

  private snapshotIndexEntry(channelId: string, cache: ChannelCache): ChannelIndexEntry {
    const marker = cache.lastJournalEntry ? journalToMarkerEntry(cache.lastJournalEntry) : null;

    return {
      filename: basename(cache.resolvedPath),
      messageCount: cache.messageCount,
      lastTimestamp: cache.lastTimestamp,
      maxId: cache.nextId - 1,
      lastHmac: cache.lastHmac,
      lastExtractionCoveredUpTo: cache.lastExtractionCoveredUpTo,
      lastJournalType: cache.lastJournalEntry?.type,
      lastMarker: marker?.marker,
    };
  }

  private readChannelIdFromFile(filePath: string): string | null {
    try {
      const entry = readJournalFirstEntry(filePath);
      if (!entry || !entry.channelId || typeof entry.channelId !== 'string') {
        return null;
      }
      return entry.channelId;
    } catch (err) {
      log.debug('Failed to read first journal entry', {
        path: filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private resolveExistingPath(channelId: string): string | null {
    const indexed = this.channelIndex.get(channelId);
    if (indexed) {
      const indexedPath = join(this.sessionsDir, indexed.filename);
      if (existsSync(indexedPath)) return indexedPath;
    }

    const encodedPath = this.encodedFilePath(channelId);
    if (existsSync(encodedPath)) return encodedPath;

    const legacyPath = this.legacyFilePath(channelId);
    if (existsSync(legacyPath)) return legacyPath;

    return null;
  }

  private rehydrateLastJournalEntry(channelId: string, indexEntry: ChannelIndexEntry): JournalEntry | null {
    const type = normalizeOptionalJournalType(indexEntry.lastJournalType);
    const maxId = normalizeOptionalNonNegativeNumber(indexEntry.maxId) ?? 0;
    const lastTimestamp = normalizeOptionalNonNegativeNumber(indexEntry.lastTimestamp) ?? 0;

    if (!type || maxId === 0) return null;

    if (type === 'marker') {
      const marker = normalizeOptionalMarker(indexEntry.lastMarker) ?? 'graceful_shutdown';
      return {
        type: 'marker',
        id: maxId,
        channelId,
        marker,
        timestamp: lastTimestamp,
        coveredUpTo: marker === 'extraction'
          ? (normalizeOptionalNonNegativeNumber(indexEntry.lastExtractionCoveredUpTo) ?? 0)
          : undefined,
      };
    }

    if (type === 'compaction') {
      return {
        type: 'compaction',
        id: maxId,
        channelId,
        timestamp: lastTimestamp,
      };
    }

    return {
      type: 'message',
      id: maxId,
      channelId,
      timestamp: lastTimestamp,
    };
  }

  private createLightweightCache(channelId: string, filePath: string, indexEntry: ChannelIndexEntry): ChannelCache {
    const maxId = normalizeOptionalNonNegativeNumber(indexEntry.maxId) ?? 0;
    const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
    const lastTimestamp = normalizeOptionalNonNegativeNumber(indexEntry.lastTimestamp) ?? 0;

    return {
      entries: [],
      compactions: [],
      nextId: maxId + 1,
      lastHmac: normalizeOptionalHmac(indexEntry.lastHmac) ?? null,
      lastExtractionCoveredUpTo: normalizeOptionalNonNegativeNumber(indexEntry.lastExtractionCoveredUpTo) ?? 0,
      lastJournalEntry: this.rehydrateLastJournalEntry(channelId, indexEntry),
      resolvedPath: filePath,
      messageCount,
      lastTimestamp,
      fullyLoaded: false,
    };
  }

  private loadChannelFromPath(channelId: string, filePath: string): ChannelCache {
    const cache: ChannelCache = {
      entries: [],
      compactions: [],
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      resolvedPath: filePath,
      messageCount: 0,
      lastTimestamp: 0,
      fullyLoaded: true,
    };

    if (!existsSync(filePath)) return cache;

    const { entries, maxId, quarantined } = readJournalFile(filePath);
    if (quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(channelId, filePath, quarantined.length, entries.length);
    }
    let previousHmac: string | null = null;
    for (const rawEntry of entries) {
      const entry = this.verifyAndNormalizeEntry(rawEntry, previousHmac);
      previousHmac = typeof rawEntry._hmac === 'string' ? rawEntry._hmac : previousHmac;
      this.applyJournalState(cache, entry);

      const message = journalToSessionEntry(entry);
      if (message) {
        cache.entries.push(message);
        cache.messageCount += 1;
        continue;
      }

      const compaction = journalToCompactionSummary(entry);
      if (compaction) {
        cache.compactions.push(compaction);
      }
    }

    cache.nextId = maxId + 1;
    cache.lastHmac = previousHmac;
    return cache;
  }

  private verifyAndNormalizeEntry(entry: JournalEntry, previousHmac: string | null): JournalEntry {
    if (!this.integrityProvider) return entry;

    let verification: JournalIntegrityVerificationResult;
    try {
      verification = this.integrityProvider.verify(entry, previousHmac);
    } catch (error) {
      if (!this.integrityVerifyFailureLogged) {
        this.integrityVerifyFailureLogged = true;
        log.warn('Session integrity verification unavailable; loading entry without verification', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return entry;
    }

    if (verification.verified) {
      return entry;
    }

    if (entry.type === 'message' && typeof entry.content === 'string') {
      return {
        ...entry,
        content: wrapUnverifiedHistory(entry.content, verification.reason),
      };
    }

    if (entry.type === 'compaction' && typeof entry.summary === 'string') {
      return {
        ...entry,
        summary: wrapUnverifiedHistory(entry.summary, verification.reason),
      };
    }

    return entry;
  }

  private loadExistingChannelCache(channelId: string): ChannelCache | null {
    const existing = this.channels.get(channelId);
    if (existing) return existing;

    const resolvedPath = this.resolveExistingPath(channelId);
    if (!resolvedPath) return null;

    const indexEntry = this.ensureChannelIndexEntry(channelId, resolvedPath);
    const cache = this.createLightweightCache(channelId, resolvedPath, indexEntry);
    this.channels.set(channelId, cache);
    return cache;
  }

  private ensureChannelFullyLoaded(channelId: string): ChannelCache | null {
    const existing = this.channels.get(channelId);
    if (existing?.fullyLoaded) return existing;

    const resolvedPath = existing?.resolvedPath ?? this.resolveExistingPath(channelId);
    if (!resolvedPath) return null;

    const loaded = this.loadChannelFromPath(channelId, resolvedPath);
    this.channels.set(channelId, loaded);
    this.upsertChannelIndex(channelId, this.snapshotIndexEntry(channelId, loaded));
    return loaded;
  }

  private makeReadableFilePath(channelId: string, seed: SessionFileSeed): string {
    const datePart = formatDateUTC(seed.timestamp);
    const channelPart = toSlug(channelId, 40);
    const userSource = seed.authorId ?? seed.authorName ?? 'unknown';
    const userPart = toSlug(userSource, 24);

    for (let attempt = 0; attempt < 10; attempt++) {
      const suffix = Math.floor(Math.random() * 1_000_000).toString().padStart(6, '0');
      const filename = `${datePart}_${channelPart}_${userPart}_${suffix}.jsonl`;
      const fp = join(this.sessionsDir, filename);
      if (!existsSync(fp)) return fp;
    }

    // Last-resort deterministic fallback (extremely unlikely to be needed).
    return this.encodedFilePath(channelId);
  }

  private migrateLegacyFilenames(): void {
    const files = readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));

    for (const filename of files) {
      if (READABLE_SESSION_FILENAME.test(filename)) continue;

      const oldPath = join(this.sessionsDir, filename);
      const firstEntry = readJournalFirstEntry(oldPath);
      if (!firstEntry || !firstEntry.channelId) continue;

      const channelId = firstEntry.channelId;
      const timestamp = firstEntry.timestamp ?? Date.now();
      const authorId = firstEntry.authorId;
      const authorName = firstEntry.authorName;

      const newPath = this.makeReadableFilePath(channelId, {
        timestamp,
        authorId,
        authorName,
      });
      if (newPath === oldPath) {
        const entry = this.ensureChannelIndexEntry(channelId, oldPath);
        if (entry.filename !== basename(oldPath)) {
          this.upsertChannelIndex(channelId, { ...entry, filename: basename(oldPath) });
        }
        continue;
      }

      renameSync(oldPath, newPath);
      const entry = this.buildIndexEntry(channelId, newPath);
      this.upsertChannelIndex(channelId, entry);
    }
  }

  private primeChannelIndexFromDisk(): void {
    const files = readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));

    for (const filename of files) {
      const filePath = join(this.sessionsDir, filename);
      const channelId = this.readChannelIdFromFile(filePath);
      if (!channelId) continue;

      const indexed = this.channelIndex.get(channelId);
      if (indexed && indexed.filename === filename && this.isIndexEntryComplete(indexed)) {
        continue;
      }

      const entry = this.buildIndexEntry(channelId, filePath);
      this.upsertChannelIndex(channelId, entry);
    }
  }

  private backfillSearchIndexFromDisk(): void {
    if (!this.searchIndex) return;

    for (const [channelId, indexEntry] of this.channelIndex.entries()) {
      const expectedCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
      if (expectedCount <= 0) continue;

      const indexedCount = this.searchIndex.countIndexedMessages(channelId);
      if (indexedCount >= expectedCount) continue;

      const filePath = join(this.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;

      try {
        const { entries } = readJournalFile(filePath);
        let previousHmac: string | null = null;
        for (const rawEntry of entries) {
          const entry = this.verifyAndNormalizeEntry(rawEntry, previousHmac);
          previousHmac = typeof rawEntry._hmac === 'string' ? rawEntry._hmac : previousHmac;
          const message = journalToSessionEntry(entry);
          if (!message) continue;
          this.searchIndex.upsertSessionEntry(message);
        }
      } catch (error) {
        if (!this.searchIndexFailureLogged) {
          this.searchIndexFailureLogged = true;
          log.warn('Session search index backfill failed; continuing without interruption', {
            channelId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }

  private indexSessionEntry(entry: SessionEntry): void {
    if (!this.searchIndex) return;

    try {
      this.searchIndex.upsertSessionEntry(entry);
    } catch (error) {
      if (!this.searchIndexFailureLogged) {
        this.searchIndexFailureLogged = true;
        log.warn('Session search index write failed; continuing without interruption', {
          channelId: entry.channelId,
          messageId: entry.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private warnAboutQuarantinedEntries(
    channelId: string,
    filePath: string,
    quarantinedCount: number,
    loadedCount: number,
  ): void {
    const warningKey = `${quarantinedCount}:${loadedCount}`;
    if (this.quarantineWarningKeysByPath.get(filePath) === warningKey) return;
    this.quarantineWarningKeysByPath.set(filePath, warningKey);

    log.warn(
      `Channel ${channelId}: ${quarantinedCount} quarantined entries, ${loadedCount} entries loaded successfully`,
      {
        path: filePath,
        quarantinePath: quarantineSidecarPath(filePath),
      },
    );
  }

  private ensureChannelForWrite(channelId: string, seed: SessionFileSeed): ChannelCache {
    const existing = this.channels.get(channelId);
    if (existing) return existing;

    const resolvedPath = this.resolveExistingPath(channelId);
    if (resolvedPath) {
      const indexEntry = this.ensureChannelIndexEntry(channelId, resolvedPath);
      const cache = this.createLightweightCache(channelId, resolvedPath, indexEntry);
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
    this.upsertChannelIndex(channelId, this.snapshotIndexEntry(channelId, cache));
    return cache;
  }

  private isGracefulShutdownEntry(entry: JournalEntry | null): boolean {
    const marker = entry ? journalToMarkerEntry(entry) : null;
    return marker?.marker === 'graceful_shutdown';
  }

  private applyJournalState(cache: ChannelCache, entry: JournalEntry): void {
    cache.lastJournalEntry = entry;
    cache.lastTimestamp = entry.timestamp;

    const marker = journalToMarkerEntry(entry);
    if (marker?.marker === 'extraction' && typeof marker.coveredUpTo === 'number') {
      cache.lastExtractionCoveredUpTo = Math.max(cache.lastExtractionCoveredUpTo, marker.coveredUpTo);
    }
  }

  private writeJournalEntry(cache: ChannelCache, journal: JournalEntry): void {
    let signed = journal;
    if (this.integrityProvider) {
      try {
        signed = this.integrityProvider.sign(signed, cache.lastHmac);
        cache.lastHmac = signed._hmac ?? cache.lastHmac;
      } catch (error) {
        if (!this.integritySignFailureLogged) {
          this.integritySignFailureLogged = true;
          log.warn('Session integrity signing unavailable; writing unsigned journal entry', {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }

    appendJournalEntry(cache.resolvedPath, signed);
    this.applyJournalState(cache, signed);
    this.upsertChannelIndex(journal.channelId, this.snapshotIndexEntry(journal.channelId, cache));
  }

  private readRecentEntriesFromTail(channelId: string, filePath: string, limit: number): SessionEntry[] {
    const tail = readJournalTailEntries(filePath, {
      messageLimit: limit,
      includeBoundaryEntry: true,
    });

    if (tail.entries.length === 0) return [];

    const messageIndexes: number[] = [];
    for (let index = 0; index < tail.entries.length; index++) {
      if (tail.entries[index].type === 'message') {
        messageIndexes.push(index);
      }
    }

    if (messageIndexes.length === 0) return [];

    const oldestMessageIndex = messageIndexes[Math.max(0, messageIndexes.length - limit)];
    let previousHmac: string | null = null;
    if (oldestMessageIndex > 0) {
      const boundaryEntry = tail.entries[oldestMessageIndex - 1];
      previousHmac = typeof boundaryEntry?._hmac === 'string' ? boundaryEntry._hmac : null;
    }

    const messages: SessionEntry[] = [];
    for (let index = oldestMessageIndex; index < tail.entries.length; index++) {
      const rawEntry = tail.entries[index];
      const entry = this.verifyAndNormalizeEntry(rawEntry, previousHmac);
      previousHmac = typeof rawEntry._hmac === 'string' ? rawEntry._hmac : previousHmac;

      const message = journalToSessionEntry(entry);
      if (message) {
        messages.push(message);
      }
    }

    if (messages.length <= limit) return messages;
    return messages.slice(-limit);
  }

  append(entry: Omit<SessionEntry, 'id'>): number {
    const cache = this.ensureChannelForWrite(entry.channelId, {
      timestamp: entry.timestamp,
      authorId: entry.authorId,
      authorName: entry.authorName,
    });
    const id = cache.nextId++;
    const full: SessionEntry = { ...entry, id };

    if (cache.fullyLoaded) {
      cache.entries.push(full);
    }
    cache.messageCount += 1;
    cache.lastTimestamp = entry.timestamp;

    const journal = buildMessageJournalEntry(id, entry);
    this.writeJournalEntry(cache, journal);
    this.indexSessionEntry(full);

    return id;
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
    const id = cache.nextId++;

    if (cache.fullyLoaded) {
      cache.compactions.push({ id, channelId, summary, coveredUpTo, createdAt: now });
    }

    const journal = buildCompactionJournalEntry(id, channelId, summary, coveredUpTo, now);
    this.writeJournalEntry(cache, journal);
  }

  insertExtractionMarker(channelId: string, coveredUpTo: number, timestamp = Date.now()): void {
    if (!Number.isFinite(coveredUpTo)) return;

    const cache = this.channels.get(channelId) ?? this.loadExistingChannelCache(channelId);
    if (!cache) return;

    const markerCoveredUpTo = Math.max(0, Math.floor(coveredUpTo));
    const id = cache.nextId++;
    const journal = buildExtractionMarkerJournalEntry(id, channelId, markerCoveredUpTo, timestamp);
    this.writeJournalEntry(cache, journal);
  }

  markGracefulShutdownForActiveChannels(timestamp = Date.now()): string[] {
    const marked: string[] = [];

    for (const [channelId, cache] of this.channels.entries()) {
      if (!cache.lastJournalEntry) continue;
      if (this.isGracefulShutdownEntry(cache.lastJournalEntry)) continue;

      const id = cache.nextId++;
      const journal = buildGracefulShutdownMarkerJournalEntry(id, channelId, timestamp);
      this.writeJournalEntry(cache, journal);
      marked.push(channelId);
    }

    return marked;
  }

  getUncleanShutdownChannels(): string[] {
    this.primeChannelIndexFromDisk();
    const channels: string[] = [];

    for (const [channelId, indexEntry] of this.channelIndex.entries()) {
      const filePath = join(this.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;

      const ensured = this.ensureChannelIndexEntry(channelId, filePath);
      const lastEntry = this.rehydrateLastJournalEntry(channelId, ensured);
      if (!lastEntry) continue;
      if (this.isGracefulShutdownEntry(lastEntry)) continue;
      channels.push(channelId);
    }

    return channels;
  }

  getCrashRecoveryExtractionCandidates(): CrashRecoveryExtractionCandidate[] {
    const candidates: CrashRecoveryExtractionCandidate[] = [];

    for (const channelId of this.getUncleanShutdownChannels()) {
      const cache = this.ensureChannelFullyLoaded(channelId);
      if (!cache || !cache.lastJournalEntry) continue;
      if (this.isGracefulShutdownEntry(cache.lastJournalEntry)) continue;

      const unextractedEntries = cache.entries.filter(
        entry => entry.id > cache.lastExtractionCoveredUpTo,
      );
      if (unextractedEntries.length === 0) continue;

      candidates.push({
        channelId,
        unextractedEntries: [...unextractedEntries],
        lastExtractionCoveredUpTo: cache.lastExtractionCoveredUpTo,
      });
    }

    return candidates;
  }
}
