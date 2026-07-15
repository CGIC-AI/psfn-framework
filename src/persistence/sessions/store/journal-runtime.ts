import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  journalToCompactionSummary,
  type JournalIntegrityVerificationResult,
  resolveJournalIntegrityChainCandidates,
  wrapUnverifiedHistory,
} from '../../journals/journal-utils.js';
import type { CompactionSummary, JournalEntry, SessionEntry } from '../../../core/session/types.js';
import { isCogSecTombstoneSessionEntry } from '../../../core/cogsec/tombstones.js';
import type { TranscriptProjectionPort } from '../transcript-projection-port.js';
import type {
  ChannelCache,
  SessionIntegrityProvider,
} from '../store-primitives.js';
import { applyJournalState } from './crash-recovery.js';
import {
  fingerprintJournalArchiveChain,
  loadJournalArchiveChain,
  readEntriesInRangeFromJournalArchiveChain,
  readRecentEntriesFromJournalArchiveChain,
  rewriteJournalArchiveChain,
} from './journal-chain-runtime.js';
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

export class SessionJournalRuntime {
  private integrityProvider: SessionIntegrityProvider | null;
  private archivePort: SessionArchivePort;
  private transcriptProjectionFailureLogged = false;
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

  archiveByteLength(archive: SessionArchiveHandle): number {
    return this.archivePort.archiveByteLength(archive);
  }

  fingerprintArchiveChain(archives: readonly SessionArchiveHandle[]): string | null {
    return fingerprintJournalArchiveChain(this.archivePort, archives);
  }

  listPendingJournalChainRewriteRoots(sessionsDir: string): string[] {
    return this.archivePort.listPendingJournalChainRewriteRoots(sessionsDir);
  }

  recoverJournalChainRewrite(rootPath: string): void {
    this.archivePort.recoverJournalChainRewrite(rootPath);
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
    return this.loadChannelChain([archive]);
  }

  loadChannelChain(archives: readonly SessionArchiveHandle[]): ChannelCache {
    return loadJournalArchiveChain({
      archivePort: this.archivePort,
      normalizeEntry: (entry, candidates) => this.verifyAndNormalizeEntry(entry, candidates),
      warnAboutQuarantinedEntries: (...args) => this.warnAboutQuarantinedEntries(...args),
    }, archives);
  }

  readJournalEntries(archive: SessionArchiveHandle): JournalEntry[] {
    const { entries, quarantined } = this.archivePort.readJournalFile(archive);
    if (quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(archive.channelId, archive, quarantined.length, entries.length);
    }
    return entries;
  }

  rewriteJournalEntries(archive: SessionArchiveHandle, entries: readonly JournalEntry[]): JournalEntry[] {
    const rewritten: JournalEntry[] = [];
    let previousHmac: string | null = null;
    for (const entry of entries) {
      const { _hmac, _hmacKeyVersion, ...unsigned } = entry;
      if (!this.integrityProvider) {
        rewritten.push(unsigned);
        continue;
      }
      const signed = this.integrityProvider.sign(unsigned, previousHmac);
      rewritten.push(signed);
      previousHmac = signed._hmac ?? previousHmac;
    }
    this.archivePort.writeJournalFile(archive, rewritten);
    return rewritten;
  }

  rewriteJournalEntryChain(
    archives: readonly SessionArchiveHandle[],
    entriesByArchive: readonly (readonly JournalEntry[])[],
    renewLease?: () => void,
  ): JournalEntry[][] {
    return rewriteJournalArchiveChain(
      this.archivePort,
      this.integrityProvider,
      archives,
      entriesByArchive,
      renewLease,
    );
  }

  readJournalEntryChain(archives: readonly SessionArchiveHandle[]): JournalEntry[][] {
    this.archivePort.assertJournalChainReadable(archives);
    return archives.map(archive => this.readJournalEntries(archive));
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

      const filePaths = indexEntry.filenames.map(filename => join(params.sessionsDir, filename));
      if (filePaths.some(filePath => !existsSync(filePath))) {
        params.transcriptProjection.markProjectionDrift(
          channelId,
          'One or more indexed L0 session segments are missing',
        );
        continue;
      }

      try {
        const loaded = this.loadChannelChain(
          filePaths.map(filePath => this.openArchive(indexEntry.channelId ?? channelId, filePath)),
        );
        const expectedProjectedCount = loaded.entries.filter(entry => !isCogSecTombstoneSessionEntry(entry)).length;
        if (projectedCount === expectedProjectedCount) {
          continue;
        }
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
  }): void {
    this.archivePort.assertJournalChainReadable(
      params.cache.archivePaths.map(filePath => this.openArchive(params.cache.channelId, filePath)),
    );
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
    if (signed.type === 'compaction') {
      params.cache.compactionArchivePaths.add(this.archivePort.resolveArchivePath(params.archive));
    }
    params.cache.lastHmac = nextHmac;
  }

  readRecentEntriesFromTail(
    archive: SessionArchiveHandle,
    limit: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    return this.readRecentEntriesFromTailChain([archive], limit, tombstones);
  }

  readRecentEntriesFromTailChain(
    archives: readonly SessionArchiveHandle[],
    limit: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    return readRecentEntriesFromJournalArchiveChain({
      archivePort: this.archivePort,
      normalizeEntry: (entry, candidates) => this.verifyAndNormalizeEntry(entry, candidates),
      warnAboutQuarantinedEntries: (...args) => this.warnAboutQuarantinedEntries(...args),
    }, archives, limit, tombstones);
  }

  readEntriesInRangeFromChain(
    archives: readonly SessionArchiveHandle[],
    startId: number,
    endId: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    return readEntriesInRangeFromJournalArchiveChain({
      archivePort: this.archivePort,
      normalizeEntry: (entry, candidates) => this.verifyAndNormalizeEntry(entry, candidates),
      warnAboutQuarantinedEntries: (...args) => this.warnAboutQuarantinedEntries(...args),
    }, archives, startId, endId, tombstones);
  }

  readCompactionSummariesFromChain(
    archives: readonly SessionArchiveHandle[],
    compactionArchivePaths: ReadonlySet<string>,
  ): CompactionSummary[] {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const beforeFingerprint = this.fingerprintArchiveChain(archives);
      const summaries: CompactionSummary[] = [];
      let verificationFailed = false;
      for (let archiveIndex = 0; archiveIndex < archives.length; archiveIndex += 1) {
        const archive = archives[archiveIndex]!;
        if (!compactionArchivePaths.has(this.archivePort.resolveArchivePath(archive))) continue;
        const result = this.archivePort.readJournalFile(archive);
        if (result.quarantined.length > 0) {
          this.warnAboutQuarantinedEntries(
            archive.channelId,
            archive,
            result.quarantined.length,
            result.entries.length,
          );
        }
        const previousHmac = archiveIndex > 0
          ? this.archivePort.readJournalTailEntries(archives[archiveIndex - 1]!, {
            messageLimit: 1,
            includeBoundaryEntry: false,
          }).entries.at(-1)?._hmac ?? null
          : null;
        let previousHmacCandidates: Array<string | null> = [previousHmac];
        for (const rawEntry of result.entries) {
          const normalized = this.verifyAndNormalizeEntry(rawEntry, previousHmacCandidates);
          previousHmacCandidates = normalized.nextHmacCandidates;
          verificationFailed ||= !normalized.verified;
          const summary = journalToCompactionSummary(normalized.entry);
          if (summary) summaries.push(summary);
        }
      }
      const afterFingerprint = this.fingerprintArchiveChain(archives);
      if (beforeFingerprint !== afterFingerprint) {
        if (attempt === 0) continue;
        throw new Error(
          `L0 session ${archives.at(-1)?.channelId ?? 'unknown'} changed repeatedly while reading compactions`,
        );
      }
      if (verificationFailed) return this.loadChannelChain(archives).compactions;
      return summaries;
    }
    return [];
  }
}
