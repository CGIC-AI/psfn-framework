import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createComponentLogger } from '../../logger.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  journalToMarkerEntry,
  readJournalFirstEntry,
  scanJournalFileMetadata,
} from '../journal-utils.js';
import type { JournalEntry } from '../types.js';
import {
  CHANNEL_INDEX_FILENAME,
  CHANNEL_INDEX_VERSION,
  channelIndexEntryEquals,
  normalizeOptionalHmac,
  normalizeOptionalJournalType,
  normalizeOptionalMarker,
  normalizeOptionalNonNegativeNumber,
  type ChannelCache,
  type ChannelIndexEntry,
  type ChannelIndexFile,
} from '../store-primitives.js';
import {
  READABLE_SESSION_FILENAME,
  encodedFilePath,
  isSessionJournalFilename,
  legacyFilePath,
  makeReadableFilePath,
  readChannelIdFromFile,
} from './channel-filenames.js';
import {
  deriveSessionIndexId,
  indexedChannelId,
  resolvePrimarySessionId,
  sessionIdForChannelFile,
} from './session-index-keys.js';

const log = createComponentLogger('SessionStore');

export function parseChannelIndexEntry(raw: unknown): ChannelIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.filename !== 'string' || row.filename.length === 0) return null;

  const entry: ChannelIndexEntry = {
    filename: row.filename,
  };

  if (typeof row.channelId === 'string' && row.channelId.trim().length > 0) {
    entry.channelId = row.channelId.trim();
  }

  const messageCount = normalizeOptionalNonNegativeNumber(row.messageCount);
  if (messageCount !== undefined) entry.messageCount = messageCount;

  const activeTurnTombstoneCount = normalizeOptionalNonNegativeNumber(row.activeTurnTombstoneCount);
  if (activeTurnTombstoneCount !== undefined) entry.activeTurnTombstoneCount = activeTurnTombstoneCount;

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

export function loadChannelIndex(
  channelIndexPath: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): void {
  if (!existsSync(channelIndexPath)) return;

  try {
    const raw = readFileSync(channelIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as ChannelIndexFile;
    const version = (parsed as { version?: unknown }).version;

    if ((version !== 1 && version !== 2 && version !== CHANNEL_INDEX_VERSION) || typeof parsed.channels !== 'object') {
      log.warn('Ignoring invalid channel index payload', {
        path: channelIndexPath,
        version,
      });
      return;
    }

    for (const [channelId, rawEntry] of Object.entries(parsed.channels)) {
      const entry = parseChannelIndexEntry(rawEntry);
      if (!entry) continue;
      channelIndex.set(channelId, entry);
    }
  } catch (err) {
    log.warn('Failed to parse channel index file; falling back to disk scan', {
      path: channelIndexPath,
      error: toErrorMessage(err),
    });
  }
}

export function saveChannelIndex(
  channelIndexPath: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): void {
  const payload: ChannelIndexFile = {
    version: CHANNEL_INDEX_VERSION,
    channels: Object.fromEntries(channelIndex.entries()),
  };
  writeJsonAtomic(channelIndexPath, payload);
}

export function upsertChannelIndex(
  channelId: string,
  entry: ChannelIndexEntry,
  channelIndexPath: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): void {
  const existing = channelIndex.get(channelId);
  if (channelIndexEntryEquals(existing, entry)) return;
  channelIndex.set(channelId, entry);
  saveChannelIndex(channelIndexPath, channelIndex);
}

export function isIndexEntryComplete(entry: ChannelIndexEntry): boolean {
  if (!entry.filename) return false;
  if (normalizeOptionalNonNegativeNumber(entry.messageCount) === undefined) return false;
  if (normalizeOptionalNonNegativeNumber(entry.activeTurnTombstoneCount) === undefined) return false;
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

export function buildIndexEntry(
  channelId: string,
  filePath: string,
  warnAboutQuarantinedEntries: (
    channelId: string,
    filePath: string,
    quarantinedCount: number,
    loadedCount: number,
  ) => void,
): ChannelIndexEntry {
  const filename = basename(filePath);
  const metadata = scanJournalFileMetadata(filePath);
  if (metadata.quarantined.length > 0) {
    warnAboutQuarantinedEntries(channelId, filePath, metadata.quarantined.length, metadata.entryCount);
  }

  const marker = metadata.lastEntry ? journalToMarkerEntry(metadata.lastEntry) : null;

  return {
    channelId,
    filename,
    messageCount: metadata.messageCount,
    activeTurnTombstoneCount: metadata.activeTurnTombstoneCount,
    lastTimestamp: metadata.lastTimestamp,
    maxId: metadata.maxId,
    lastHmac: metadata.lastHmac,
    lastExtractionCoveredUpTo: metadata.lastExtractionCoveredUpTo,
    lastJournalType: metadata.lastEntry?.type,
    lastMarker: marker?.marker,
  };
}

export function ensureChannelIndexEntry(params: {
  sessionId: string;
  channelId: string;
  filePath: string;
  channelIndexPath: string;
  channelIndex: Map<string, ChannelIndexEntry>;
  warnAboutQuarantinedEntries: (
    channelId: string,
    filePath: string,
    quarantinedCount: number,
    loadedCount: number,
  ) => void;
}): ChannelIndexEntry {
  const filename = basename(params.filePath);
  const existing = params.channelIndex.get(params.sessionId);

  if (
    existing
    && existing.filename === filename
    && indexedChannelId(params.sessionId, existing) === params.channelId
    && isIndexEntryComplete(existing)
  ) {
    return existing;
  }

  const rebuilt = buildIndexEntry(
    params.channelId,
    params.filePath,
    params.warnAboutQuarantinedEntries,
  );
  upsertChannelIndex(
    params.sessionId,
    rebuilt,
    params.channelIndexPath,
    params.channelIndex,
  );
  return rebuilt;
}

export function snapshotIndexEntry(cache: ChannelCache): ChannelIndexEntry {
  const marker = cache.lastJournalEntry ? journalToMarkerEntry(cache.lastJournalEntry) : null;

  return {
    channelId: cache.channelId,
    filename: basename(cache.resolvedPath),
    messageCount: cache.messageCount,
    activeTurnTombstoneCount: cache.activeTurnTombstoneCount,
    lastTimestamp: cache.lastTimestamp,
    maxId: cache.nextId - 1,
    lastHmac: cache.lastHmac,
    lastExtractionCoveredUpTo: cache.lastExtractionCoveredUpTo,
    lastJournalType: cache.lastJournalEntry?.type,
    lastMarker: marker?.marker,
  };
}

export interface ResolvedIndexedSession {
  sessionId: string;
  channelId: string;
  filePath: string;
}

export function resolveExistingSession(
  sessionsDir: string,
  lookupKey: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): ResolvedIndexedSession | null {
  const primarySessionId = resolvePrimarySessionId(lookupKey, channelIndex) ?? lookupKey;
  const indexed = channelIndex.get(primarySessionId);
  if (indexed) {
    const indexedPath = join(sessionsDir, indexed.filename);
    if (existsSync(indexedPath)) {
      return {
        sessionId: primarySessionId,
        channelId: indexedChannelId(primarySessionId, indexed),
        filePath: indexedPath,
      };
    }
  }

  const encodedPath = encodedFilePath(sessionsDir, lookupKey);
  if (existsSync(encodedPath)) {
    return {
      sessionId: lookupKey,
      channelId: lookupKey,
      filePath: encodedPath,
    };
  }

  const legacyPath = legacyFilePath(sessionsDir, lookupKey);
  if (existsSync(legacyPath)) {
    return {
      sessionId: lookupKey,
      channelId: lookupKey,
      filePath: legacyPath,
    };
  }

  return null;
}

export function rehydrateLastJournalEntry(
  channelId: string,
  indexEntry: ChannelIndexEntry,
): JournalEntry | null {
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

  if (type === 'tombstone') {
    return {
      type: 'tombstone',
      id: maxId,
      channelId,
      timestamp: lastTimestamp,
      tombstoneTargetType: 'turn',
      tombstoneTargetId: 'unknown',
      tombstoneAction: 'redact',
    };
  }

  return {
    type: 'message',
    id: maxId,
    channelId,
    timestamp: lastTimestamp,
  };
}

export function createLightweightCache(
  channelId: string,
  filePath: string,
  indexEntry: ChannelIndexEntry,
): ChannelCache {
  const maxId = normalizeOptionalNonNegativeNumber(indexEntry.maxId) ?? 0;
  const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
  const lastTimestamp = normalizeOptionalNonNegativeNumber(indexEntry.lastTimestamp) ?? 0;

  return {
    channelId,
    entries: [],
    compactions: [],
    turnTombstones: new Set(),
    activeTurnTombstoneCount: normalizeOptionalNonNegativeNumber(indexEntry.activeTurnTombstoneCount) ?? 0,
    nextId: maxId + 1,
    lastHmac: normalizeOptionalHmac(indexEntry.lastHmac) ?? null,
    lastExtractionCoveredUpTo: normalizeOptionalNonNegativeNumber(indexEntry.lastExtractionCoveredUpTo) ?? 0,
    lastJournalEntry: rehydrateLastJournalEntry(channelId, indexEntry),
    resolvedPath: filePath,
    messageCount,
    lastTimestamp,
    fullyLoaded: false,
  };
}

export function migrateLegacyFilenames(params: {
  sessionsDir: string;
  channelIndexPath: string;
  channelIndex: Map<string, ChannelIndexEntry>;
  warnAboutQuarantinedEntries: (
    channelId: string,
    filePath: string,
    quarantinedCount: number,
    loadedCount: number,
  ) => void;
}): void {
  const files = readdirSync(params.sessionsDir)
    .filter(isSessionJournalFilename);

  for (const filename of files) {
    if (READABLE_SESSION_FILENAME.test(filename)) continue;

    const oldPath = join(params.sessionsDir, filename);
    const firstEntry = readJournalFirstEntry(oldPath);
    if (!firstEntry || !firstEntry.channelId) continue;

    const channelId = firstEntry.channelId;
    const timestamp = firstEntry.timestamp;
    const authorId = firstEntry.authorId;
    const authorName = firstEntry.authorName;

    const newPath = makeReadableFilePath(params.sessionsDir, channelId, {
      timestamp,
      authorId,
      authorName,
    });
    if (newPath === oldPath) {
      const sessionId = deriveSessionIndexId(channelId, basename(oldPath), params.channelIndex);
      const entry = ensureChannelIndexEntry({
        sessionId,
        channelId,
        filePath: oldPath,
        channelIndexPath: params.channelIndexPath,
        channelIndex: params.channelIndex,
        warnAboutQuarantinedEntries: params.warnAboutQuarantinedEntries,
      });
      if (entry.filename !== basename(oldPath) || indexedChannelId(sessionId, entry) !== channelId) {
        upsertChannelIndex(
          sessionId,
          { ...entry, channelId, filename: basename(oldPath) },
          params.channelIndexPath,
          params.channelIndex,
        );
      }
      continue;
    }

    renameSync(oldPath, newPath);
    const entry = buildIndexEntry(channelId, newPath, params.warnAboutQuarantinedEntries);
    const sessionId = deriveSessionIndexId(channelId, basename(newPath), params.channelIndex);
    upsertChannelIndex(sessionId, entry, params.channelIndexPath, params.channelIndex);
  }
}

export function primeChannelIndexFromDisk(params: {
  sessionsDir: string;
  channelIndexPath: string;
  channelIndex: Map<string, ChannelIndexEntry>;
  warnAboutQuarantinedEntries: (
    channelId: string,
    filePath: string,
    quarantinedCount: number,
    loadedCount: number,
  ) => void;
}): void {
  const scannedSessions = readdirSync(params.sessionsDir)
    .filter(isSessionJournalFilename)
    .map((filename) => {
      const filePath = join(params.sessionsDir, filename);
      const channelId = readChannelIdFromFile(filePath);
      return channelId ? { filename, filePath, channelId } : null;
    })
    .filter((entry): entry is { filename: string; filePath: string; channelId: string } => entry !== null)
    .sort((left, right) => left.filename.localeCompare(right.filename));

  const sessionCountsByChannel = new Map<string, number>();
  for (const session of scannedSessions) {
    sessionCountsByChannel.set(session.channelId, (sessionCountsByChannel.get(session.channelId) ?? 0) + 1);
  }

  const indexedSessions = scannedSessions.map((session) => ({
    ...session,
    sessionId: sessionIdForChannelFile(
      session.channelId,
      session.filename,
      (sessionCountsByChannel.get(session.channelId) ?? 0) > 1,
    ),
  }));

  const expectedByFilename = new Map(
    indexedSessions.map(session => [session.filename, session]),
  );
  let removedStaleEntries = false;
  for (const [sessionId, entry] of [...params.channelIndex.entries()]) {
    const expected = expectedByFilename.get(entry.filename);
    if (!expected || expected.sessionId !== sessionId || indexedChannelId(sessionId, entry) !== expected.channelId) {
      params.channelIndex.delete(sessionId);
      removedStaleEntries = true;
    }
  }
  if (removedStaleEntries) {
    saveChannelIndex(params.channelIndexPath, params.channelIndex);
  }

  for (const session of indexedSessions) {
    const indexed = params.channelIndex.get(session.sessionId);
    if (
      indexed
      && indexed.filename === session.filename
      && indexedChannelId(session.sessionId, indexed) === session.channelId
      && isIndexEntryComplete(indexed)
    ) {
      continue;
    }

    const entry = buildIndexEntry(session.channelId, session.filePath, params.warnAboutQuarantinedEntries);
    upsertChannelIndex(session.sessionId, entry, params.channelIndexPath, params.channelIndex);
  }
}

export {
  CHANNEL_INDEX_FILENAME,
};

export {
  makeReadableFilePath,
} from './channel-filenames.js';
