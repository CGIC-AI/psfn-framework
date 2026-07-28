import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createComponentLogger } from '../../../shared/logger.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import { backfillLegacyTurnId } from '../../../core/turns/id.js';
import {
  journalToCompactionSummary,
  journalToSessionEntry,
  journalToTurnTombstoneEntry,
  type JournalIntegrityVerificationResult,
  resolveJournalIntegrityChainCandidates,
  wrapUnverifiedHistory,
} from '../../journals/journal-utils.js';
import type { CompactionSummary, JournalEntry, SessionEntry } from '../../../core/session/types.js';
import { resolveSessionEntryTurnContext } from '../../../core/session/turn-provenance.js';
import { isCogSecTombstoneSessionEntry } from '../../../core/cogsec/tombstones.js';
import type { TranscriptProjectionPort } from '../transcript-projection-port.js';
import type {
  ChannelCache,
  ChannelIndexEntry,
  SessionIntegrityProvider,
} from '../store-primitives.js';
import type {
  SessionIntegrityFailureEvent,
  SessionIntegrityObserver,
} from '../../../shared/contracts/session-integrity.js';
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
      turnId = backfillLegacyTurnId(
        `legacy-turn:${entry.channelId}:${entry.id}:${entry.timestamp}:${entry.role}`,
      );
    }
    return !tombstones.has(turnId);
  });
}

export class SessionJournalRuntime {
  private integrityProvider: SessionIntegrityProvider | null;
  private archivePort: SessionArchivePort;
  private transcriptProjectionFailureLogged = false;
  private quarantineWarningKeysByPath: Map<string, string> = new Map();
  private integrityObserver: SessionIntegrityObserver | null;
  // In-memory per-channel dedup of the integrity-failure signal (bead g59z):
  // a broken session is re-read every context build, so emit to the durable
  // subscriber only when the structural failure signature changes. Mirrors the
  // quarantine-warning dedup above. Durable dedup (one incident per session) is
  // enforced independently by the subscriber.
  private integritySignatureByChannel: Map<string, string> = new Map();

  constructor(
    integrityProvider: SessionIntegrityProvider | null,
    archivePort: SessionArchivePort = createFilesystemSessionArchivePort(),
    integrityObserver: SessionIntegrityObserver | null = null,
  ) {
    this.integrityProvider = integrityProvider;
    this.archivePort = archivePort;
    this.integrityObserver = integrityObserver;
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
    // True when the current contiguous HMAC-failed run has already rendered its
    // full unverified_history notice, so this entry renders only the lightweight
    // continuation tag instead of repeating the 3-line boilerplate (bead g59z).
    // Fail-closed marking is unchanged: every failed entry is still returned
    // verified: false. Only entries that actually render a wrapper
    // (message/compaction) report renderedUnverifiedNotice: true, so a run that
    // begins with a non-rendered failed entry (tombstone/marker, non-string
    // message content) does not consume the run's single full notice.
    previousEntryUnverified = false,
  ): {
    entry: JournalEntry;
    nextHmacCandidates: Array<string | null>;
    verified: boolean;
    renderedUnverifiedNotice: boolean;
  } {
    if (!this.integrityProvider) {
      return {
        entry,
        nextHmacCandidates: typeof entry._hmac === 'string'
          ? [entry._hmac]
          : [...previousHmacCandidates],
        verified: true,
        renderedUnverifiedNotice: false,
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
          renderedUnverifiedNotice: false,
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

    const wrapOptions = { continuation: previousEntryUnverified };
    if (entry.type === 'message' && typeof entry.content === 'string') {
      return {
        entry: {
          ...entry,
          content: wrapUnverifiedHistory(entry.content, fallbackVerification.reason, wrapOptions),
        },
        nextHmacCandidates,
        verified: false,
        renderedUnverifiedNotice: true,
      };
    }

    if (entry.type === 'compaction' && typeof entry.summary === 'string') {
      return {
        entry: {
          ...entry,
          summary: wrapUnverifiedHistory(entry.summary, fallbackVerification.reason, wrapOptions),
        },
        nextHmacCandidates,
        verified: false,
        renderedUnverifiedNotice: true,
      };
    }

    // A failed entry with no rendered wrapper (tombstone/marker, or a message
    // whose content is not a string) is still fail-closed as verified: false but
    // does NOT consume the run's single full notice — the next rendered failed
    // entry must still show the full boilerplate (bead g59z).
    return {
      entry,
      nextHmacCandidates,
      verified: false,
      renderedUnverifiedNotice: false,
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

  private recordIntegrityFailure(event: SessionIntegrityFailureEvent): void {
    if (!this.integrityObserver) return;
    const signature = `${event.failedEntryCount}:${event.firstFailedEntryId}:${event.lastFailedEntryId}:${event.contiguousRunCount}`;
    if (this.integritySignatureByChannel.get(event.channelId) === signature) return;
    this.integritySignatureByChannel.set(event.channelId, signature);
    // The subscriber owns durability; a recording failure must never break the
    // fail-closed read path (which already fenced every failed entry).
    try {
      this.integrityObserver.recordIntegrityFailure(event);
    } catch (error) {
      log.warn('Session integrity incident recording failed; session read is unaffected', {
        channelId: event.channelId,
        error: toErrorMessage(error),
      });
    }
  }

  private chainContext() {
    return {
      archivePort: this.archivePort,
      normalizeEntry: (entry: JournalEntry, candidates: readonly (string | null)[], previousEntryUnverified?: boolean) =>
        this.verifyAndNormalizeEntry(entry, candidates, previousEntryUnverified),
      warnAboutQuarantinedEntries: (
        channelId: string,
        archive: SessionArchiveHandle,
        quarantinedCount: number,
        loadedCount: number,
      ): void => this.warnAboutQuarantinedEntries(channelId, archive, quarantinedCount, loadedCount),
      recordIntegrityFailure: (event: SessionIntegrityFailureEvent): void => this.recordIntegrityFailure(event),
    };
  }

  loadChannel(archive: SessionArchiveHandle): ChannelCache {
    return this.loadChannelChain([archive]);
  }

  loadChannelChain(archives: readonly SessionArchiveHandle[]): ChannelCache {
    return loadJournalArchiveChain(this.chainContext(), archives);
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
    return readRecentEntriesFromJournalArchiveChain(this.chainContext(), archives, limit, tombstones);
  }

  readEntriesInRangeFromChain(
    archives: readonly SessionArchiveHandle[],
    startId: number,
    endId: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    return readEntriesInRangeFromJournalArchiveChain(this.chainContext(), archives, startId, endId, tombstones);
  }

  readTurnTombstoneAuthorityFromChain(
    archives: readonly SessionArchiveHandle[],
    conservativeBaseline: ReadonlySet<string> = new Set(),
  ): { archiveFingerprint: string; tombstones: Set<string> } | null {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const beforeFingerprint = this.fingerprintArchiveChain(archives);
      if (!beforeFingerprint) return null;
      const actions: Array<{
        id: number;
        archiveIndex: number;
        targetId: string;
        action: 'redact' | 'restore';
        verified: boolean;
      }> = [];
      let scanTrusted = true;

      for (let archiveIndex = 0; archiveIndex < archives.length; archiveIndex += 1) {
        const archive = archives[archiveIndex]!;
        const previousArchiveHmac = archiveIndex > 0
          ? this.archivePort.readJournalTailEntries(archives[archiveIndex - 1]!, {
            messageLimit: 1,
            includeBoundaryEntry: false,
          }).entries.at(-1)?._hmac ?? null
          : null;
        const result = this.archivePort.readJournalMatchingEntriesBackward(archive, {
          limit: Number.MAX_SAFE_INTEGER,
          matches: entry => journalToTurnTombstoneEntry(entry) !== null,
        });
        if (result.quarantined.length > 0) {
          this.warnAboutQuarantinedEntries(
            archive.channelId,
            archive,
            result.quarantined.length,
            result.matches.length,
          );
          scanTrusted = false;
          break;
        }
        for (const match of result.matches) {
          const previousHmacCandidates = [match.previousHmac];
          if (match.previousHmac === null && previousArchiveHmac !== null) {
            previousHmacCandidates.push(previousArchiveHmac);
          }
          const normalized = this.verifyAndNormalizeEntry(match.entry, previousHmacCandidates);
          const tombstone = journalToTurnTombstoneEntry(normalized.entry);
          if (!tombstone) continue;
          actions.push({
            id: tombstone.id,
            archiveIndex,
            targetId: tombstone.targetId,
            action: tombstone.action,
            verified: normalized.verified,
          });
        }
      }

      const afterFingerprint = this.fingerprintArchiveChain(archives);
      if (beforeFingerprint !== afterFingerprint) {
        if (attempt === 0) continue;
        throw new Error(
          `L0 session ${archives.at(-1)?.channelId ?? 'unknown'} changed repeatedly while reading tombstone authority`,
        );
      }
      if (!scanTrusted || !afterFingerprint) return null;

      const tombstones = new Set(conservativeBaseline);
      actions.sort((left, right) => left.id - right.id || left.archiveIndex - right.archiveIndex);
      for (const action of actions) {
        if (action.action === 'redact') {
          // An invalid redaction may over-hide data, but must never reveal it.
          tombstones.add(action.targetId);
        } else if (action.verified) {
          // Only an authenticated restore may remove privacy authority.
          tombstones.delete(action.targetId);
        }
      }
      return { archiveFingerprint: afterFingerprint, tombstones };
    }
    return null;
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

  findLatestEntries(
    archive: SessionArchiveHandle,
    predicate: (entry: SessionEntry) => boolean,
    limit: number,
  ): SessionEntry[] | null {
    const result = this.archivePort.readJournalMatchingEntriesBackward(archive, {
      limit,
      matches: (entry) => {
        const message = journalToSessionEntry(entry);
        return message !== null && predicate(message);
      },
    });
    if (result.quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(archive.channelId, archive, result.quarantined.length, result.matches.length);
    }
    const found: SessionEntry[] = [];
    for (const match of result.matches) {
      const normalized = this.verifyAndNormalizeEntry(match.entry, [match.previousHmac]);
      if (!normalized.verified) return null;
      const message = journalToSessionEntry(normalized.entry);
      if (message && predicate(message)) found.push(message);
    }
    return found;
  }

  findEntriesInRange(
    archive: SessionArchiveHandle,
    startId: number,
    endId: number,
  ): SessionEntry[] | null {
    const limit = Math.max(0, endId - startId + 1);
    if (limit <= 0) return [];
    const result = this.archivePort.readJournalMatchingEntriesBackward(archive, {
      limit,
      stopAfter: entry => entry.id < startId,
      matches: (entry) => {
        const message = journalToSessionEntry(entry);
        return message !== null && message.id >= startId && message.id <= endId;
      },
    });
    if (result.quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(
        archive.channelId,
        archive,
        result.quarantined.length,
        result.matches.length,
      );
    }
    const found: SessionEntry[] = [];
    for (const match of result.matches) {
      const normalized = this.verifyAndNormalizeEntry(match.entry, [match.previousHmac]);
      if (!normalized.verified) return null;
      const message = journalToSessionEntry(normalized.entry);
      if (message && message.id >= startId && message.id <= endId) found.push(message);
    }
    return found.sort((left, right) => left.id - right.id);
  }

  readEntriesBefore(
    archive: SessionArchiveHandle,
    beforeId: number,
    limit: number,
    tombstones: ReadonlySet<string> = new Set(),
  ): SessionEntry[] {
    const boundedMessageLimit = tombstones.size > 0
      ? Math.max(limit * 4, limit + tombstones.size * 4)
      : limit;
    const window = this.archivePort.readJournalEntriesBefore(archive, {
      beforeId,
      messageLimit: boundedMessageLimit,
      includeBoundaryEntry: true,
      ...(this.integrityProvider
        ? {
          trustSeekEntry: (entry: JournalEntry, previousHmac: string | null): boolean => (
            this.integrityProvider?.verify(entry, previousHmac).verified === true
          ),
        }
        : {}),
    });
    if (window.quarantined.length > 0) {
      this.warnAboutQuarantinedEntries(
        archive.channelId,
        archive,
        window.quarantined.length,
        window.entries.length,
      );
    }
    if (window.entries.length === 0) return [];

    const messageIndexes: number[] = [];
    for (let index = 0; index < window.entries.length; index += 1) {
      if (window.entries[index].type === 'message') messageIndexes.push(index);
    }
    if (messageIndexes.length === 0) return [];

    const oldestMessageIndex = messageIndexes[Math.max(0, messageIndexes.length - boundedMessageLimit)];
    let previousHmacCandidates: Array<string | null> = [null];
    if (oldestMessageIndex > 0) {
      const boundaryEntry = window.entries[oldestMessageIndex - 1];
      previousHmacCandidates = typeof boundaryEntry._hmac === 'string'
        ? [boundaryEntry._hmac]
        : [null];
    }

    const messages: SessionEntry[] = [];
    let verificationFailed = false;
    for (let index = oldestMessageIndex; index < window.entries.length; index += 1) {
      const rawEntry = window.entries[index];
      const normalized = this.verifyAndNormalizeEntry(rawEntry, previousHmacCandidates);
      previousHmacCandidates = normalized.nextHmacCandidates;
      verificationFailed = verificationFailed || !normalized.verified;
      const message = journalToSessionEntry(normalized.entry);
      if (message) messages.push(message);
    }

    // A boundary-backed partial chain cannot safely distinguish a tampered
    // boundary/window from a key transition. Replay the canonical archive so
    // integrity normalization remains byte-identical to full history reads —
    // and replay even when the window already started at the archive beginning,
    // because the full-load path is the durable-incident funnel: returning
    // detected-failed rows without it would skip recordIntegrityFailure
    // (bead g59z).
    if (verificationFailed) {
      const loaded = this.loadChannel(archive);
      const eligible = loaded.entries.filter(entry => entry.id < beforeId);
      return eligible.length <= limit ? eligible : eligible.slice(-limit);
    }

    const visibleMessages = applyTurnTombstonesToSessionEntries(messages, tombstones);
    return visibleMessages.length <= limit ? visibleMessages : visibleMessages.slice(-limit);
  }
}
