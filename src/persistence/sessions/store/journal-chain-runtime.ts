import { existsSync } from 'node:fs';
import { backfillLegacyTurnId } from '../../../core/turns/id.js';
import {
  journalToCompactionSummary,
  journalToSessionEntry,
} from '../../journals/journal-utils.js';
import type { JournalEntry, SessionEntry } from '../../../core/session/types.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import type {
  SessionArchiveHandle,
  SessionArchivePort,
} from '../../journals/journal/port.js';
import type {
  ChannelCache,
  SessionIntegrityProvider,
} from '../store-primitives.js';
import { applyJournalState } from './crash-recovery.js';

interface NormalizedJournalEntry {
  entry: JournalEntry;
  nextHmacCandidates: Array<string | null>;
  verified: boolean;
}

interface JournalChainContext {
  archivePort: SessionArchivePort;
  normalizeEntry: (
    entry: JournalEntry,
    previousHmacCandidates: readonly (string | null)[],
  ) => NormalizedJournalEntry;
  warnAboutQuarantinedEntries: (
    channelId: string,
    archive: SessionArchiveHandle,
    quarantinedCount: number,
    loadedCount: number,
  ) => void;
}

function applyTurnTombstones(
  entries: readonly SessionEntry[],
  tombstones: ReadonlySet<string>,
): SessionEntry[] {
  if (tombstones.size === 0) return [...entries];
  return entries.filter((entry) => {
    let turnId: string;
    try {
      turnId = resolveSessionEntryTurnContext(entry).turnId;
    } catch {
      turnId = backfillLegacyTurnId(
        `legacy-turn:${entry.channelId}:${entry.id}:${entry.timestamp}:${entry.role}`,
      );
    }
    return !tombstones.has(turnId);
  });
}

export function fingerprintJournalArchiveChain(
  archivePort: SessionArchivePort,
  archives: readonly SessionArchiveHandle[],
): string | null {
  archivePort.assertJournalChainReadable(archives);
  const fingerprints: string[] = [];
  for (const archive of archives) {
    const fingerprint = archivePort.fingerprintArchive(archive);
    if (!fingerprint) return null;
    fingerprints.push(`${archivePort.resolveArchivePath(archive)}=${fingerprint}`);
  }
  return fingerprints.join('|');
}

function loadJournalArchiveChainAttempt(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
  retriesRemaining: number,
): ChannelCache {
  if (archives.length === 0) throw new Error('Cannot load an L0 session without at least one archive');
  const archivePaths = archives.map(archive => context.archivePort.resolveArchivePath(archive));
  context.archivePort.assertJournalChainReadable(archives);
  const activeArchive = archives.at(-1)!;
  const cache: ChannelCache = {
    channelId: activeArchive.channelId,
    entries: [],
    compactions: [],
    turnTombstones: new Set(),
    activeTurnTombstoneCount: 0,
    nextId: 1,
    lastHmac: null,
    lastExtractionCoveredUpTo: 0,
    lastJournalEntry: null,
    archivePaths,
    resolvedPath: archivePaths.at(-1)!,
    messageCount: 0,
    lastTimestamp: 0,
    lastMessageTimestamp: 0,
    lastMessageRole: null,
    lastMessageAuthorName: undefined,
    lastMessagePreview: '',
    fullyLoaded: true,
    archiveFingerprint: null,
    recentEntriesByLimit: new Map(),
  };
  const missingArchivePaths = archivePaths.filter(archivePath => !existsSync(archivePath));
  if (missingArchivePaths.length > 0) {
    if (archives.length === 1) return cache;
    throw new Error(
      `Cannot load incomplete L0 session ${activeArchive.channelId}; missing segments: `
      + missingArchivePaths.join(', '),
    );
  }

  const beforeFingerprint = fingerprintJournalArchiveChain(context.archivePort, archives);
  let previousHmacCandidates: Array<string | null> = [null];
  let maxId = 0;
  for (const archive of archives) {
    const result = context.archivePort.readJournalFile(archive);
    maxId = Math.max(maxId, result.maxId);
    if (result.quarantined.length > 0) {
      context.warnAboutQuarantinedEntries(
        archive.channelId,
        archive,
        result.quarantined.length,
        result.entries.length,
      );
    }
    for (const rawEntry of result.entries) {
      const normalized = context.normalizeEntry(rawEntry, previousHmacCandidates);
      previousHmacCandidates = normalized.nextHmacCandidates;
      applyJournalState(cache, normalized.entry);
      const message = journalToSessionEntry(normalized.entry);
      if (message) {
        cache.entries.push(message);
        cache.messageCount += 1;
      } else {
        const compaction = journalToCompactionSummary(normalized.entry);
        if (compaction) cache.compactions.push(compaction);
      }
    }
  }

  const afterFingerprint = fingerprintJournalArchiveChain(context.archivePort, archives);
  if (beforeFingerprint !== afterFingerprint) {
    if (retriesRemaining > 0) {
      return loadJournalArchiveChainAttempt(context, archives, retriesRemaining - 1);
    }
    throw new Error(
      `L0 session ${activeArchive.channelId} changed repeatedly while loading; refusing a mixed-generation read`,
    );
  }

  cache.archiveFingerprint = afterFingerprint;
  cache.nextId = maxId + 1;
  cache.lastHmac = previousHmacCandidates[0] ?? null;
  cache.entries = applyTurnTombstones(cache.entries, cache.turnTombstones);
  cache.messageCount = cache.entries.length;
  const lastMessage = cache.entries.at(-1);
  if (lastMessage) {
    cache.lastMessageTimestamp = lastMessage.timestamp;
    cache.lastMessageRole = lastMessage.role;
    cache.lastMessageAuthorName = lastMessage.authorName;
    const preview = lastMessage.content.replace(/\s+/g, ' ').trim();
    cache.lastMessagePreview = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  }
  cache.activeTurnTombstoneCount = cache.turnTombstones.size;
  return cache;
}

export function loadJournalArchiveChain(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
): ChannelCache {
  return loadJournalArchiveChainAttempt(context, archives, 1);
}

export function rewriteJournalArchiveChain(
  archivePort: SessionArchivePort,
  integrityProvider: SessionIntegrityProvider | null,
  archives: readonly SessionArchiveHandle[],
  entriesByArchive: readonly (readonly JournalEntry[])[],
  renewLease?: () => void,
): JournalEntry[][] {
  if (archives.length !== entriesByArchive.length) {
    throw new Error('L0 session rewrite requires one journal entry set per archive');
  }
  const rewrittenByArchive: JournalEntry[][] = [];
  let previousHmac: string | null = null;
  for (const entries of entriesByArchive) {
    const rewritten: JournalEntry[] = [];
    for (const entry of entries) {
      const { _hmac, _hmacKeyVersion, ...unsigned } = entry;
      if (!integrityProvider) {
        rewritten.push(unsigned);
        continue;
      }
      const signed = integrityProvider.sign(unsigned, previousHmac);
      rewritten.push(signed);
      previousHmac = signed._hmac ?? previousHmac;
      renewLease?.();
    }
    rewrittenByArchive.push(rewritten);
  }
  archivePort.rewriteJournalChain(archives, rewrittenByArchive, renewLease);
  return rewrittenByArchive;
}

function readRecentEntriesFromJournalArchiveChainAttempt(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
  limit: number,
  retriesRemaining: number,
): SessionEntry[] {
  if (limit <= 0 || archives.length === 0) return [];
  const beforeFingerprint = fingerprintJournalArchiveChain(context.archivePort, archives);
  const blocks: JournalEntry[][] = [];
  let earliestArchiveIndex = archives.length;
  let remainingMessages = limit;
  for (let archiveIndex = archives.length - 1; archiveIndex >= 0; archiveIndex -= 1) {
    const archive = archives[archiveIndex]!;
    const metadata = context.archivePort.scanJournalFileMetadata(archive);
    let entries: JournalEntry[];
    if (metadata.messageCount === 0) {
      const result = context.archivePort.readJournalFile(archive);
      entries = result.entries;
      if (result.quarantined.length > 0) {
        context.warnAboutQuarantinedEntries(
          archive.channelId,
          archive,
          result.quarantined.length,
          entries.length,
        );
      }
    } else {
      const tail = context.archivePort.readJournalTailEntries(archive, {
        messageLimit: remainingMessages,
        includeBoundaryEntry: true,
      });
      entries = tail.entries;
      if (tail.quarantined.length > 0) {
        context.warnAboutQuarantinedEntries(
          archive.channelId,
          archive,
          tail.quarantined.length,
          entries.length,
        );
      }
      remainingMessages -= entries.filter(entry => entry.type === 'message').length;
    }
    blocks.unshift(entries);
    earliestArchiveIndex = archiveIndex;
    if (remainingMessages <= 0) break;
  }

  const rawEntries = blocks.flat();
  const messageIndexes = rawEntries
    .map((entry, index) => entry.type === 'message' ? index : -1)
    .filter(index => index >= 0);
  if (messageIndexes.length === 0) {
    const afterFingerprint = fingerprintJournalArchiveChain(context.archivePort, archives);
    if (beforeFingerprint !== afterFingerprint) {
      if (retriesRemaining > 0) {
        return readRecentEntriesFromJournalArchiveChainAttempt(
          context,
          archives,
          limit,
          retriesRemaining - 1,
        );
      }
      throw new Error(
        `L0 session ${archives.at(-1)!.channelId} changed repeatedly while reading its tail`,
      );
    }
    return [];
  }
  const oldestMessageIndex = messageIndexes[Math.max(0, messageIndexes.length - limit)]!;
  let previousHmacCandidates: Array<string | null> = [null];
  if (oldestMessageIndex > 0) {
    const boundaryEntry = rawEntries[oldestMessageIndex - 1]!;
    previousHmacCandidates = typeof boundaryEntry._hmac === 'string' ? [boundaryEntry._hmac] : [null];
  } else if (earliestArchiveIndex > 0) {
    previousHmacCandidates = [
      context.archivePort.scanJournalFileMetadata(archives[earliestArchiveIndex - 1]!).lastHmac,
    ];
  }

  const messages: SessionEntry[] = [];
  let verificationFailed = false;
  for (let index = oldestMessageIndex; index < rawEntries.length; index += 1) {
    const normalized = context.normalizeEntry(rawEntries[index]!, previousHmacCandidates);
    previousHmacCandidates = normalized.nextHmacCandidates;
    verificationFailed ||= !normalized.verified;
    const message = journalToSessionEntry(normalized.entry);
    if (message) messages.push(message);
  }
  const afterFingerprint = fingerprintJournalArchiveChain(context.archivePort, archives);
  if (beforeFingerprint !== afterFingerprint) {
    if (retriesRemaining > 0) {
      return readRecentEntriesFromJournalArchiveChainAttempt(
        context,
        archives,
        limit,
        retriesRemaining - 1,
      );
    }
    throw new Error(
      `L0 session ${archives.at(-1)!.channelId} changed repeatedly while reading its tail`,
    );
  }
  if (verificationFailed) {
    const loaded = loadJournalArchiveChain(context, archives);
    return loaded.entries.length <= limit ? [...loaded.entries] : loaded.entries.slice(-limit);
  }
  return messages.length <= limit ? messages : messages.slice(-limit);
}

export function readRecentEntriesFromJournalArchiveChain(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
  limit: number,
): SessionEntry[] {
  return readRecentEntriesFromJournalArchiveChainAttempt(context, archives, limit, 1);
}
