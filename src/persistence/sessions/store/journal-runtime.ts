import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { backfillLegacyTurnId } from '../../../core/turns/id.js';
import {
  journalToCompactionSummary,
  journalToSessionEntry,
  type JournalIntegrityVerificationResult,
  resolveJournalIntegrityChainCandidates,
  wrapUnverifiedHistory,
} from '../../journals/journal-utils.js';
import type { JournalEntry, SessionEntry } from '../../../core/session/types.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import type { TranscriptProjectionPort } from '../transcript-projection-port.js';
import type {
  ChannelCache,
  ChannelIndexEntry,
  SessionIntegrityProvider,
} from '../store-primitives.js';
import { applyJournalState } from './crash-recovery.js';
import { snapshotIndexEntry } from './channel-index.js';
import {
  createFilesystemSessionArchivePort,
  type JournalFileMetadata,
  type SessionArchiveHandle,
  type SessionArchivePort,
} from '../../journals/journal/port.js';

const log = createComponentLogger('SessionStore');

function appendUniqueHmacCandidate(
  target: Array<string | null>,
  candidate: string | null | undefined,
): void {
  if (candidate === undefined) return;
  if (target.some(existing => existing === candidate)) return;
  target.push(candidate);
}

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
  private transcriptProjectionFailureLogged = false;
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

  scanArchiveMetadata(archive: SessionArchiveHandle): JournalFileMetadata {
    return this.archivePort.scanJournalFileMetadata(archive);
  }

  fingerprintArchive(archive: SessionArchiveHandle): string | null {
    return this.archivePort.fingerprintArchive(archive);
  }

  verifyAndNormalizeEntry(
    entry: JournalEntry,
    previousHmacCandidates: readonly (string | null)[],
  ): {
    entry: JournalEntry;
    nextHmacCandidates: Array<string | null>;
    verified: boolean;
  } {
    if (!this.integrityProvider) {
      return {
        entry,
        nextHmacCandidates: typeof entry._hmac === 'string'
          ? [entry._hmac]
          : [...previousHmacCandidates],
        verified: true,
      };
    }

    const candidateList = previousHmacCandidates.length > 0 ? previousHmacCandidates : [null];
    const verificationResults: JournalIntegrityVerificationResult[] = [];

    for (const previousHmac of candidateList) {
      let verification: JournalIntegrityVerificationResult;
      try {
        verification = this.integrityProvider.verify(entry, previousHmac);
      } catch (error) {
        throw new Error(
          `Session integrity verification failed: ${toErrorMessage(error)}`,
        );
      }

      verificationResults.push(verification);
      if (verification.verified) {
        return {
          entry,
          nextHmacCandidates: resolveJournalIntegrityChainCandidates(verification, previousHmac),
          verified: true,
        };
      }
    }

    const fallbackVerification = verificationResults[0] ?? {
      verified: false,
      observedHmac: typeof entry._hmac === 'string' ? entry._hmac : null,
      reason: 'missing_signature',
    } satisfies JournalIntegrityVerificationResult;
    const nextHmacCandidates: Array<string | null> = [];
    for (let index = 0; index < verificationResults.length; index++) {
      const previousHmac = candidateList[index] ?? null;
      for (const candidate of resolveJournalIntegrityChainCandidates(verificationResults[index], previousHmac)) {
        appendUniqueHmacCandidate(nextHmacCandidates, candidate);
      }
    }

    if (entry.type === 'message' && typeof entry.content === 'string') {
      return {
        entry: {
          ...entry,
          content: wrapUnverifiedHistory(entry.content, fallbackVerification.reason),
        },
        nextHmacCandidates,
        verified: false,
      };
    }

    if (entry.type === 'compaction' && typeof entry.summary === 'string') {
      return {
        entry: {
          ...entry,
          summary: wrapUnverifiedHistory(entry.summary, fallbackVerification.reason),
        },
        nextHmacCandidates,
        verified: false,
      };
    }

    return {
      entry,
      nextHmacCandidates,
      verified: false,
    };
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
      lastMessageTimestamp: 0,
      lastMessageRole: null,
      lastMessageAuthorName: undefined,
      lastMessagePreview: '',
      fullyLoaded: true,
      recentEntriesByLimit: new Map(),
    };

    if (!existsSync(filePath)) return cache;

    const { entries, maxId, quarantined } = this.archivePort.readJournalFile(archive);
    if (quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(archive.channelId, archive, quarantined.length, entries.length);
    }

    let previousHmacCandidates: Array<string | null> = [null];
    for (const rawEntry of entries) {
      const normalized = this.verifyAndNormalizeEntry(rawEntry, previousHmacCandidates);
      previousHmacCandidates = normalized.nextHmacCandidates;
      applyJournalState(cache, normalized.entry);

      const message = journalToSessionEntry(normalized.entry);
      if (message) {
        cache.entries.push(message);
        cache.messageCount += 1;
        continue;
      }

      const compaction = journalToCompactionSummary(normalized.entry);
      if (compaction) {
        cache.compactions.push(compaction);
      }
    }

    cache.nextId = maxId + 1;
    cache.lastHmac = previousHmacCandidates[0] ?? null;
    if (cache.turnTombstones.size > 0) {
      cache.entries = applyTurnTombstonesToSessionEntries(cache.entries, cache.turnTombstones);
      cache.messageCount = cache.entries.length;
    }
    const lastMessage = cache.entries.at(-1);
    if (lastMessage) {
      cache.lastMessageTimestamp = lastMessage.timestamp;
      cache.lastMessageRole = lastMessage.role;
      cache.lastMessageAuthorName = lastMessage.authorName;
      const normalizedPreview = lastMessage.content.replace(/\s+/g, ' ').trim();
      cache.lastMessagePreview = normalizedPreview.length > 120
        ? `${normalizedPreview.slice(0, 117)}...`
        : normalizedPreview;
    } else {
      cache.lastMessageTimestamp = 0;
      cache.lastMessageRole = null;
      cache.lastMessageAuthorName = undefined;
      cache.lastMessagePreview = '';
    }
    cache.activeTurnTombstoneCount = cache.turnTombstones.size;
    return cache;
  }

  backfillTranscriptProjectionFromDisk(params: {
    transcriptProjection: TranscriptProjectionPort | null;
    channelIndex: Map<string, ChannelIndexEntry>;
    sessionsDir: string;
  }): void {
    if (!params.transcriptProjection) return;

    for (const [channelId, indexEntry] of params.channelIndex.entries()) {
      const expectedCount = typeof indexEntry.messageCount === 'number' ? indexEntry.messageCount : 0;
      const projectedCount = params.transcriptProjection.countProjectedMessages(channelId);
      if (expectedCount <= 0) {
        if (projectedCount > 0) {
          params.transcriptProjection.replaceChannelEntries(channelId, []);
        }
        continue;
      }
      if (projectedCount === expectedCount) continue;

      const filePath = join(params.sessionsDir, indexEntry.filename);
      if (!existsSync(filePath)) continue;

      try {
        const loaded = this.loadChannel(this.openArchive(channelId, filePath));
        params.transcriptProjection.replaceChannelEntries(channelId, loaded.entries);
      } catch (error) {
        params.transcriptProjection.markProjectionDrift(channelId, toErrorMessage(error));
        if (!this.transcriptProjectionFailureLogged) {
          this.transcriptProjectionFailureLogged = true;
          log.warn('Transcript projection backfill failed; canonical archive remains authoritative', {
            channelId,
            error: toErrorMessage(error),
          });
        }
      }
    }
  }

  indexSessionEntry(entry: SessionEntry, transcriptProjection: TranscriptProjectionPort | null): void {
    if (!transcriptProjection) return;

    try {
      transcriptProjection.upsertSessionEntry(entry);
    } catch (error) {
      transcriptProjection.markProjectionDrift(entry.channelId, toErrorMessage(error));
      if (!this.transcriptProjectionFailureLogged) {
        this.transcriptProjectionFailureLogged = true;
        log.warn('Transcript projection write failed; canonical archive append remains authoritative', {
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
    let previousHmacCandidates: Array<string | null> = [null];
    if (oldestMessageIndex > 0) {
      const boundaryEntry = tail.entries[oldestMessageIndex - 1];
      previousHmacCandidates = typeof boundaryEntry._hmac === 'string'
        ? [boundaryEntry._hmac]
        : [null];
    }

    const messages: SessionEntry[] = [];
    let verificationFailed = false;
    for (let index = oldestMessageIndex; index < tail.entries.length; index++) {
      const rawEntry = tail.entries[index];
      const normalized = this.verifyAndNormalizeEntry(rawEntry, previousHmacCandidates);
      previousHmacCandidates = normalized.nextHmacCandidates;
      verificationFailed = verificationFailed || !normalized.verified;

      const message = journalToSessionEntry(normalized.entry);
      if (message) {
        messages.push(message);
      }
    }

    if (verificationFailed && oldestMessageIndex > 0) {
      const loaded = this.loadChannel(archive);
      if (loaded.entries.length <= limit) return [...loaded.entries];
      return loaded.entries.slice(-limit);
    }

    if (messages.length <= limit) return messages;
    return messages.slice(-limit);
  }
}
