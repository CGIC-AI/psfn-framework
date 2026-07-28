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
import type { SessionIntegrityFailureEvent } from '../../../shared/contracts/session-integrity.js';
import {
  findLastPreviewableEntry,
  type ChannelCache,
  type SessionIntegrityProvider,
} from '../store-primitives.js';
import { applyJournalState } from './crash-recovery.js';

interface NormalizedJournalEntry {
  entry: JournalEntry;
  nextHmacCandidates: Array<string | null>;
  verified: boolean;
  // True only when this entry actually rendered an unverified_history wrapper
  // (message/compaction). A failed but non-rendered entry (tombstone/marker,
  // non-string content) reports false so it does not consume the contiguous
  // run's single full notice (bead g59z).
  renderedUnverifiedNotice: boolean;
}

interface JournalChainContext {
  archivePort: SessionArchivePort;
  normalizeEntry: (
    entry: JournalEntry,
    previousHmacCandidates: readonly (string | null)[],
    // True when the current contiguous HMAC-failed run has already rendered its
    // full unverified_history notice, so this entry renders only the
    // continuation tag, not the full boilerplate again (bead g59z).
    previousEntryUnverified?: boolean,
  ) => NormalizedJournalEntry;
  warnAboutQuarantinedEntries: (
    channelId: string,
    archive: SessionArchiveHandle,
    quarantinedCount: number,
    loadedCount: number,
  ) => void;
  /**
   * Optional durable-incident seam (bead g59z). Called once per full journal
   * load when one or more entries fail HMAC verification. Content-free; the
   * full-load path is the funnel because bounded readers replay through it on
   * verification failure. Absent in tests/paths with no observer wired.
   */
  recordIntegrityFailure?: (event: SessionIntegrityFailureEvent) => void;
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
    compactionArchivePaths: new Set(),
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
  // Tracks whether the current contiguous HMAC-failed run (which may span
  // archive boundaries) has already rendered its one full notice, so the
  // boilerplate renders once — and only once a rendered failed entry has been
  // seen, so a run beginning with a non-rendered failed entry still shows the
  // full notice on its first rendered message (bead g59z).
  let runNoticeRendered = false;
  let maxId = 0;
  // Structural, content-free accumulation of HMAC-failed entries for the
  // durable-incident seam (bead g59z). A "run" is a contiguous stretch of
  // verification failures, mirroring the render-side run-collapse semantics.
  let failedEntryCount = 0;
  let firstFailedEntryId = 0;
  let lastFailedEntryId = 0;
  let contiguousRunCount = 0;
  let previousEntryFailed = false;
  for (const archive of archives) {
    const result = context.archivePort.readJournalFile(archive);
    let archiveContainsCompaction = false;
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
      const normalized = context.normalizeEntry(rawEntry, previousHmacCandidates, runNoticeRendered);
      previousHmacCandidates = normalized.nextHmacCandidates;
      runNoticeRendered = normalized.verified
        ? false
        : runNoticeRendered || normalized.renderedUnverifiedNotice;
      if (!normalized.verified) {
        failedEntryCount += 1;
        const failedId = normalized.entry.id;
        if (typeof failedId === 'number') {
          if (firstFailedEntryId === 0 || failedId < firstFailedEntryId) firstFailedEntryId = failedId;
          if (failedId > lastFailedEntryId) lastFailedEntryId = failedId;
        }
        if (!previousEntryFailed) contiguousRunCount += 1;
        previousEntryFailed = true;
      } else {
        previousEntryFailed = false;
      }
      applyJournalState(cache, normalized.entry);
      const message = journalToSessionEntry(normalized.entry);
      if (message) {
        cache.entries.push(message);
        cache.messageCount += 1;
      } else {
        const compaction = journalToCompactionSummary(normalized.entry);
        if (compaction) {
          cache.compactions.push(compaction);
          archiveContainsCompaction = true;
        }
      }
    }
    if (archiveContainsCompaction) {
      cache.compactionArchivePaths.add(context.archivePort.resolveArchivePath(archive));
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
  // Preview metadata must reflect the last conversational (user/assistant)
  // message; system/tool scaffold entries never surface in session-list rows.
  const lastMessage = findLastPreviewableEntry(cache.entries);
  if (lastMessage) {
    cache.lastMessageTimestamp = lastMessage.timestamp;
    cache.lastMessageRole = lastMessage.role;
    cache.lastMessageAuthorName = lastMessage.authorName;
    const preview = lastMessage.content.replace(/\s+/g, ' ').trim();
    cache.lastMessagePreview = preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  }
  cache.activeTurnTombstoneCount = cache.turnTombstones.size;

  // Durable-incident seam (bead g59z): one content-free event per stable load
  // that surfaced HMAC failures. Fires only after the fingerprint check has
  // confirmed a non-retried, single-generation read. Best-effort: recording is
  // a side signal, never a gate on the fail-closed read itself.
  if (failedEntryCount > 0 && context.recordIntegrityFailure) {
    const firstId = firstFailedEntryId > 0 ? firstFailedEntryId : 1;
    context.recordIntegrityFailure({
      channelId: cache.channelId,
      failedEntryCount,
      firstFailedEntryId: firstId,
      lastFailedEntryId: lastFailedEntryId >= firstId ? lastFailedEntryId : firstId,
      contiguousRunCount: Math.max(1, contiguousRunCount),
      detectedAtMs: Date.now(),
    });
  }
  return cache;
}

export function loadJournalArchiveChain(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
): ChannelCache {
  return loadJournalArchiveChainAttempt(context, archives, 1);
}

function previousArchiveHmac(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
  archiveIndex: number,
): string | null {
  if (archiveIndex <= 0) return null;
  const tail = context.archivePort.readJournalTailEntries(archives[archiveIndex - 1]!, {
    messageLimit: 1,
    includeBoundaryEntry: false,
  });
  return tail.entries.at(-1)?._hmac ?? null;
}

function readEntriesInRangeFromJournalArchiveChainAttempt(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
  startId: number,
  endId: number,
  tombstones: ReadonlySet<string>,
  retriesRemaining: number,
): SessionEntry[] {
  if (archives.length === 0 || endId < startId) return [];
  const beforeFingerprint = fingerprintJournalArchiveChain(context.archivePort, archives);
  type FirstEntryProbe =
    | { state: 'trusted'; entry: JournalEntry }
    | { state: 'empty' }
    | { state: 'untrusted' };
  const firstEntries = new Map<number, FirstEntryProbe>();

  const probeFirstEntry = (archiveIndex: number): FirstEntryProbe => {
    const cached = firstEntries.get(archiveIndex);
    if (cached) return cached;
    const archive = archives[archiveIndex]!;
    const first = context.archivePort.readJournalFirstEntry(archive);
    if (!first) {
      const probe: FirstEntryProbe = context.archivePort.archiveByteLength(archive) === 0
        ? { state: 'empty' }
        : { state: 'untrusted' };
      firstEntries.set(archiveIndex, probe);
      return probe;
    }
    const normalized = context.normalizeEntry(
      first,
      [previousArchiveHmac(context, archives, archiveIndex)],
    );
    const probe: FirstEntryProbe = normalized.verified
      ? { state: 'trusted', entry: first }
      : { state: 'untrusted' };
    firstEntries.set(archiveIndex, probe);
    return probe;
  };

  let lastNonEmptyIndex = archives.length - 1;
  let segmentSeekTrusted = true;
  while (lastNonEmptyIndex >= 0) {
    const probe = probeFirstEntry(lastNonEmptyIndex);
    if (probe.state === 'untrusted') {
      segmentSeekTrusted = false;
      break;
    }
    if (probe.state === 'trusted') break;
    lastNonEmptyIndex -= 1;
  }
  if (!segmentSeekTrusted) {
    const loaded = loadJournalArchiveChain(context, archives);
    return loaded.entries.filter(entry => entry.id >= startId && entry.id <= endId);
  }
  if (lastNonEmptyIndex < 0) return [];

  let candidateIndex = -1;
  let low = 0;
  let high = lastNonEmptyIndex;
  while (low <= high) {
    const midpoint = low + Math.floor((high - low) / 2);
    const probe = probeFirstEntry(midpoint);
    if (probe.state !== 'trusted') {
      segmentSeekTrusted = false;
      break;
    }
    const first = probe.entry;
    if (first.id <= endId) {
      candidateIndex = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  if (!segmentSeekTrusted) {
    const loaded = loadJournalArchiveChain(context, archives);
    return loaded.entries.filter(entry => entry.id >= startId && entry.id <= endId);
  }
  if (candidateIndex < 0) return [];

  const messageLimit = Math.max(1, endId - startId + 1);
  const messages: SessionEntry[] = [];
  let verificationFailed = false;
  for (let archiveIndex = candidateIndex; archiveIndex >= 0; archiveIndex -= 1) {
    const previousHmac = previousArchiveHmac(context, archives, archiveIndex);
    const archive = archives[archiveIndex]!;
    const window = context.archivePort.readJournalEntriesBefore(archive, {
      beforeId: endId + 1,
      messageLimit,
      includeBoundaryEntry: true,
      previousFileHmac: previousHmac,
      trustSeekEntry: (entry, candidateHmac) => (
        context.normalizeEntry(entry, [candidateHmac]).verified
      ),
    });
    if (window.quarantined.length > 0) {
      context.warnAboutQuarantinedEntries(
        archive.channelId,
        archive,
        window.quarantined.length,
        window.entries.length,
      );
    }

    const messageIndexes = window.entries
      .map((entry, index) => entry.type === 'message' ? index : -1)
      .filter(index => index >= 0);
    if (messageIndexes.length > 0) {
      // `includeBoundaryEntry` may prepend a message solely to establish the
      // HMAC immediately before the requested window. Do not verify that
      // boundary row against the physical-file boundary; start at the oldest
      // requested message and use the prepended row as its chain anchor.
      const oldestMessageIndex = messageIndexes[
        Math.max(0, messageIndexes.length - messageLimit)
      ]!;
      let previousHmacCandidates: Array<string | null> = oldestMessageIndex > 0
        ? [window.entries[oldestMessageIndex - 1]!._hmac ?? null]
        : [previousHmac];
      const segmentMessages: SessionEntry[] = [];
      // Per-segment reset is intentional (archive-boundary behavior left as is);
      // within the segment the full notice renders once, and only after a
      // rendered failed entry has been seen (bead g59z).
      let runNoticeRendered = false;
      for (let index = oldestMessageIndex; index < window.entries.length; index += 1) {
        const normalized = context.normalizeEntry(window.entries[index]!, previousHmacCandidates, runNoticeRendered);
        previousHmacCandidates = normalized.nextHmacCandidates;
        runNoticeRendered = normalized.verified
          ? false
          : runNoticeRendered || normalized.renderedUnverifiedNotice;
        verificationFailed ||= !normalized.verified;
        const message = journalToSessionEntry(normalized.entry);
        if (message && message.id >= startId && message.id <= endId) {
          segmentMessages.push(message);
        }
      }
      messages.unshift(...segmentMessages);
    }

    const first = firstEntries.get(archiveIndex) ?? probeFirstEntry(archiveIndex);
    if (first.state === 'untrusted') {
      verificationFailed = true;
      break;
    }
    if (first.state === 'trusted' && first.entry.id <= startId) break;
  }

  const afterFingerprint = fingerprintJournalArchiveChain(context.archivePort, archives);
  if (beforeFingerprint !== afterFingerprint) {
    if (retriesRemaining > 0) {
      return readEntriesInRangeFromJournalArchiveChainAttempt(
        context,
        archives,
        startId,
        endId,
        tombstones,
        retriesRemaining - 1,
      );
    }
    throw new Error(
      `L0 session ${archives.at(-1)!.channelId} changed repeatedly while reading an id range`,
    );
  }
  if (verificationFailed) {
    const loaded = loadJournalArchiveChain(context, archives);
    return loaded.entries.filter(entry => entry.id >= startId && entry.id <= endId);
  }
  return applyTurnTombstones(messages, tombstones);
}

export function readEntriesInRangeFromJournalArchiveChain(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
  startId: number,
  endId: number,
  tombstones: ReadonlySet<string> = new Set(),
): SessionEntry[] {
  return readEntriesInRangeFromJournalArchiveChainAttempt(
    context,
    archives,
    startId,
    endId,
    tombstones,
    1,
  );
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
  let earliestTailTruncated = true;
  let remainingMessages = limit;
  for (let archiveIndex = archives.length - 1; archiveIndex >= 0; archiveIndex -= 1) {
    const archive = archives[archiveIndex]!;
    const tail = context.archivePort.readJournalTailEntries(archive, {
      messageLimit: remainingMessages,
      includeBoundaryEntry: true,
    });
    const entries = tail.entries;
    if (tail.quarantined.length > 0) {
      context.warnAboutQuarantinedEntries(
        archive.channelId,
        archive,
        tail.quarantined.length,
        entries.length,
      );
    }
    remainingMessages -= entries.filter(entry => entry.type === 'message').length;
    blocks.unshift(entries);
    earliestArchiveIndex = archiveIndex;
    earliestTailTruncated = tail.truncated;
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
    previousHmacCandidates = [context.archivePort.readJournalTailEntries(
      archives[earliestArchiveIndex - 1]!,
      { messageLimit: 1, includeBoundaryEntry: false },
    ).entries.at(-1)?._hmac ?? null];
  }

  const messages: SessionEntry[] = [];
  let verificationFailed = false;
  let runNoticeRendered = false;
  for (let index = oldestMessageIndex; index < rawEntries.length; index += 1) {
    const normalized = context.normalizeEntry(rawEntries[index]!, previousHmacCandidates, runNoticeRendered);
    previousHmacCandidates = normalized.nextHmacCandidates;
    runNoticeRendered = normalized.verified
      ? false
      : runNoticeRendered || normalized.renderedUnverifiedNotice;
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
    // When the bounded scan reached the physical beginning of the logical
    // archive, this is already the canonical verification pass. Replaying the
    // same rows would only duplicate integrity-provider work and cannot add a
    // stronger chain anchor.
    if (earliestArchiveIndex === 0 && !earliestTailTruncated) {
      return messages.length <= limit ? messages : messages.slice(-limit);
    }
    const loaded = loadJournalArchiveChain(context, archives);
    return loaded.entries.length <= limit ? [...loaded.entries] : loaded.entries.slice(-limit);
  }
  return messages.length <= limit ? messages : messages.slice(-limit);
}

export function readRecentEntriesFromJournalArchiveChain(
  context: JournalChainContext,
  archives: readonly SessionArchiveHandle[],
  limit: number,
  tombstones: ReadonlySet<string> = new Set(),
): SessionEntry[] {
  if (tombstones.size === 0) {
    return readRecentEntriesFromJournalArchiveChainAttempt(context, archives, limit, 1);
  }
  let requested = Math.max(limit * 4, limit + tombstones.size * 4);
  for (;;) {
    const messages = readRecentEntriesFromJournalArchiveChainAttempt(context, archives, requested, 1);
    const visible = applyTurnTombstones(messages, tombstones);
    if (visible.length >= limit || messages.length < requested) {
      return visible.length <= limit ? visible : visible.slice(-limit);
    }
    requested = Math.min(Number.MAX_SAFE_INTEGER, requested * 2);
  }
}
