import { existsSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { basename, join } from 'node:path';
import { createComponentLogger } from '../../logger.js';
import { toErrorMessage } from '../../utils/errors.js';
import { writeJsonAtomic } from '../../utils/fs.js';
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

const log = createComponentLogger('SessionStore');

export function parseChannelIndexEntry(raw: unknown): ChannelIndexEntry | null {
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

export function loadChannelIndex(
  channelIndexPath: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): void {
  if (!existsSync(channelIndexPath)) return;

  try {
    const raw = readFileSync(channelIndexPath, 'utf-8');
    const parsed = JSON.parse(raw) as ChannelIndexFile;
    const version = (parsed as { version?: unknown }).version;

    if ((version !== 1 && version !== CHANNEL_INDEX_VERSION) || typeof parsed.channels !== 'object') {
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

export function ensureChannelIndexEntry(params: {
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
  const existing = params.channelIndex.get(params.channelId);

  if (existing && existing.filename === filename && isIndexEntryComplete(existing)) {
    return existing;
  }

  const rebuilt = buildIndexEntry(
    params.channelId,
    params.filePath,
    params.warnAboutQuarantinedEntries,
  );
  upsertChannelIndex(
    params.channelId,
    rebuilt,
    params.channelIndexPath,
    params.channelIndex,
  );
  return rebuilt;
}

export function snapshotIndexEntry(cache: ChannelCache): ChannelIndexEntry {
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

export function resolveExistingPath(
  sessionsDir: string,
  channelId: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): string | null {
  const indexed = channelIndex.get(channelId);
  if (indexed) {
    const indexedPath = join(sessionsDir, indexed.filename);
    if (existsSync(indexedPath)) return indexedPath;
  }

  const encodedPath = encodedFilePath(sessionsDir, channelId);
  if (existsSync(encodedPath)) return encodedPath;

  const legacyPath = legacyFilePath(sessionsDir, channelId);
  if (existsSync(legacyPath)) return legacyPath;

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
    entries: [],
    compactions: [],
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
      const entry = ensureChannelIndexEntry({
        channelId,
        filePath: oldPath,
        channelIndexPath: params.channelIndexPath,
        channelIndex: params.channelIndex,
        warnAboutQuarantinedEntries: params.warnAboutQuarantinedEntries,
      });
      if (entry.filename !== basename(oldPath)) {
        upsertChannelIndex(
          channelId,
          { ...entry, filename: basename(oldPath) },
          params.channelIndexPath,
          params.channelIndex,
        );
      }
      continue;
    }

    renameSync(oldPath, newPath);
    const entry = buildIndexEntry(channelId, newPath, params.warnAboutQuarantinedEntries);
    upsertChannelIndex(channelId, entry, params.channelIndexPath, params.channelIndex);
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
  const files = readdirSync(params.sessionsDir)
    .filter(isSessionJournalFilename);

  for (const filename of files) {
    const filePath = join(params.sessionsDir, filename);
    const channelId = readChannelIdFromFile(filePath);
    if (!channelId) continue;

    const indexed = params.channelIndex.get(channelId);
    if (indexed && indexed.filename === filename && isIndexEntryComplete(indexed)) {
      continue;
    }

    const entry = buildIndexEntry(channelId, filePath, params.warnAboutQuarantinedEntries);
    upsertChannelIndex(channelId, entry, params.channelIndexPath, params.channelIndex);
  }
}

export {
  CHANNEL_INDEX_FILENAME,
};

export {
  makeReadableFilePath,
} from './channel-filenames.js';
