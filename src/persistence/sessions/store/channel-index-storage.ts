import { existsSync, readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import {
  CHANNEL_INDEX_VERSION,
  channelIndexEntryEquals,
  normalizeOptionalHmac,
  normalizeOptionalJournalType,
  normalizeOptionalMarker,
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalSessionEntryRole,
  normalizeOptionalString,
  type ChannelIndexEntry,
  type ChannelIndexFile,
} from '../store-primitives.js';
import { isSessionJournalFilename } from './channel-filenames.js';
import { withChannelIndexWriteLock } from './channel-index-write-lock.js';

const log = createComponentLogger('SessionStore');

export function parseChannelIndexEntry(raw: unknown): ChannelIndexEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.filename !== 'string' || row.filename.length === 0) return null;
  const filenames = row.filenames === undefined
    ? [row.filename]
    : Array.isArray(row.filenames)
      && row.filenames.every(filename => typeof filename === 'string' && filename.length > 0)
      ? row.filenames as string[]
      : [];
  if (filenames.length === 0 || filenames.length !== new Set(filenames).size) return null;
  if (filenames.some(filename => (
    filename !== basename(filename)
    || filename.includes('\\')
    || !isSessionJournalFilename(filename)
  ))) return null;
  if (filenames.at(-1) !== row.filename) return null;

  const entry: ChannelIndexEntry = {
    filename: row.filename,
    filenames,
  };
  if (typeof row.channelId === 'string' && row.channelId.trim().length > 0) {
    entry.channelId = row.channelId.trim();
  }
  const messageCount = normalizeOptionalNonNegativeNumber(row.messageCount);
  if (messageCount !== undefined) entry.messageCount = messageCount;
  const activeTurnTombstoneCount = normalizeOptionalNonNegativeNumber(row.activeTurnTombstoneCount);
  if (activeTurnTombstoneCount !== undefined) entry.activeTurnTombstoneCount = activeTurnTombstoneCount;
  if (Array.isArray(row.activeTurnTombstoneIds)) {
    entry.activeTurnTombstoneIds = [...new Set(row.activeTurnTombstoneIds
      .filter((candidate): candidate is string => typeof candidate === 'string' && candidate.trim().length > 0)
      .map(candidate => candidate.trim()))].sort();
  }
  const archiveFingerprint = normalizeOptionalString(row.archiveFingerprint);
  if (archiveFingerprint !== undefined) entry.archiveFingerprint = archiveFingerprint;
  if (Array.isArray(row.compactionFilenames)) {
    const compactionFilenames = row.compactionFilenames
      .filter((candidate): candidate is string => typeof candidate === 'string');
    if (
      compactionFilenames.length !== row.compactionFilenames.length
      || compactionFilenames.some(filename => !filenames.includes(filename))
    ) return null;
    entry.compactionFilenames = [...new Set(compactionFilenames)];
  }
  const lastTimestamp = normalizeOptionalNonNegativeNumber(row.lastTimestamp);
  if (lastTimestamp !== undefined) entry.lastTimestamp = lastTimestamp;
  const lastMessageTimestamp = normalizeOptionalNonNegativeNumber(row.lastMessageTimestamp);
  if (lastMessageTimestamp !== undefined) entry.lastMessageTimestamp = lastMessageTimestamp;
  const lastMessageRole = normalizeOptionalSessionEntryRole(row.lastMessageRole);
  if (lastMessageRole !== undefined) entry.lastMessageRole = lastMessageRole;
  const lastMessageAuthorName = normalizeOptionalString(row.lastMessageAuthorName);
  if (lastMessageAuthorName !== undefined) entry.lastMessageAuthorName = lastMessageAuthorName;
  const lastMessagePreview = normalizeOptionalString(row.lastMessagePreview);
  if (lastMessagePreview !== undefined) entry.lastMessagePreview = lastMessagePreview;
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
  options: { persistMigration?: boolean } = {},
): void {
  if (!existsSync(channelIndexPath)) return;
  try {
    const parsed = JSON.parse(readFileSync(channelIndexPath, 'utf-8')) as ChannelIndexFile;
    const version = (parsed as { version?: unknown }).version;
    if (
      (version !== 1 && version !== 2 && version !== 3 && version !== 4 && version !== CHANNEL_INDEX_VERSION)
      || typeof parsed.channels !== 'object'
    ) {
      log.warn('Ignoring invalid channel index payload', { path: channelIndexPath, version });
      return;
    }
    for (const [channelId, rawEntry] of Object.entries(parsed.channels)) {
      const entry = parseChannelIndexEntry(rawEntry);
      if (entry) channelIndex.set(channelId, entry);
    }
    if (version !== CHANNEL_INDEX_VERSION && options.persistMigration !== false) {
      withChannelIndexWriteLock(channelIndexPath, () => {
        const latest = new Map<string, ChannelIndexEntry>();
        loadChannelIndex(channelIndexPath, latest, { persistMigration: false });
        writeChannelIndexFile(channelIndexPath, latest);
        replaceLocalIndex(channelIndex, latest);
      });
    }
  } catch (error) {
    log.warn('Failed to parse channel index file; falling back to disk scan', {
      path: channelIndexPath,
      error: toErrorMessage(error),
    });
  }
}

function replaceLocalIndex(
  target: Map<string, ChannelIndexEntry>,
  source: ReadonlyMap<string, ChannelIndexEntry>,
): void {
  target.clear();
  for (const [sessionId, entry] of source.entries()) target.set(sessionId, entry);
}

function writeChannelIndexFile(
  channelIndexPath: string,
  channelIndex: ReadonlyMap<string, ChannelIndexEntry>,
): void {
  const payload: ChannelIndexFile = {
    version: CHANNEL_INDEX_VERSION,
    channels: Object.fromEntries(channelIndex.entries()),
  };
  writeJsonAtomic(channelIndexPath, payload);
}

export function saveChannelIndex(
  channelIndexPath: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): void {
  withChannelIndexWriteLock(channelIndexPath, () => writeChannelIndexFile(channelIndexPath, channelIndex));
}

export function upsertChannelIndex(
  channelId: string,
  entry: ChannelIndexEntry,
  channelIndexPath: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): void {
  withChannelIndexWriteLock(channelIndexPath, () => {
    const latest = new Map<string, ChannelIndexEntry>();
    loadChannelIndex(channelIndexPath, latest, { persistMigration: false });
    if (!channelIndexEntryEquals(latest.get(channelId), entry)) {
      latest.set(channelId, entry);
      writeChannelIndexFile(channelIndexPath, latest);
    }
    replaceLocalIndex(channelIndex, latest);
  });
}

export function deleteChannelIndexEntryIfUnchanged(
  channelId: string,
  expected: ChannelIndexEntry,
  channelIndexPath: string,
  channelIndex: Map<string, ChannelIndexEntry>,
): void {
  withChannelIndexWriteLock(channelIndexPath, () => {
    const latest = new Map<string, ChannelIndexEntry>();
    loadChannelIndex(channelIndexPath, latest, { persistMigration: false });
    if (channelIndexEntryEquals(latest.get(channelId), expected)) {
      latest.delete(channelId);
      writeChannelIndexFile(channelIndexPath, latest);
    }
    replaceLocalIndex(channelIndex, latest);
  });
}
