import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../logger.js';
import { toErrorMessage } from '../../utils/errors.js';
import {
  appendJournalEntry,
  journalToCompactionSummary,
  journalToSessionEntry,
  quarantineSidecarPath,
  readJournalFile,
  readJournalTailEntries,
  type JournalIntegrityVerificationResult,
  wrapUnverifiedHistory,
} from '../journal-utils.js';
import { SessionSearchIndex } from '../search-index.js';
import type { JournalEntry, SessionEntry } from '../types.js';
import type {
  ChannelCache,
  ChannelIndexEntry,
  SessionIntegrityProvider,
} from '../store-primitives.js';
import { applyJournalState } from './crash-recovery.js';
import { snapshotIndexEntry } from './channel-index.js';

const log = createComponentLogger('SessionStore');

export class SessionJournalRuntime {
  private integrityProvider: SessionIntegrityProvider | null;
  private searchIndexFailureLogged = false;
  private channelIndexFailureLogged = false;
  private quarantineWarningKeysByPath: Map<string, string> = new Map();

  constructor(integrityProvider: SessionIntegrityProvider | null) {
    this.integrityProvider = integrityProvider;
    if (integrityProvider) {
      log.info('Session integrity mode: enabled (HMAC verification active)');
    } else {
      log.info('Session integrity mode: disabled (no keyring configured, entries load without verification)');
    }
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

  loadChannelFromPath(channelId: string, filePath: string): ChannelCache {
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
      if (expectedCount <= 0) continue;

      const indexedCount = params.searchIndex.countIndexedMessages(channelId);
      if (indexedCount >= expectedCount) continue;

      const filePath = join(params.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;

      try {
        const { entries } = readJournalFile(filePath);
        let previousHmac: string | null = null;
        for (const rawEntry of entries) {
          const entry = this.verifyAndNormalizeEntry(rawEntry, previousHmac);
          previousHmac = typeof rawEntry._hmac === 'string' ? rawEntry._hmac : previousHmac;
          const message = journalToSessionEntry(entry);
          if (!message) continue;
          params.searchIndex.upsertSessionEntry(message);
        }
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

    appendJournalEntry(params.cache.resolvedPath, signed);
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

  readRecentEntriesFromTail(channelId: string, filePath: string, limit: number): SessionEntry[] {
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
