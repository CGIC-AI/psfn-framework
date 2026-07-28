import { existsSync, statSync } from 'node:fs';
import type { JournalEntry } from '../../../core/session/types.js';
import {
  fileIdentityKey,
  listNumberedJsonlSegments,
  readJsonlLineAtOrAfterAsync,
  readJsonlLineBeforeAsync,
  scanJsonlFileBackward,
} from '../../jsonl-segments.js';
import type {
  JournalBoundedReadStats,
  QuarantinedJournalEntry,
  ReadJournalBeforeOptions,
  ReadJournalBeforeResult,
} from './types.js';

interface AsyncJournalBeforeReadParams {
  filePath: string;
  beforeId: number;
  messageLimit: number;
  includeBoundaryEntry: boolean;
  chunkBytes: number;
  maxSeekLineBytes: number;
  stats: JournalBoundedReadStats | undefined;
  trustSeekEntry: ReadJournalBeforeOptions['trustSeekEntry'];
  previousFileHmac: string | null;
  parseJournalLine: (line: string) => JournalEntry;
  appendQuarantinedLine: (
    target: QuarantinedJournalEntry[],
    line: string,
    error: unknown,
  ) => void;
}

interface ParsedSeekRow {
  entry: JournalEntry;
  startOffset: number;
  endOffset: number;
}

interface SeekSegment {
  path: string;
  size: number;
  identity: string;
}

/**
 * Locate a bounded journal window without retaining or synchronously scanning
 * an unbounded seek row. The final backward page scan remains the established
 * journal-authority path; this module owns only sampled current/predecessor
 * rows used as byte-exclusion authority.
 */
export async function readJournalEntriesBeforeAsyncOnce(
  params: AsyncJournalBeforeReadParams,
): Promise<ReadJournalBeforeResult> {
  const parsedDescending: JournalEntry[] = [];
  const quarantined: QuarantinedJournalEntry[] = [];
  const seekFileIdentities = new Set<string>();
  const scannedFileIdentities = new Set<string>();
  const seekChunkBytes = Math.max(params.chunkBytes, 1024);
  let messageCount = 0;
  let needBoundaryEntry = false;
  let truncated = false;

  const readSeekEntry = async (
    segment: SeekSegment,
    offset: number,
    previousSegment: SeekSegment | undefined,
  ): Promise<ParsedSeekRow | null> => {
    const row = await readJsonlLineAtOrAfterAsync(segment.path, offset, {
      chunkBytes: seekChunkBytes,
      maxLineBytes: params.maxSeekLineBytes,
      stats: params.stats,
      scannedFileIdentities: seekFileIdentities,
      expectedFileIdentity: segment.identity,
    });
    if (!row || row.line.trim().length === 0) return null;

    let entry: JournalEntry;
    try {
      entry = params.parseJournalLine(row.line);
    } catch (error) {
      params.appendQuarantinedLine(quarantined, row.line, error);
      return null;
    }
    if (!params.trustSeekEntry) {
      return { entry, startOffset: row.startOffset, endOffset: row.endOffset };
    }

    const previousRow = row.startOffset > 0
      ? await readJsonlLineBeforeAsync(segment.path, row.startOffset, {
        chunkBytes: seekChunkBytes,
        maxLineBytes: params.maxSeekLineBytes,
        stats: params.stats,
        scannedFileIdentities: seekFileIdentities,
        expectedFileIdentity: segment.identity,
      })
      : previousSegment
        ? await readJsonlLineBeforeAsync(previousSegment.path, previousSegment.size, {
          chunkBytes: seekChunkBytes,
          maxLineBytes: params.maxSeekLineBytes,
          stats: params.stats,
          scannedFileIdentities: seekFileIdentities,
          expectedFileIdentity: previousSegment.identity,
        })
        : null;
    let previousHmac = params.previousFileHmac;
    if (previousRow?.line.trim()) {
      try {
        const previousEntry = params.parseJournalLine(previousRow.line);
        previousHmac = typeof previousEntry._hmac === 'string' ? previousEntry._hmac : null;
      } catch (error) {
        params.appendQuarantinedLine(quarantined, previousRow.line, error);
        return null;
      }
    }
    try {
      return params.trustSeekEntry(entry, previousHmac)
        ? { entry, startOffset: row.startOffset, endOffset: row.endOffset }
        : null;
    } catch {
      return null;
    }
  };

  const findCursorOffset = async (
    segment: SeekSegment,
    previousSegment: SeekSegment | undefined,
  ): Promise<number | null> => {
    const fileSize = segment.size;
    let low = 0;
    let high = fileSize;
    while (high - low > seekChunkBytes) {
      const midpoint = low + Math.floor((high - low) / 2);
      const sampled = await readSeekEntry(segment, midpoint, previousSegment);
      if (!sampled) {
        high = midpoint;
        continue;
      }
      if (sampled.entry.id < params.beforeId) {
        low = Math.max(low + 1, sampled.endOffset);
      } else {
        high = midpoint;
      }
    }

    let offset = low;
    while (offset < fileSize) {
      const candidate = await readSeekEntry(segment, offset, previousSegment);
      if (!candidate) return null;
      if (candidate.entry.id >= params.beforeId) return candidate.startOffset;
      if (candidate.endOffset <= offset) return null;
      offset = candidate.endOffset;
    }
    return fileSize;
  };

  const scanCandidate = (segment: SeekSegment, endOffset?: number): boolean => (
    scanJsonlFileBackward(segment.path, {
      chunkBytes: params.chunkBytes,
      stats: params.stats,
      scannedFileIdentities,
      expectedFileIdentity: segment.identity,
      ...(endOffset === undefined ? {} : { endOffset }),
    }, (line) => {
      if (line.trim().length === 0) return false;
      let entry: JournalEntry;
      try {
        entry = params.parseJournalLine(line);
      } catch (error) {
        params.appendQuarantinedLine(quarantined, line, error);
        return false;
      }
      if (entry.id >= params.beforeId) return false;

      parsedDescending.push(entry);
      if (needBoundaryEntry) return true;
      if (entry.type !== 'message') return false;

      messageCount += 1;
      if (messageCount < params.messageLimit) return false;
      if (!params.includeBoundaryEntry) return true;
      needBoundaryEntry = true;
      return false;
    })
  );

  const archivePaths = listNumberedJsonlSegments(params.filePath)
    .sort((left, right) => left.segmentNumber - right.segmentNumber)
    .map(segment => segment.path);
  if (existsSync(params.filePath)) archivePaths.push(params.filePath);
  const nonEmptySegments = archivePaths
    .map((path): SeekSegment => {
      const fileStat = statSync(path);
      return {
        path,
        size: fileStat.size,
        identity: fileIdentityKey(fileStat),
      };
    })
    .filter(segment => segment.size > 0);

  let candidateIndex = -1;
  let low = 0;
  let high = nonEmptySegments.length - 1;
  let segmentSeekTrusted = true;
  while (low <= high) {
    const midpoint = low + Math.floor((high - low) / 2);
    const sampled = await readSeekEntry(
      nonEmptySegments[midpoint]!,
      0,
      midpoint > 0 ? nonEmptySegments[midpoint - 1] : undefined,
    );
    if (!sampled) {
      segmentSeekTrusted = false;
      break;
    }
    if (sampled.entry.id < params.beforeId) {
      candidateIndex = midpoint;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }

  if (segmentSeekTrusted && candidateIndex >= 0) {
    for (let index = candidateIndex; index >= 0 && !truncated; index -= 1) {
      const candidateSegment = nonEmptySegments[index]!;
      const candidateSize = candidateSegment.size;
      const cursorOffset = index === candidateIndex && candidateSize > 256 * 1024
        ? await findCursorOffset(
          candidateSegment,
          index > 0 ? nonEmptySegments[index - 1] : undefined,
        )
        : candidateSize;
      truncated = scanCandidate(candidateSegment, cursorOffset ?? candidateSize);
    }
  } else if (!segmentSeekTrusted) {
    // An unauthenticated or malformed boundary is never skip authority.
    for (let index = nonEmptySegments.length - 1; index >= 0 && !truncated; index -= 1) {
      truncated = scanCandidate(nonEmptySegments[index]!);
    }
  }

  return {
    entries: parsedDescending.reverse(),
    quarantined,
    truncated,
  };
}
