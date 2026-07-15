import { existsSync, readdirSync, renameSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import {
  journalToSessionEntry,
  journalToTurnTombstoneEntry,
  journalToMarkerEntry,
  readJournalFile,
  readJournalFirstEntry,
  readJournalTailEntries,
  scanJournalFileMetadata,
} from '../../journals/journal-utils.js';
import { backfillLegacyTurnId } from '../../../core/turns/id.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import type { JournalEntry } from '../../../core/session/types.js';
import {
  CHANNEL_INDEX_FILENAME,
  normalizeOptionalHmac,
  normalizeOptionalJournalType,
  normalizeOptionalMarker,
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalSessionEntryRole,
  normalizeOptionalString,
  type ChannelCache,
  type ChannelIndexEntry,
} from '../store-primitives.js';
import {
  encodedFilePath,
  isReadableSessionJournalFilename,
  isSessionJournalFilename,
  legacyFilePath,
  makeReadableFilePath,
} from './channel-filenames.js';
import {
  deriveSessionIndexId,
  indexedChannelId,
  resolvePrimarySessionId,
  sessionIdForChannelFile,
} from './session-index-keys.js';
import { discoverSessionFileChains } from './session-file-chains.js';
import {
  deleteChannelIndexEntryIfUnchanged,
  upsertChannelIndex,
} from './channel-index-storage.js';

export {
  loadChannelIndex,
  parseChannelIndexEntry,
  saveChannelIndex,
  upsertChannelIndex,
} from './channel-index-storage.js';

const log = createComponentLogger('SessionStore');
const DEFAULT_MESSAGE_PREVIEW_CHARS = 120;

function toMessagePreview(content: string, maxChars = DEFAULT_MESSAGE_PREVIEW_CHARS): string {
  const normalized = content.replace(/\s+/g, ' ').trim();
  if (normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, maxChars - 3)}...`;
}

export function isIndexEntryComplete(entry: ChannelIndexEntry): boolean {
  if (!entry.filename) return false;
  if (entry.filenames.length === 0 || entry.filenames.at(-1) !== entry.filename) return false;
  if (normalizeOptionalNonNegativeNumber(entry.messageCount) === undefined) return false;
  if (normalizeOptionalNonNegativeNumber(entry.activeTurnTombstoneCount) === undefined) return false;
  const activeTurnTombstoneCount = normalizeOptionalNonNegativeNumber(entry.activeTurnTombstoneCount) ?? 0;
  if ((entry.activeTurnTombstoneIds?.length ?? 0) !== activeTurnTombstoneCount) return false;
  if (!normalizeOptionalString(entry.archiveFingerprint)) return false;
  if (!Array.isArray(entry.compactionFilenames)) return false;
  if (entry.compactionFilenames.some(filename => !entry.filenames.includes(filename))) return false;
  if (normalizeOptionalNonNegativeNumber(entry.lastTimestamp) === undefined) return false;

  const maxId = normalizeOptionalNonNegativeNumber(entry.maxId);
  if (maxId === undefined) return false;

  const messageCount = normalizeOptionalNonNegativeNumber(entry.messageCount) ?? 0;
  if (messageCount > 0) {
    if (normalizeOptionalNonNegativeNumber(entry.lastMessageTimestamp) === undefined) return false;
    if (!normalizeOptionalSessionEntryRole(entry.lastMessageRole)) return false;
    if (normalizeOptionalString(entry.lastMessagePreview) === undefined) return false;
  }

  if (normalizeOptionalNonNegativeNumber(entry.lastExtractionCoveredUpTo) === undefined) return false;

  if (maxId === 0) return true;

  const type = normalizeOptionalJournalType(entry.lastJournalType);
  if (!type) return false;
  if (type === 'marker' && !normalizeOptionalMarker(entry.lastMarker)) return false;

  return true;
}

export function fingerprintArchivePaths(filePaths: readonly string[]): string | null {
  const fingerprints: string[] = [];
  for (const filePath of filePaths) {
    try {
      const stats = statSync(filePath);
      fingerprints.push(`${filePath}=${[
        stats.dev,
        stats.ino,
        stats.size,
        stats.mtimeMs,
        stats.ctimeMs,
      ].join(':')}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
  return fingerprints.length > 0 ? fingerprints.join('|') : null;
}

function readLastMessageEntry(filePath: string): JournalEntry | null {
  const tail = readJournalTailEntries(filePath, {
    messageLimit: 1,
    includeBoundaryEntry: false,
  });
  for (let index = tail.entries.length - 1; index >= 0; index -= 1) {
    const candidate = tail.entries[index];
    if (candidate.type === 'message') {
      return candidate;
    }
  }
  return null;
}

function enrichIndexEntryWithLastMessage(entry: ChannelIndexEntry, filePath: string): ChannelIndexEntry {
  const messageCount = normalizeOptionalNonNegativeNumber(entry.messageCount) ?? 0;
  if (messageCount <= 0) {
    return {
      ...entry,
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: undefined,
    };
  }

  const lastMessageEntry = readLastMessageEntry(filePath);
  if (!lastMessageEntry) {
    return entry;
  }

  return {
    ...entry,
    lastMessageTimestamp: lastMessageEntry.timestamp,
    lastMessageRole: normalizeOptionalSessionEntryRole(lastMessageEntry.role) ?? null,
    lastMessageAuthorName: normalizeOptionalString(lastMessageEntry.authorName),
    lastMessagePreview: typeof lastMessageEntry.content === 'string'
      ? toMessagePreview(lastMessageEntry.content)
      : undefined,
  };
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
  const lastMessageEntry = metadata.messageCount > 0 ? readLastMessageEntry(filePath) : null;

  return {
    channelId,
    filename,
    filenames: [filename],
    messageCount: metadata.messageCount,
    activeTurnTombstoneCount: metadata.activeTurnTombstoneCount,
    activeTurnTombstoneIds: metadata.activeTurnTombstoneIds,
    archiveFingerprint: fingerprintArchivePaths([filePath]) ?? undefined,
    compactionFilenames: metadata.compactionCount > 0 ? [filename] : [],
    lastTimestamp: metadata.lastTimestamp,
    lastMessageTimestamp: lastMessageEntry?.timestamp,
    lastMessageRole: normalizeOptionalSessionEntryRole(lastMessageEntry?.role) ?? null,
    lastMessageAuthorName: normalizeOptionalString(lastMessageEntry?.authorName),
    lastMessagePreview: typeof lastMessageEntry?.content === 'string'
      ? toMessagePreview(lastMessageEntry.content)
      : undefined,
    maxId: metadata.maxId,
    lastHmac: metadata.lastHmac,
    lastExtractionCoveredUpTo: metadata.lastExtractionCoveredUpTo,
    lastJournalType: metadata.lastEntry?.type,
    lastMarker: marker?.marker,
  };
}

export function buildIndexEntryChain(
  channelId: string,
  filePaths: readonly string[],
  warnAboutQuarantinedEntries: (
    channelId: string,
    filePath: string,
    quarantinedCount: number,
    loadedCount: number,
  ) => void,
): ChannelIndexEntry {
  if (filePaths.length === 0) {
    throw new Error(`Cannot index L0 session ${channelId} without at least one file`);
  }
  const perFile = filePaths.map(filePath => (
    buildIndexEntry(channelId, filePath, warnAboutQuarantinedEntries)
  ));
  const lastNonEmpty = [...perFile].reverse().find(entry => (entry.maxId ?? 0) > 0);
  const lastWithMessage = [...perFile].reverse().find(entry => (entry.messageCount ?? 0) > 0);
  const activeTurnTombstones = new Set<string>();
  let tombstoneAwareMessageCount: number | null = null;
  if (perFile.some(entry => (entry.activeTurnTombstoneCount ?? 0) > 0)) {
    const messageCountsByTurn = new Map<string, number>();
    for (const filePath of filePaths) {
      const { entries } = readJournalFile(filePath, { persistQuarantine: false });
      for (const rawEntry of entries) {
        const message = journalToSessionEntry(rawEntry);
        if (message) {
          let turnId: string;
          try {
            turnId = resolveSessionEntryTurnContext(message).turnId;
          } catch {
            turnId = backfillLegacyTurnId(
              `legacy-turn:${message.channelId}:${message.id}:${message.timestamp}:${message.role}`,
            );
          }
          messageCountsByTurn.set(turnId, (messageCountsByTurn.get(turnId) ?? 0) + 1);
        }
        const tombstone = journalToTurnTombstoneEntry(rawEntry);
        if (!tombstone) continue;
        if (tombstone.action === 'redact') {
          activeTurnTombstones.add(tombstone.targetId);
        } else {
          activeTurnTombstones.delete(tombstone.targetId);
        }
      }
    }
    tombstoneAwareMessageCount = 0;
    for (const [turnId, count] of messageCountsByTurn.entries()) {
      if (!activeTurnTombstones.has(turnId)) tombstoneAwareMessageCount += count;
    }
  }

  return {
    channelId,
    filename: basename(filePaths.at(-1)!),
    filenames: filePaths.map(filePath => basename(filePath)),
    messageCount: tombstoneAwareMessageCount
      ?? perFile.reduce((sum, entry) => sum + (entry.messageCount ?? 0), 0),
    activeTurnTombstoneCount: activeTurnTombstones.size,
    activeTurnTombstoneIds: [...activeTurnTombstones].sort(),
    archiveFingerprint: fingerprintArchivePaths(filePaths) ?? undefined,
    compactionFilenames: perFile
      .filter(entry => (entry.compactionFilenames?.length ?? 0) > 0)
      .map(entry => entry.filename),
    lastTimestamp: lastNonEmpty?.lastTimestamp ?? 0,
    lastMessageTimestamp: lastWithMessage?.lastMessageTimestamp ?? 0,
    lastMessageRole: lastWithMessage?.lastMessageRole ?? null,
    lastMessageAuthorName: lastWithMessage?.lastMessageAuthorName,
    lastMessagePreview: lastWithMessage?.lastMessagePreview,
    maxId: perFile.reduce((max, entry) => Math.max(max, entry.maxId ?? 0), 0),
    lastHmac: lastNonEmpty?.lastHmac ?? null,
    lastExtractionCoveredUpTo: perFile.reduce(
      (max, entry) => Math.max(max, entry.lastExtractionCoveredUpTo ?? 0),
      0,
    ),
    lastJournalType: lastNonEmpty?.lastJournalType,
    lastMarker: lastNonEmpty?.lastMarker,
  };
}

export function ensureChannelIndexEntry(params: {
  sessionId: string;
  channelId: string;
  filePaths: readonly string[];
  channelIndexPath: string;
  channelIndex: Map<string, ChannelIndexEntry>;
  warnAboutQuarantinedEntries: (
    channelId: string,
    filePath: string,
    quarantinedCount: number,
    loadedCount: number,
  ) => void;
  onEntryRebuilt?: (sessionId: string, entry: ChannelIndexEntry) => void;
}): ChannelIndexEntry {
  if (params.filePaths.length === 0) {
    throw new Error(`Cannot ensure L0 session index entry ${params.sessionId} without files`);
  }
  const filenames = params.filePaths.map(filePath => basename(filePath));
  const filename = filenames.at(-1)!;
  const existing = params.channelIndex.get(params.sessionId);

  if (
    existing
    && existing.filename === filename
    && existing.filenames.length === filenames.length
    && existing.filenames.every((candidate, index) => candidate === filenames[index])
    && indexedChannelId(params.sessionId, existing) === params.channelId
  ) {
    if (
      isIndexEntryComplete(existing)
      && existing.archiveFingerprint === fingerprintArchivePaths(params.filePaths)
    ) {
      return existing;
    }

    const enriched = enrichIndexEntryWithLastMessage(existing, params.filePaths.at(-1)!);
    if (
      isIndexEntryComplete(enriched)
      && enriched.archiveFingerprint === fingerprintArchivePaths(params.filePaths)
    ) {
      upsertChannelIndex(
        params.sessionId,
        enriched,
        params.channelIndexPath,
        params.channelIndex,
      );
      return enriched;
    }
  }

  const rebuilt = buildIndexEntryChain(
    params.channelId,
    params.filePaths,
    params.warnAboutQuarantinedEntries,
  );
  params.onEntryRebuilt?.(params.sessionId, rebuilt);
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
    filenames: cache.archivePaths.map(filePath => basename(filePath)),
    messageCount: cache.messageCount,
    activeTurnTombstoneCount: cache.activeTurnTombstoneCount,
    activeTurnTombstoneIds: [...cache.turnTombstones].sort(),
    archiveFingerprint: cache.archiveFingerprint ?? undefined,
    compactionFilenames: cache.archivePaths
      .filter(filePath => cache.compactionArchivePaths.has(filePath))
      .map(filePath => basename(filePath)),
    lastTimestamp: cache.lastTimestamp,
    lastMessageTimestamp: cache.lastMessageTimestamp,
    lastMessageRole: cache.lastMessageRole,
    lastMessageAuthorName: cache.lastMessageAuthorName,
    lastMessagePreview: cache.lastMessagePreview || undefined,
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
  filePaths: string[];
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
    const indexedPaths = indexed.filenames.map(filename => join(sessionsDir, filename));
    const indexedPath = indexedPaths.at(-1)!;
    if (indexedPaths.every(filePath => existsSync(filePath))) {
      return {
        sessionId: primarySessionId,
        channelId: indexedChannelId(primarySessionId, indexed),
        filePaths: indexedPaths,
        filePath: indexedPath,
      };
    }
  }

  const encodedPath = encodedFilePath(sessionsDir, lookupKey);
  if (existsSync(encodedPath)) {
    return {
      sessionId: lookupKey,
      channelId: lookupKey,
      filePaths: [encodedPath],
      filePath: encodedPath,
    };
  }

  const legacyPath = legacyFilePath(sessionsDir, lookupKey);
  if (existsSync(legacyPath)) {
    return {
      sessionId: lookupKey,
      channelId: lookupKey,
      filePaths: [legacyPath],
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
  filePaths: readonly string[],
  indexEntry: ChannelIndexEntry,
): ChannelCache {
  if (filePaths.length === 0) {
    throw new Error(`Cannot create L0 cache ${channelId} without archive paths`);
  }
  const filePath = filePaths.at(-1)!;
  const maxId = normalizeOptionalNonNegativeNumber(indexEntry.maxId) ?? 0;
  const messageCount = normalizeOptionalNonNegativeNumber(indexEntry.messageCount) ?? 0;
  const lastTimestamp = normalizeOptionalNonNegativeNumber(indexEntry.lastTimestamp) ?? 0;
  const lastMessageTimestamp = normalizeOptionalNonNegativeNumber(indexEntry.lastMessageTimestamp) ?? 0;

  return {
    channelId,
    entries: [],
    compactions: [],
    compactionArchivePaths: new Set(
      (indexEntry.compactionFilenames ?? []).map(filename => join(dirname(filePath), filename)),
    ),
    turnTombstones: new Set(indexEntry.activeTurnTombstoneIds ?? []),
    activeTurnTombstoneCount: normalizeOptionalNonNegativeNumber(indexEntry.activeTurnTombstoneCount) ?? 0,
    nextId: maxId + 1,
    lastHmac: normalizeOptionalHmac(indexEntry.lastHmac) ?? null,
    lastExtractionCoveredUpTo: normalizeOptionalNonNegativeNumber(indexEntry.lastExtractionCoveredUpTo) ?? 0,
    lastJournalEntry: rehydrateLastJournalEntry(channelId, indexEntry),
    archivePaths: [...filePaths],
    resolvedPath: filePath,
    messageCount,
    lastTimestamp,
    lastMessageTimestamp,
    lastMessageRole: normalizeOptionalSessionEntryRole(indexEntry.lastMessageRole) ?? null,
    lastMessageAuthorName: normalizeOptionalString(indexEntry.lastMessageAuthorName),
    lastMessagePreview: normalizeOptionalString(indexEntry.lastMessagePreview) ?? '',
    fullyLoaded: false,
    archiveFingerprint: indexEntry.archiveFingerprint ?? null,
    recentEntriesByLimit: new Map(),
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
    if (isReadableSessionJournalFilename(filename)) continue;

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
        filePaths: [oldPath],
        channelIndexPath: params.channelIndexPath,
        channelIndex: params.channelIndex,
        warnAboutQuarantinedEntries: params.warnAboutQuarantinedEntries,
      });
      if (entry.filename !== basename(oldPath) || indexedChannelId(sessionId, entry) !== channelId) {
        upsertChannelIndex(
          sessionId,
          {
            ...entry,
            channelId,
            filename: basename(oldPath),
            filenames: [basename(oldPath)],
          },
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
  onEntryRebuilt?: (sessionId: string, entry: ChannelIndexEntry) => void;
}): void {
  const indexedChannelByFilename = new Map<string, string>();
  for (const [sessionId, entry] of params.channelIndex.entries()) {
    const channelId = indexedChannelId(sessionId, entry);
    for (const filename of entry.filenames) {
      indexedChannelByFilename.set(filename, channelId);
    }
  }
  const discovered = discoverSessionFileChains(params.sessionsDir, indexedChannelByFilename);
  for (const incomplete of discovered.incompleteChains) {
    log.warn('Ignoring incomplete L0 session segment chain during index rebuild', incomplete);
  }
  const groups = discovered.chains;

  const sessionCountsByChannel = new Map<string, number>();
  for (const group of groups) {
    sessionCountsByChannel.set(group.channelId, (sessionCountsByChannel.get(group.channelId) ?? 0) + 1);
  }

  const indexedSessions = groups.map(group => ({
    ...group,
    sessionId: sessionIdForChannelFile(
      group.channelId,
      group.rootFilename,
      (sessionCountsByChannel.get(group.channelId) ?? 0) > 1,
    ),
  }));

  const expectedByFilename = new Map(
    indexedSessions.flatMap(session => (
      session.filenames.map(filename => [filename, session] as const)
    )),
  );
  for (const [sessionId, entry] of [...params.channelIndex.entries()]) {
    const expected = expectedByFilename.get(entry.filename);
    const filenamesMatch = expected
      && entry.filenames.length === expected.filenames.length
      && entry.filenames.every((filename, index) => filename === expected.filenames[index]);
    if (
      !expected
      || !filenamesMatch
      || expected.sessionId !== sessionId
      || indexedChannelId(sessionId, entry) !== expected.channelId
    ) {
      deleteChannelIndexEntryIfUnchanged(
        sessionId,
        entry,
        params.channelIndexPath,
        params.channelIndex,
      );
    }
  }

  for (const session of indexedSessions) {
    const indexed = params.channelIndex.get(session.sessionId);
    if (
      indexed
      && indexed.filename === session.filenames.at(-1)
      && indexed.filenames.length === session.filenames.length
      && indexed.filenames.every((filename, index) => filename === session.filenames[index])
      && indexedChannelId(session.sessionId, indexed) === session.channelId
      && isIndexEntryComplete(indexed)
    ) {
      continue;
    }

    const entry = buildIndexEntryChain(
      session.channelId,
      session.filePaths,
      params.warnAboutQuarantinedEntries,
    );
    params.onEntryRebuilt?.(session.sessionId, entry);
    upsertChannelIndex(session.sessionId, entry, params.channelIndexPath, params.channelIndex);
  }
}

export {
  CHANNEL_INDEX_FILENAME,
};

export {
  makeReadableFilePath,
} from './channel-filenames.js';
