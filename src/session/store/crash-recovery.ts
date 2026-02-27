import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  buildGracefulShutdownMarkerJournalEntry,
  journalToMarkerEntry,
} from '../journal-utils.js';
import type { JournalEntry } from '../types.js';
import type {
  ChannelCache,
  ChannelIndexEntry,
  CrashRecoveryExtractionCandidate,
} from '../store-primitives.js';

export function isGracefulShutdownEntry(entry: JournalEntry | null): boolean {
  const marker = entry ? journalToMarkerEntry(entry) : null;
  return marker?.marker === 'graceful_shutdown';
}

export function applyJournalState(cache: ChannelCache, entry: JournalEntry): void {
  cache.lastJournalEntry = entry;
  cache.lastTimestamp = entry.timestamp;

  const marker = journalToMarkerEntry(entry);
  if (marker?.marker === 'extraction' && typeof marker.coveredUpTo === 'number') {
    cache.lastExtractionCoveredUpTo = Math.max(cache.lastExtractionCoveredUpTo, marker.coveredUpTo);
  }
}

export function markGracefulShutdownForActiveChannels(params: {
  channels: Map<string, ChannelCache>;
  timestamp: number;
  writeJournalEntry: (cache: ChannelCache, journal: JournalEntry) => void;
}): string[] {
  const marked: string[] = [];

  for (const [channelId, cache] of params.channels.entries()) {
    if (!cache.lastJournalEntry) continue;
    if (isGracefulShutdownEntry(cache.lastJournalEntry)) continue;

    const id = cache.nextId++;
    const journal = buildGracefulShutdownMarkerJournalEntry(id, channelId, params.timestamp);
    params.writeJournalEntry(cache, journal);
    marked.push(channelId);
  }

  return marked;
}

export function getUncleanShutdownChannels(params: {
  sessionsDir: string;
  channelIndex: Map<string, ChannelIndexEntry>;
  primeChannelIndexFromDisk: () => void;
  ensureChannelIndexEntry: (channelId: string, filePath: string) => ChannelIndexEntry;
  rehydrateLastJournalEntry: (channelId: string, indexEntry: ChannelIndexEntry) => JournalEntry | null;
}): string[] {
  params.primeChannelIndexFromDisk();
  const channels: string[] = [];

  for (const [channelId, indexEntry] of params.channelIndex.entries()) {
    const filePath = join(params.sessionsDir, indexEntry.filename);
    if (!existsSync(filePath)) continue;

    const ensured = params.ensureChannelIndexEntry(channelId, filePath);
    const lastEntry = params.rehydrateLastJournalEntry(channelId, ensured);
    if (!lastEntry) continue;
    if (isGracefulShutdownEntry(lastEntry)) continue;
    channels.push(channelId);
  }

  return channels;
}

export function getCrashRecoveryExtractionCandidates(params: {
  getUncleanShutdownChannels: () => string[];
  ensureChannelFullyLoaded: (channelId: string) => ChannelCache | null;
}): CrashRecoveryExtractionCandidate[] {
  const candidates: CrashRecoveryExtractionCandidate[] = [];

  for (const channelId of params.getUncleanShutdownChannels()) {
    const cache = params.ensureChannelFullyLoaded(channelId);
    if (!cache || !cache.lastJournalEntry) continue;
    if (isGracefulShutdownEntry(cache.lastJournalEntry)) continue;

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
