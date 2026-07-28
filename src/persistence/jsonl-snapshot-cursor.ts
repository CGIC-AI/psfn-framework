import { closeSync, fstatSync, openSync, statSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { isRecord } from '../shared/utils/types.js';
import { toErrorMessage } from '../shared/utils/errors.js';
import {
  fileIdentityKey,
  listNumberedJsonlSegments,
  readJsonlLineBefore,
  type JsonlLineAtOffset,
  type JsonlReadStats,
} from './jsonl-segments.js';

export interface JsonlSnapshotPageStats extends JsonlReadStats {
  linesRead: number;
}
export interface JsonlSnapshotLine {
  path: string;
  line: string;
}
export interface JsonlSnapshotPage {
  lines: JsonlSnapshotLine[];
  nextCursor?: string;
  exhausted: boolean;
}
export interface ReadJsonlSnapshotPageOptions {
  chunkBytes: number;
  rotationRetries: number;
  stats?: JsonlSnapshotPageStats;
}

interface SnapshotSegment {
  /** Canonical basename, stable inode identity, and captured exclusive byte ceiling. */
  name: string;
  identity: string;
  size: number;
}
interface SnapshotCursorPayload {
  version: 1;
  sourceId: string;
  segments: SnapshotSegment[];
  segmentIndex: number;
  exclusiveOffset: number;
}

function isCanonicalSegmentName(name: string, activePath: string): boolean {
  const activeName = basename(activePath);
  if (name === activeName) return true;
  const extension = extname(activeName);
  const stem = activeName.slice(0, -extension.length);
  const prefix = `${stem}.`;
  if (!name.startsWith(prefix) || !name.endsWith(extension)) return false;
  const segmentNumber = name.slice(prefix.length, -extension.length);
  return /^\d{5,}$/.test(segmentNumber);
}

function encodeCursor(payload: SnapshotCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}
function decodeCursor(
  cursor: string,
  sourceId: string,
  activePath: string,
): SnapshotCursorPayload {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
  } catch (error) {
    throw new Error(`JSONL snapshot cursor is malformed: ${toErrorMessage(error)}`);
  }
  if (!isRecord(parsed)
    || parsed.version !== 1
    || parsed.sourceId !== sourceId
    || !Array.isArray(parsed.segments)
    || !Number.isSafeInteger(parsed.segmentIndex)
    || (parsed.segmentIndex as number) < 0
    || !Number.isSafeInteger(parsed.exclusiveOffset)
    || (parsed.exclusiveOffset as number) < 0) {
    throw new Error('JSONL snapshot cursor does not match the requested source');
  }
  const segments: SnapshotSegment[] = [];
  const identities = new Set<string>();
  for (const entry of parsed.segments) {
    if (!isRecord(entry)
      || typeof entry.name !== 'string'
      || !isCanonicalSegmentName(entry.name, activePath)
      || typeof entry.identity !== 'string'
      || !/^\d+:\d+$/.test(entry.identity)
      || !Number.isSafeInteger(entry.size)
      || (entry.size as number) < 0
      || identities.has(entry.identity)) {
      throw new Error('JSONL snapshot cursor contains an invalid segment');
    }
    identities.add(entry.identity);
    segments.push({
      name: entry.name,
      identity: entry.identity,
      size: entry.size as number,
    });
  }
  const segmentIndex = parsed.segmentIndex as number;
  const exclusiveOffset = parsed.exclusiveOffset as number;
  if (segmentIndex > segments.length
    || (segmentIndex === segments.length && exclusiveOffset !== 0)
    || (
      segmentIndex < segments.length
      && exclusiveOffset > (segments[segmentIndex]?.size ?? 0)
    )) {
    throw new Error('JSONL snapshot cursor position is outside its snapshot');
  }
  return {
    version: 1,
    sourceId,
    segments,
    segmentIndex,
    exclusiveOffset,
  };
}
function openSnapshotSegment(path: string): SnapshotSegment | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const snapshot = fstatSync(fd);
    if (!Number.isSafeInteger(snapshot.size) || snapshot.size < 0) {
      throw new Error(`JSONL snapshot segment ${path} has an unsupported byte size`);
    }
    return {
      name: basename(path),
      identity: fileIdentityKey(snapshot),
      size: snapshot.size,
    };
  } finally {
    closeSync(fd);
  }
}
/**
 * Capture one fixed newest-to-oldest segment snapshot without parsing history.
 *
 * The active inode is pinned first. If it rotates before sealed segments are
 * listed, inode de-duplication keeps the moved active segment exactly once and
 * a newly-created active file belongs to the next snapshot.
 */
function snapshotSegments(activePath: string): SnapshotSegment[] {
  const segments: SnapshotSegment[] = [];
  const identities = new Set<string>();
  const active = openSnapshotSegment(activePath);
  if (active) {
    segments.push(active);
    identities.add(active.identity);
  }
  for (const rotated of listNumberedJsonlSegments(activePath)
    .sort((left, right) => right.segmentNumber - left.segmentNumber)) {
    const segment = openSnapshotSegment(rotated.path);
    if (!segment) {
      throw new Error(`JSONL snapshot segment vanished while being captured: ${rotated.path}`);
    }
    if (identities.has(segment.identity)) continue;
    identities.add(segment.identity);
    segments.push(segment);
  }
  return segments;
}
function locateSegment(activePath: string, segment: SnapshotSegment): string {
  const directory = dirname(activePath);
  const preferredPath = join(directory, segment.name);
  const directPaths = preferredPath === activePath
    ? [preferredPath]
    : [preferredPath, activePath];
  for (const path of directPaths) {
    try {
      if (fileIdentityKey(statSync(path)) === segment.identity) return path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  for (const candidate of listNumberedJsonlSegments(activePath)) {
    if (candidate.path === preferredPath) continue;
    try {
      if (fileIdentityKey(statSync(candidate.path)) === segment.identity) return candidate.path;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
  throw new Error(
    `JSONL snapshot segment ${segment.identity} is no longer available; refusing to skip history`,
  );
}
function readSnapshotLineBefore(
  activePath: string,
  segment: SnapshotSegment,
  exclusiveOffset: number,
  options: ReadJsonlSnapshotPageOptions,
): (JsonlLineAtOffset & { path: string }) | null {
  for (let attempt = 0; ; attempt += 1) {
    const path = locateSegment(activePath, segment);
    segment.name = basename(path);
    try {
      const line = readJsonlLineBefore(path, exclusiveOffset, {
        chunkBytes: options.chunkBytes,
        stats: options.stats,
        expectedFileIdentity: segment.identity,
      });
      return line ? { ...line, path } : null;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ESTALE') throw error;
      if (attempt >= options.rotationRetries) {
        throw new Error(
          `JSONL cursor kept losing races with segment rotation after `
          + `${options.rotationRetries} retries: ${toErrorMessage(error)}`,
        );
      }
    }
  }
}
/**
 * Read at most `limit` physical rows from one fixed active+numbered snapshot.
 * Supplying no cursor explicitly resets traversal to a newly captured snapshot.
 */
export function readJsonlSnapshotPage(
  activePath: string,
  sourceId: string,
  limit: number,
  cursor: string | undefined,
  options: ReadJsonlSnapshotPageOptions,
): JsonlSnapshotPage {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('JSONL snapshot page limit must be a positive safe integer');
  }
  const state = cursor
    ? decodeCursor(cursor, sourceId, activePath)
    : {
      version: 1 as const,
      sourceId,
      segments: snapshotSegments(activePath),
      segmentIndex: 0,
      exclusiveOffset: 0,
    };
  if (!cursor && state.segments.length > 0) {
    state.exclusiveOffset = state.segments[0]?.size ?? 0;
  }
  const lines: JsonlSnapshotLine[] = [];
  while (lines.length < limit && state.segmentIndex < state.segments.length) {
    const segment = state.segments[state.segmentIndex]!;
    if (state.exclusiveOffset <= 0) {
      state.segmentIndex += 1;
      state.exclusiveOffset = state.segments[state.segmentIndex]?.size ?? 0;
      continue;
    }
    const line = readSnapshotLineBefore(
      activePath,
      segment,
      state.exclusiveOffset,
      options,
    );
    if (!line) {
      state.segmentIndex += 1;
      state.exclusiveOffset = state.segments[state.segmentIndex]?.size ?? 0;
      continue;
    }
    state.exclusiveOffset = line.startOffset;
    lines.push({ path: line.path, line: line.line });
    if (options.stats) options.stats.linesRead += 1;
  }
  while (
    state.segmentIndex < state.segments.length
    && state.exclusiveOffset <= 0
  ) {
    state.segmentIndex += 1;
    state.exclusiveOffset = state.segments[state.segmentIndex]?.size ?? 0;
  }
  const exhausted = state.segmentIndex >= state.segments.length;
  return {
    lines,
    exhausted,
    ...(!exhausted ? { nextCursor: encodeCursor(state) } : {}),
  };
}
