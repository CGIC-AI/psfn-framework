import { join } from 'node:path';
import type { JournalEntry } from '../../../core/session/types.js';
import {
  normalizeOptionalNonNegativeNumber,
  normalizeOptionalSessionEntryRole,
  normalizeOptionalString,
  type ChannelCache,
  type ChannelIndexEntry,
} from '../store-primitives.js';
import { rehydrateLastJournalEntry } from './channel-index.js';
import type { SessionJournalRuntime } from './journal-runtime.js';

function openChain(runtime: SessionJournalRuntime, cache: ChannelCache) {
  return cache.archivePaths.map(filePath => runtime.openArchive(cache.channelId, filePath));
}

export function setSessionCacheArchivePaths(
  cache: ChannelCache,
  archivePaths: readonly string[],
): void {
  const activePath = archivePaths.at(-1);
  if (!activePath) throw new Error(`Cannot set an empty L0 session chain for ${cache.channelId}`);
  cache.archivePaths = [...archivePaths];
  cache.resolvedPath = activePath;
}

export function buildRecentEntriesFingerprint(cache: ChannelCache): string {
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

export function syncLightweightSessionCacheFromIndex(params: {
  cache: ChannelCache;
  indexEntry: ChannelIndexEntry;
  sessionsDir: string;
}): void {
  if (params.cache.fullyLoaded) return;
  const previousFingerprint = buildRecentEntriesFingerprint(params.cache);
  setSessionCacheArchivePaths(
    params.cache,
    params.indexEntry.filenames.map(filename => join(params.sessionsDir, filename)),
  );
  params.cache.activeTurnTombstoneCount = normalizeOptionalNonNegativeNumber(
    params.indexEntry.activeTurnTombstoneCount,
  ) ?? 0;
  params.cache.nextId = (normalizeOptionalNonNegativeNumber(params.indexEntry.maxId) ?? 0) + 1;
  params.cache.lastHmac = params.indexEntry.lastHmac ?? null;
  params.cache.lastExtractionCoveredUpTo = normalizeOptionalNonNegativeNumber(
    params.indexEntry.lastExtractionCoveredUpTo,
  ) ?? 0;
  params.cache.lastJournalEntry = rehydrateLastJournalEntry(params.cache.channelId, params.indexEntry);
  params.cache.messageCount = normalizeOptionalNonNegativeNumber(params.indexEntry.messageCount) ?? 0;
  params.cache.lastTimestamp = normalizeOptionalNonNegativeNumber(params.indexEntry.lastTimestamp) ?? 0;
  params.cache.lastMessageTimestamp = normalizeOptionalNonNegativeNumber(
    params.indexEntry.lastMessageTimestamp,
  ) ?? 0;
  params.cache.lastMessageRole = normalizeOptionalSessionEntryRole(params.indexEntry.lastMessageRole) ?? null;
  params.cache.lastMessageAuthorName = normalizeOptionalString(params.indexEntry.lastMessageAuthorName);
  params.cache.lastMessagePreview = normalizeOptionalString(params.indexEntry.lastMessagePreview) ?? '';
  if (buildRecentEntriesFingerprint(params.cache) !== previousFingerprint) {
    params.cache.recentEntriesByLimit.clear();
  }
}

export function readSessionJournalChain(
  runtime: SessionJournalRuntime,
  cache: ChannelCache,
): { archives: ReturnType<SessionJournalRuntime['openArchive']>[]; entriesByArchive: JournalEntry[][]; entries: JournalEntry[] } {
  const archives = openChain(runtime, cache);
  const entriesByArchive = runtime.readJournalEntryChain(archives);
  return { archives, entriesByArchive, entries: entriesByArchive.flat() };
}

export function loadSessionJournalChain(
  runtime: SessionJournalRuntime,
  cache: ChannelCache,
): ChannelCache {
  return runtime.loadChannelChain(openChain(runtime, cache));
}

export function fingerprintSessionJournalChain(
  runtime: SessionJournalRuntime,
  cache: ChannelCache,
): string | null {
  return runtime.fingerprintArchiveChain(openChain(runtime, cache));
}

export function fullyLoadedSessionChainIsCurrent(params: {
  cache: ChannelCache;
  indexEntry: ChannelIndexEntry | undefined;
  sessionsDir: string;
  runtime: SessionJournalRuntime;
}): boolean {
  if (!params.cache.fullyLoaded || !params.indexEntry) return false;
  const indexMatchesChain = (
    params.indexEntry.filenames.length === params.cache.archivePaths.length
    && params.indexEntry.filenames.every((filename, index) => (
      join(params.sessionsDir, filename) === params.cache.archivePaths[index]
    ))
  );
  return indexMatchesChain
    && params.cache.archiveFingerprint === fingerprintSessionJournalChain(params.runtime, params.cache);
}

export function reconcileSessionWriteChain(params: {
  cache: ChannelCache;
  indexEntry: ChannelIndexEntry | undefined;
  sessionsDir: string;
  runtime: SessionJournalRuntime;
}): { cache: ChannelCache; refreshIndex: boolean } {
  const indexedPaths = params.indexEntry?.filenames.map(filename => join(params.sessionsDir, filename));
  const chainChanged = indexedPaths !== undefined && (
    indexedPaths.length !== params.cache.archivePaths.length
    || indexedPaths.some((filePath, index) => filePath !== params.cache.archivePaths[index])
  );
  if (chainChanged) {
    return {
      cache: params.runtime.loadChannelChain(
        indexedPaths.map(filePath => params.runtime.openArchive(params.cache.channelId, filePath)),
      ),
      refreshIndex: false,
    };
  }

  const diskFingerprint = fingerprintSessionJournalChain(params.runtime, params.cache);
  if (params.cache.archiveFingerprint && params.cache.archiveFingerprint !== diskFingerprint) {
    return {
      cache: loadSessionJournalChain(params.runtime, params.cache),
      refreshIndex: true,
    };
  }

  const archive = params.runtime.openArchive(params.cache.channelId, params.cache.resolvedPath);
  const metadata = params.runtime.scanArchiveMetadata(archive);
  if (metadata.quarantined.length > 0) {
    params.runtime.warnAboutQuarantinedEntries(
      params.cache.channelId,
      archive,
      metadata.quarantined.length,
      metadata.entryCount,
    );
  }
  const cacheMatchesDisk = (
    params.cache.nextId === metadata.maxId + 1
    && params.cache.lastHmac === metadata.lastHmac
    && params.cache.lastTimestamp === metadata.lastTimestamp
    && (params.cache.lastJournalEntry?.type ?? null) === (metadata.lastEntry?.type ?? null)
  );
  return cacheMatchesDisk
    ? { cache: params.cache, refreshIndex: false }
    : { cache: loadSessionJournalChain(params.runtime, params.cache), refreshIndex: true };
}
