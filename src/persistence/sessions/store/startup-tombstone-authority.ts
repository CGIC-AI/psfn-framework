import type { JournalEntry } from '../../../core/session/types.js';
import { journalToTurnTombstoneEntry } from '../../journals/journal/entries.js';
import type { SessionArchiveHandle } from '../../journals/journal/port.js';
import { readTurnTombstoneAuthoritySnapshot } from '../turn-tombstone-authority.js';

/**
 * Startup L0 turn-tombstone authority priming, moved off the primary event loop
 * (psfn-framework-5jx2v).
 *
 * SessionStore construction used to fingerprint every archive, parse every L0
 * byte through `scanArchiveMetadata`, and run a full backward matching scan for
 * every session with tombstone or quarantine evidence — all synchronously, so a
 * large owner journal made the agent or gateway unresponsive before any bounded
 * background recovery could start.
 *
 * The construction path now records candidates only. Canonical verification
 * runs here, through the same forked worker the recovery path uses, so no
 * message body is ever parsed on the primary heap. Every failure mode skips its
 * owner without caching anything: an unprimed owner is recomputed fail-closed on
 * first demand, so the unsigned channel index can never authorize unredaction by
 * omission.
 */
export interface StartupTombstoneAuthorityCandidate {
  sessionId: string;
  channelId: string;
  filePaths: readonly string[];
  /** Conservative baseline from the unsigned index: it may over-hide, never reveal. */
  baselineTurnTombstoneIds: readonly string[];
}

interface StartupTombstoneAuthorityScanLimits {
  maxActionBytes: number;
  maxActions: number;
  maxResultBytes: number;
  maxRowBytes: number;
  maxTombstones: number;
  scanChunkBytes: number;
}

interface StartupTombstoneAuthorityContext {
  openArchive(channelId: string, filePath: string): SessionArchiveHandle;
  fingerprintArchiveChain(archives: readonly SessionArchiveHandle[]): string | null;
  verifyAndNormalizeEntry(
    entry: JournalEntry,
    previousHmacCandidates: readonly (string | null)[],
  ): { entry: JournalEntry; verified: boolean };
}

export interface StartupTombstoneAuthorityPrimeOptions {
  candidates: readonly StartupTombstoneAuthorityCandidate[];
  context: StartupTombstoneAuthorityContext;
  limits: StartupTombstoneAuthorityScanLimits;
  /** True when the owner is already cached at this exact archive generation. */
  isCurrent(sessionId: string, archiveFingerprint: string): boolean;
  remember(sessionId: string, archiveFingerprint: string, tombstones: Set<string>): void;
  /** Invoked after every owner so callers can prove startup work still advances. */
  onOwnerSettled?: (sessionId: string) => void | Promise<void>;
  signal?: AbortSignal;
}

export interface StartupTombstoneAuthorityPrimeReport {
  considered: number;
  primed: number;
  alreadyCurrent: number;
  /** Owners deliberately left unprimed; each is recomputed fail-closed on demand. */
  deferred: Array<{ sessionId: string; reason: string }>;
  bytesReadOffPrimary: number;
}

export async function primeTurnTombstoneAuthorityOffPrimary(
  options: StartupTombstoneAuthorityPrimeOptions,
): Promise<StartupTombstoneAuthorityPrimeReport> {
  const report: StartupTombstoneAuthorityPrimeReport = {
    considered: 0,
    primed: 0,
    alreadyCurrent: 0,
    deferred: [],
    bytesReadOffPrimary: 0,
  };

  for (const candidate of options.candidates) {
    if (options.signal?.aborted) {
      report.deferred.push({ sessionId: candidate.sessionId, reason: 'aborted' });
      continue;
    }
    report.considered += 1;
    try {
      await primeOwner(candidate, options, report);
    } catch (error) {
      // Never cache a partial or unverifiable authority: leaving the owner
      // unprimed is the fail-closed outcome, because the lazy resolver rebuilds
      // it from the journal instead of trusting the unsigned index.
      report.deferred.push({
        sessionId: candidate.sessionId,
        reason: (error as NodeJS.ErrnoException).code ?? String(error),
      });
    }
    await options.onOwnerSettled?.(candidate.sessionId);
  }

  return report;
}

async function primeOwner(
  candidate: StartupTombstoneAuthorityCandidate,
  options: StartupTombstoneAuthorityPrimeOptions,
  report: StartupTombstoneAuthorityPrimeReport,
): Promise<void> {
  const archives = candidate.filePaths.map(filePath => (
    options.context.openArchive(candidate.channelId, filePath)
  ));
  const beforeFingerprint = options.context.fingerprintArchiveChain(archives);
  if (!beforeFingerprint) {
    report.deferred.push({ sessionId: candidate.sessionId, reason: 'ENOENT' });
    return;
  }
  if (options.isCurrent(candidate.sessionId, beforeFingerprint)) {
    report.alreadyCurrent += 1;
    return;
  }

  const snapshot = await readTurnTombstoneAuthoritySnapshot({
    channelId: candidate.channelId,
    filePaths: candidate.filePaths,
    maxActionBytes: options.limits.maxActionBytes,
    maxActions: options.limits.maxActions,
    maxResultBytes: options.limits.maxResultBytes,
    maxRowBytes: options.limits.maxRowBytes,
    scanChunkBytes: options.limits.scanChunkBytes,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  report.bytesReadOffPrimary += snapshot.stats.bytesRead;

  // A concurrent append or rewrite invalidates the snapshot's authority.
  const afterFingerprint = options.context.fingerprintArchiveChain(archives);
  if (afterFingerprint !== beforeFingerprint) {
    report.deferred.push({ sessionId: candidate.sessionId, reason: 'ESTALE' });
    return;
  }

  const tombstones = new Set(candidate.baselineTurnTombstoneIds);
  for (const action of snapshot.actions) {
    const normalized = options.context.verifyAndNormalizeEntry(action.entry, [action.previousHmac]);
    const tombstone = journalToTurnTombstoneEntry(normalized.entry);
    if (!tombstone) {
      report.deferred.push({ sessionId: candidate.sessionId, reason: 'EBADMSG' });
      return;
    }
    // An unverified action may over-hide, but must never reveal.
    if (tombstone.action === 'redact' || !normalized.verified) {
      tombstones.add(tombstone.targetId);
    } else {
      tombstones.delete(tombstone.targetId);
    }
    if (tombstones.size > options.limits.maxTombstones) {
      report.deferred.push({ sessionId: candidate.sessionId, reason: 'EOVERFLOW' });
      return;
    }
  }

  options.remember(candidate.sessionId, beforeFingerprint, tombstones);
  report.primed += 1;
}
