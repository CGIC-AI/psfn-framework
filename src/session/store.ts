import {
  mkdirSync,
  readFileSync,
  existsSync,
  readdirSync,
  writeFileSync,
  renameSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { SessionEntry, CompactionSummary, JournalEntry } from './types.js';
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
  signJournalEntry,
  verifyJournalEntryIntegrity,
  wrapUnverifiedHistory,
  type JournalIntegrityVerificationResult,
  type SessionHmacKeyring,
} from './journal-utils.js';

const log = createComponentLogger('SessionStore');

interface ChannelCache {
  entries: SessionEntry[];
  compactions: CompactionSummary[];
  nextId: number;
  lastHmac: string | null;
  lastExtractionCoveredUpTo: number;
  lastJournalEntry: JournalEntry | null;
  resolvedPath: string; // actual file path used (may be legacy format)
}

interface ChannelIndexEntry {
  filename: string;
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
const CHANNEL_INDEX_VERSION = 1;
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

export class SessionStore {
  private sessionsDir: string;
  private channels: Map<string, ChannelCache> = new Map();
  private channelIndex: Map<string, ChannelIndexEntry> = new Map();
  private channelIndexPath: string;
  private quarantineWarningKeysByPath: Map<string, string> = new Map();
  private integrityProvider: SessionIntegrityProvider | null;
  private integritySignFailureLogged = false;
  private integrityVerifyFailureLogged = false;

  constructor(sessionsDir: string, options: SessionStoreOptions = {}) {
    this.sessionsDir = sessionsDir;
    this.channelIndexPath = join(sessionsDir, CHANNEL_INDEX_FILENAME);
    this.integrityProvider = options.integrityProvider
      ?? createKeyringIntegrityProvider(options.integrityKeyring ?? null);
    mkdirSync(sessionsDir, { recursive: true });
    this.loadChannelIndex();
    this.migrateLegacyFilenames();
    this.reportQuarantineWarningsOnStartup();
  }

  private encodedFilePath(channelId: string): string {
    return join(this.sessionsDir, sanitizeChannelId(channelId) + '.jsonl');
  }

  /** Legacy sanitization (pre-%XX encoding): : → -, / → _ */
  private legacyFilePath(channelId: string): string {
    const legacy = channelId.replace(/\//g, '_').replace(/:/g, '-');
    return join(this.sessionsDir, legacy + '.jsonl');
  }

  private loadChannelIndex(): void {
    if (!existsSync(this.channelIndexPath)) return;

    try {
      const raw = readFileSync(this.channelIndexPath, 'utf-8');
      const parsed = JSON.parse(raw) as ChannelIndexFile;
      if (!parsed || parsed.version !== CHANNEL_INDEX_VERSION || typeof parsed.channels !== 'object') {
        const version = typeof parsed === 'object' && parsed !== null && 'version' in parsed
          ? (parsed as { version?: unknown }).version
          : undefined;
        log.warn('Ignoring invalid channel index payload', {
          path: this.channelIndexPath,
          version,
        });
        return;
      }
      for (const [channelId, entry] of Object.entries(parsed.channels)) {
        if (!entry || typeof entry.filename !== 'string' || entry.filename.length === 0) continue;
        this.channelIndex.set(channelId, { filename: entry.filename });
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

  private upsertChannelIndex(channelId: string, filename: string): void {
    const existing = this.channelIndex.get(channelId);
    if (existing?.filename === filename) return;
    this.channelIndex.set(channelId, { filename });
    this.saveChannelIndex();
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

  private readChannelIdFromFile(filePath: string): string | null {
    const entry = this.readFirstJournalEntry(filePath);
    if (!entry) return null;
    return entry.channelId;
  }

  private readFirstJournalEntry(filePath: string): JournalEntry | null {
    try {
      const { entries } = readJournalFile(filePath, { persistQuarantine: false });
      const entry = entries[0];
      if (!entry) return null;
      if (!entry.channelId || typeof entry.channelId !== 'string') return null;
      return entry;
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

  private getOrLoadChannel(channelId: string): ChannelCache | null {
    const cached = this.channels.get(channelId);
    if (cached) return cached;

    const resolvedPath = this.resolveExistingPath(channelId);
    if (!resolvedPath) return null;

    const loaded = this.loadChannelFromPath(channelId, resolvedPath);
    this.channels.set(channelId, loaded);
    this.upsertChannelIndex(channelId, basename(resolvedPath));
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
      const firstEntry = this.readFirstJournalEntry(oldPath);
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
        this.upsertChannelIndex(channelId, basename(oldPath));
        continue;
      }

      renameSync(oldPath, newPath);
      this.upsertChannelIndex(channelId, basename(newPath));
    }
  }

  private reportQuarantineWarningsOnStartup(): void {
    const files = readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));

    for (const filename of files) {
      const filePath = join(this.sessionsDir, filename);
      const { entries, quarantined } = readJournalFile(filePath);
      if (quarantined.length === 0) continue;
      const channelId = entries[0]?.channelId ?? filename;
      this.warnAboutQuarantinedEntries(channelId, filePath, quarantined.length, entries.length);
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
    const loaded = this.getOrLoadChannel(channelId);
    if (loaded) return loaded;

    const newPath = this.makeReadableFilePath(channelId, seed);
    const cache: ChannelCache = {
      entries: [],
      compactions: [],
      nextId: 1,
      lastHmac: null,
      lastExtractionCoveredUpTo: 0,
      lastJournalEntry: null,
      resolvedPath: newPath,
    };
    this.channels.set(channelId, cache);
    this.upsertChannelIndex(channelId, basename(newPath));
    return cache;
  }

  private primeChannelsFromDisk(): void {
    const files = readdirSync(this.sessionsDir)
      .filter(f => f.endsWith('.jsonl'))
      .filter(f => !f.startsWith('user_'));

    for (const filename of files) {
      const filePath = join(this.sessionsDir, filename);
      const channelId = this.readChannelIdFromFile(filePath);
      if (!channelId) continue;

      if (!this.channels.has(channelId)) {
        const cache = this.loadChannelFromPath(channelId, filePath);
        this.channels.set(channelId, cache);
      }
      this.upsertChannelIndex(channelId, filename);
    }
  }

  private primeChannelCaches(): void {
    for (const channelId of this.channelIndex.keys()) {
      this.getOrLoadChannel(channelId);
    }
    this.primeChannelsFromDisk();
  }

  private isGracefulShutdownEntry(entry: JournalEntry | null): boolean {
    const marker = entry ? journalToMarkerEntry(entry) : null;
    return marker?.marker === 'graceful_shutdown';
  }

  private applyJournalState(cache: ChannelCache, entry: JournalEntry): void {
    cache.lastJournalEntry = entry;

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
  }

  append(entry: Omit<SessionEntry, 'id'>): number {
    const cache = this.ensureChannelForWrite(entry.channelId, {
      timestamp: entry.timestamp,
      authorId: entry.authorId,
      authorName: entry.authorName,
    });
    const id = cache.nextId++;

    const full: SessionEntry = { ...entry, id };
    cache.entries.push(full);

    const journal = buildMessageJournalEntry(id, entry);
    this.writeJournalEntry(cache, journal);

    return id;
  }

  getRecent(channelId: string, limit: number): SessionEntry[] {
    const cache = this.getOrLoadChannel(channelId);
    if (!cache) return [];
    if (cache.entries.length <= limit) return [...cache.entries];
    return cache.entries.slice(-limit);
  }

  getLastEntry(channelId: string): SessionEntry | undefined {
    const cache = this.getOrLoadChannel(channelId);
    if (!cache) return undefined;
    return cache.entries[cache.entries.length - 1];
  }

  getRecentDiscordMessageIds(channelId: string, limit: number): Set<string> {
    const entries = this.getRecent(channelId, limit);
    const ids = entries
      .map((entry) => entry.discordMessageId)
      .filter((id): id is string => typeof id === 'string' && id.length > 0);
    return new Set(ids);
  }

  count(channelId: string): number {
    return this.getOrLoadChannel(channelId)?.entries.length ?? 0;
  }

  getCompactionSummaries(channelId: string): CompactionSummary[] {
    const cache = this.getOrLoadChannel(channelId);
    return cache ? [...cache.compactions] : [];
  }

  listChannels(): Array<{ channelId: string; messageCount: number }> {
    this.primeChannelCaches();

    return [...this.channels.entries()].map(([channelId, cache]) => ({
      channelId,
      messageCount: cache.entries.length,
    }));
  }

  insertCompaction(channelId: string, summary: string, coveredUpTo: number): void {
    const now = Date.now();
    const cache = this.ensureChannelForWrite(channelId, {
      timestamp: now,
      authorId: 'system',
      authorName: 'system',
    });
    const id = cache.nextId++;

    cache.compactions.push({ id, channelId, summary, coveredUpTo, createdAt: now });

    const journal = buildCompactionJournalEntry(id, channelId, summary, coveredUpTo, now);
    this.writeJournalEntry(cache, journal);
  }

  insertExtractionMarker(channelId: string, coveredUpTo: number, timestamp = Date.now()): void {
    if (!Number.isFinite(coveredUpTo)) return;
    const cache = this.getOrLoadChannel(channelId);
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
    this.primeChannelCaches();
    const channels: string[] = [];

    for (const [channelId, cache] of this.channels.entries()) {
      if (!cache.lastJournalEntry) continue;
      if (this.isGracefulShutdownEntry(cache.lastJournalEntry)) continue;
      channels.push(channelId);
    }

    return channels;
  }

  getCrashRecoveryExtractionCandidates(): CrashRecoveryExtractionCandidate[] {
    this.primeChannelCaches();
    const candidates: CrashRecoveryExtractionCandidate[] = [];

    for (const [channelId, cache] of this.channels.entries()) {
      if (!cache.lastJournalEntry) continue;
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
