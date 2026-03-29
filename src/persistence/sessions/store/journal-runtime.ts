import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { backfillLegacyTurnId } from '../../../core/turns/id.js';
import {
  journalToCompactionSummary,
  journalToSessionEntry,
  type JournalIntegrityVerificationResult,
  wrapUnverifiedHistory,
} from '../../journals/journal-utils.js';
import { SessionSearchIndex } from '../search-index.js';
import type { JournalEntry, SessionEntry } from '../../../core/session/types.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import type {
  ChannelCache,
  ChannelIndexEntry,
  SessionIntegrityProvider,
} from '../store-primitives.js';
import { applyJournalState } from './crash-recovery.js';
import { snapshotIndexEntry } from './channel-index.js';
import {
  createFilesystemSessionArchivePort,
  type SessionArchiveHandle,
  type SessionArchivePort,
} from '../../journals/journal/port.js';

const log = createComponentLogger('SessionStore');

function applyTurnTombstonesToSessionEntries(
  entries: readonly SessionEntry[],
  tombstones: ReadonlySet<string>,
): SessionEntry[] {
  if (tombstones.size === 0) return [...entries];

  return entries.filter((entry) => {
    let turnId: string;
    try {
      turnId = resolveSessionEntryTurnContext(entry).turnId;
    } catch {
      // Malformed metadata should not block deterministic replay filtering.
      // Resolver already backfills for missing metadata; parse failures use deterministic seed.
      turnId = backfillLegacyTurnId(`legacy-turn:${entry.channelId}:${entry.id}:${entry.timestamp}:${entry.role}`);
    }
    return !tombstones.has(turnId);
  });
}

export class SessionJournalRuntime {
  private integrityProvider: SessionIntegrityProvider | null;
  private archivePort: SessionArchivePort;
  private searchIndexFailureLogged = false;
  private channelIndexFailureLogged = false;
  private quarantineWarningKeysByPath: Map<string, string> = new Map();

  constructor(
    integrityProvider: SessionIntegrityProvider | null,
    archivePort: SessionArchivePort = createFilesystemSessionArchivePort(),
  ) {
    this.integrityProvider = integrityProvider;
    this.archivePort = archivePort;
    if (integrityProvider) {
      log.info('Session integrity mode: enabled (HMAC verification active)');
    } else {
      log.info('Session integrity mode: disabled (no keyring configured, entries load without verification)');
    }
  }

  openArchive(channelId: string, filePath: string): SessionArchiveHandle {
    return this.archivePort.openArchive(channelId, filePath);
  }

  createArchive(
    sessionsDir: string,
    channelId: string,
    seed: { timestamp: number; authorId?: string; authorName?: string },
  ): SessionArchiveHandle {
    return this.archivePort.createArchive(sessionsDir, channelId, seed);
  }

  resolveArchivePath(handle: SessionArchiveHandle): string {
    return this.archivePort.resolveArchivePath(handle);
  }

  verifyAndNormalizeEntry(entry: JournalEntry, previousHmac: string | null): JournalEntry {
    if (!this.integrityProvider) return entry;

    let verification: JournalIntegrityVerificationResult;
    try {
      verification = this.integrityProvider.verify(entry, previousHmac);
    } catch (error) {
      throw new Error(
        `Session integrity verification failed: ${toErrorMessage(error)}`,
      );
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

  warnAboutQuarantinedEntries(
    channelId: string,
    archive: SessionArchiveHandle,
    quarantinedCount: number,
    loadedCount: number,
  ): void {
    const warningKey = `${quarantinedCount}:${loadedCount}`;
    const filePath = this.archivePort.resolveArchivePath(archive);
    if (this.quarantineWarningKeysByPath.get(filePath) === warningKey) return;
    this.quarantineWarningKeysByPath.set(filePath, warningKey);

    log.warn(
      `Channel ${channelId}: ${quarantinedCount} quarantined entries, ${loadedCount} entries loaded successfully`,
      {
        path: filePath,
        quarantinePath: this.archivePort.quarantineSidecarPath(archive),
      },
    );
  }

  loadChannel(archive: SessionArchiveHandle): ChannelCache {
    const filePath = this.archivePort.resolveArchivePath(archive);
    const cache: ChannelCache = {
      channelId: archive.channelId,
      entries: [],
      compactions: [],
      turnTombstones: new Set(),
      activeTurnTombstoneCount: 0,
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

    const { entries, maxId, quarantined } = this.archivePort.readJournalFile(archive);
    if (quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(archive.channelId, archive, quarantined.length, entries.length);
    }

    let previousHmac: string | null = null;
    for (const rawEntry of entries) {
      const entry = this.verifyAndNormalizeEntry(rawEntry, previousHmac);
      previousHmac = typeof rawEntry._hmac === 'string' ? rawEntry._hmac : previousHmac;
      applyJournalState(cache, entry);

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
    if (cache.turnTombstones.size > 0) {
      cache.entries = applyTurnTombstonesToSessionEntries(cache.entries, cache.turnTombstones);
      cache.messageCount = cache.entries.length;
    }
    cache.activeTurnTombstoneCount = cache.turnTombstones.size;
    return cache;
  }

  backfillSearchIndexFromDisk(params: {
    searchIndex: SessionSearchIndex | null;
    channelIndex: Map<string, ChannelIndexEntry>;
    sessionsDir: string;
  }): void {
    if (!params.searchIndex) return;

    for (const [channelId, indexEntry] of params.channelIndex.entries()) {
      const expectedCount = typeof indexEntry.messageCount === 'number' ? indexEntry.messageCount : 0;
      const indexedCount = params.searchIndex.countIndexedMessages(channelId);
      if (expectedCount <= 0) {
        if (indexedCount > 0) {
          params.searchIndex.replaceChannelEntries(channelId, []);
        }
        continue;
      }
      if (indexedCount === expectedCount) continue;

      const filePath = join(params.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;

      try {
        const loaded = this.loadChannel(this.openArchive(channelId, filePath));
        params.searchIndex.replaceChannelEntries(channelId, loaded.entries);
      } catch (error) {
        if (!this.searchIndexFailureLogged) {
          this.searchIndexFailureLogged = true;
          log.warn('Session search index backfill failed; continuing without interruption', {
            channelId,
            error: toErrorMessage(error),
          });
        }
      }
    }
  }

  indexSessionEntry(entry: SessionEntry, searchIndex: SessionSearchIndex | null): void {
    if (!searchIndex) return;

    try {
      searchIndex.upsertSessionEntry(entry);
    } catch (error) {
      if (!this.searchIndexFailureLogged) {
        this.searchIndexFailureLogged = true;
        log.warn('Session search index write failed; continuing without interruption', {
          channelId: entry.channelId,
          messageId: entry.id,
          error: toErrorMessage(error),
        });
      }
    }
  }

  writeJournalEntry(params: {
    cache: ChannelCache;
    archive: SessionArchiveHandle;
    journal: JournalEntry;
    upsertChannelIndex: (channelId: string, entry: ChannelIndexEntry) => void;
  }): void {
    const previousHmac = params.cache.lastHmac;
    let signed = params.journal;
    let nextHmac = previousHmac;
    if (this.integrityProvider) {
      try {
        signed = this.integrityProvider.sign(signed, previousHmac);
        nextHmac = signed._hmac ?? previousHmac;
      } catch (error) {
        throw new Error(
          `Session integrity signing failed: ${toErrorMessage(error)}`,
        );
      }
    }

    this.archivePort.appendJournalEntry(params.archive, signed);
    applyJournalState(params.cache, signed);
    params.cache.lastHmac = nextHmac;
    try {
      params.upsertChannelIndex(params.journal.channelId, snapshotIndexEntry(params.cache));
    } catch (error) {
      if (!this.channelIndexFailureLogged) {
        this.channelIndexFailureLogged = true;
        log.warn('Session channel index write failed after journal append; continuing without interruption', {
          channelId: params.journal.channelId,
          error: toErrorMessage(error),
        });
      }
    }
  }

  readRecentEntriesFromTail(archive: SessionArchiveHandle, limit: number): SessionEntry[] {
    const tail = this.archivePort.readJournalTailEntries(archive, {
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
      previousHmac = typeof boundaryEntry._hmac === 'string' ? boundaryEntry._hmac : null;
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
}
