import {
  closeSync,
  fstatSync,
  openSync,
  opendirSync,
  statSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { toErrorMessage } from '../shared/utils/errors.js';
import { isRecord } from '../shared/utils/types.js';
import {
  fileIdentityKey,
  readJsonlLineBeforeAsync,
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
  maxLineBytes: number;
  rotationRetries: number;
  stats?: JsonlSnapshotPageStats;
}

interface SnapshotSegment {
  name: string;
  identity: string;
  size: number;
}

interface SnapshotCursorPayload {
  version: 1;
  sourceId: string;
  current: SnapshotSegment | null;
  nextSealedNumber: number;
  exclusiveOffset: number;
  activeRelocationName?: string;
}

function segmentCoordinates(activePath: string): {
  directory: string;
  activeName: string;
  extension: string;
  stem: string;
} {
  const activeName = basename(activePath);
  const extension = extname(activeName);
  return {
    directory: dirname(activePath),
    activeName,
    extension,
    stem: activeName.slice(0, -extension.length),
  };
}

function segmentName(activePath: string, segmentNumber: number): string {
  const { stem, extension } = segmentCoordinates(activePath);
  return `${stem}.${String(segmentNumber).padStart(5, '0')}${extension}`;
}

function segmentPath(activePath: string, segmentNumber: number): string {
  return join(
    segmentCoordinates(activePath).directory,
    segmentName(activePath, segmentNumber),
  );
}

function isCanonicalSegmentName(name: string, activePath: string): boolean {
  const { activeName, extension, stem } = segmentCoordinates(activePath);
  if (name === activeName) return true;
  const prefix = `${stem}.`;
  return name.startsWith(prefix)
    && name.endsWith(extension)
    && /^\d{5,}$/.test(name.slice(prefix.length, -extension.length));
}

function readFileIdentity(path: string): string | null {
  try {
    return fileIdentityKey(statSync(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
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

/** Validate the complete sealed namespace while retaining constant state. */
function findNewestSealedNumber(activePath: string): number {
  const { directory, extension, stem } = segmentCoordinates(activePath);
  let dir;
  try {
    dir = opendirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let count = 0;
  let minimum = Number.MAX_SAFE_INTEGER;
  let maximum = 0;
  try {
    for (let entry = dir.readSync(); entry !== null; entry = dir.readSync()) {
      const prefix = `${stem}.`;
      if (!entry.name.startsWith(prefix) || !entry.name.endsWith(extension)) continue;
      const digits = entry.name.slice(prefix.length, -extension.length);
      if (!/^\d{5,}$/.test(digits)) continue;
      const segmentNumber = Number(digits);
      if (!Number.isSafeInteger(segmentNumber)
        || segmentNumber <= 0
        || entry.name !== segmentName(activePath, segmentNumber)) {
        throw new Error(`JSONL snapshot has a non-canonical sealed segment: ${entry.name}`);
      }
      count += 1;
      minimum = Math.min(minimum, segmentNumber);
      maximum = Math.max(maximum, segmentNumber);
    }
  } finally {
    dir.closeSync();
  }
  if (count === 0) return 0;
  if (minimum !== 1 || count !== maximum) {
    throw new Error(
      `JSONL snapshot sealed segments are non-contiguous: `
      + `count=${count}, minimum=${minimum}, maximum=${maximum}`,
    );
  }
  return maximum;
}

function locatePinnedActive(
  activePath: string,
  active: SnapshotSegment,
  newestSealedNumber: number,
  rotationRetries: number,
): number | null {
  const oldestCandidate = Math.max(1, newestSealedNumber - rotationRetries);
  for (
    let segmentNumber = newestSealedNumber;
    segmentNumber >= oldestCandidate;
    segmentNumber -= 1
  ) {
    if (readFileIdentity(segmentPath(activePath, segmentNumber)) === active.identity) {
      return segmentNumber;
    }
  }
  return null;
}

/**
 * Snapshot boundary: pin active inode A first. If A rotates during capture,
 * locate it within the bounded concurrent-rotation window and fence sealed
 * history immediately before A. Any newer B/C rotations belong to the next
 * snapshot. If A moves beyond that window, retry from a fresh active inode.
 */
function captureSnapshot(
  activePath: string,
  sourceId: string,
  rotationRetries: number,
): SnapshotCursorPayload {
  for (let attempt = 0; ; attempt += 1) {
    const active = openSnapshotSegment(activePath);
    const newestSealedNumber = findNewestSealedNumber(activePath);
    if (!active) {
      const current = newestSealedNumber > 0
        ? openSnapshotSegment(segmentPath(activePath, newestSealedNumber))
        : null;
      if (newestSealedNumber > 0 && !current) {
        throw new Error('Newest JSONL snapshot segment vanished during capture');
      }
      return {
        version: 1,
        sourceId,
        current,
        nextSealedNumber: Math.max(0, newestSealedNumber - 1),
        exclusiveOffset: current?.size ?? 0,
      };
    }
    const activeSegmentNumber = locatePinnedActive(
      activePath,
      active,
      newestSealedNumber,
      rotationRetries,
    );
    if (activeSegmentNumber !== null) {
      const movedName = segmentName(activePath, activeSegmentNumber);
      return {
        version: 1,
        sourceId,
        current: { ...active, name: movedName },
        nextSealedNumber: activeSegmentNumber - 1,
        exclusiveOffset: active.size,
        activeRelocationName: movedName,
      };
    }
    if (readFileIdentity(activePath) === active.identity) {
      return {
        version: 1,
        sourceId,
        current: active,
        nextSealedNumber: newestSealedNumber,
        exclusiveOffset: active.size,
        activeRelocationName: segmentName(activePath, newestSealedNumber + 1),
      };
    }
    if (attempt >= rotationRetries) {
      throw new Error(
        `JSONL snapshot capture exceeded ${rotationRetries} concurrent-rotation retries`,
      );
    }
  }
}

function encodeCursor(payload: SnapshotCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function parseSnapshotSegment(
  value: unknown,
  activePath: string,
): SnapshotSegment | null | undefined {
  if (value === null) return null;
  if (!isRecord(value)
    || typeof value.name !== 'string'
    || !isCanonicalSegmentName(value.name, activePath)
    || typeof value.identity !== 'string'
    || !/^\d+:\d+$/.test(value.identity)
    || !Number.isSafeInteger(value.size)
    || (value.size as number) < 0) {
    return undefined;
  }
  return {
    name: value.name,
    identity: value.identity,
    size: value.size as number,
  };
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
    || !Number.isSafeInteger(parsed.nextSealedNumber)
    || (parsed.nextSealedNumber as number) < 0
    || !Number.isSafeInteger(parsed.exclusiveOffset)
    || (parsed.exclusiveOffset as number) < 0
    || (
      parsed.activeRelocationName !== undefined
      && (
        typeof parsed.activeRelocationName !== 'string'
        || !isCanonicalSegmentName(parsed.activeRelocationName, activePath)
      )
    )) {
    throw new Error('JSONL snapshot cursor does not match the requested source');
  }
  const current = parseSnapshotSegment(parsed.current, activePath);
  const exclusiveOffset = parsed.exclusiveOffset as number;
  if (current === undefined
    || (current === null && exclusiveOffset !== 0)
    || (current !== null && exclusiveOffset > current.size)) {
    throw new Error('JSONL snapshot cursor position is outside its snapshot');
  }
  return {
    version: 1,
    sourceId,
    current,
    nextSealedNumber: parsed.nextSealedNumber as number,
    exclusiveOffset,
    ...(typeof parsed.activeRelocationName === 'string'
      ? { activeRelocationName: parsed.activeRelocationName }
      : {}),
  };
}

function locateCurrentSegment(
  activePath: string,
  state: SnapshotCursorPayload,
): string {
  const current = state.current;
  if (!current) throw new Error('JSONL snapshot cursor has no current segment');
  const directory = dirname(activePath);
  const candidates = [...new Set([
    join(directory, current.name),
    ...(state.activeRelocationName ? [join(directory, state.activeRelocationName)] : []),
    ...(state.activeRelocationName ? [activePath] : []),
  ])];
  for (const path of candidates) {
    if (readFileIdentity(path) === current.identity) {
      current.name = basename(path);
      return path;
    }
  }
  throw new Error(
    `JSONL snapshot segment ${current.identity} is no longer available; refusing to skip history`,
  );
}

async function readCurrentLine(
  activePath: string,
  state: SnapshotCursorPayload,
  options: ReadJsonlSnapshotPageOptions,
): Promise<(JsonlLineAtOffset & { path: string }) | null> {
  for (let attempt = 0; ; attempt += 1) {
    const current = state.current;
    if (!current) return null;
    const path = locateCurrentSegment(activePath, state);
    try {
      const line = await readJsonlLineBeforeAsync(path, state.exclusiveOffset, {
        chunkBytes: options.chunkBytes,
        maxLineBytes: options.maxLineBytes,
        stats: options.stats,
        expectedFileIdentity: current.identity,
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

function advanceSegment(activePath: string, state: SnapshotCursorPayload): void {
  state.activeRelocationName = undefined;
  if (state.nextSealedNumber <= 0) {
    state.current = null;
    state.exclusiveOffset = 0;
    return;
  }
  const segmentNumber = state.nextSealedNumber;
  const path = segmentPath(activePath, segmentNumber);
  const next = openSnapshotSegment(path);
  if (!next) {
    throw new Error(
      `JSONL snapshot is missing sealed segment ${segmentNumber}; refusing to skip history`,
    );
  }
  state.current = next;
  state.nextSealedNumber = segmentNumber - 1;
  state.exclusiveOffset = next.size;
}

/**
 * Read at most `limit` physical rows from one fixed active+numbered snapshot.
 * Cursor state retains one segment descriptor regardless of archive length.
 */
export async function readJsonlSnapshotPage(
  activePath: string,
  sourceId: string,
  limit: number,
  cursor: string | undefined,
  options: ReadJsonlSnapshotPageOptions,
): Promise<JsonlSnapshotPage> {
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('JSONL snapshot page limit must be a positive safe integer');
  }
  const state = cursor
    ? decodeCursor(cursor, sourceId, activePath)
    : captureSnapshot(activePath, sourceId, options.rotationRetries);
  const lines: JsonlSnapshotLine[] = [];
  while (lines.length < limit && state.current) {
    if (state.exclusiveOffset <= 0) {
      advanceSegment(activePath, state);
      continue;
    }
    const line = await readCurrentLine(activePath, state, options);
    if (!line) {
      advanceSegment(activePath, state);
      continue;
    }
    state.exclusiveOffset = line.startOffset;
    lines.push({ path: line.path, line: line.line });
    if (options.stats) options.stats.linesRead += 1;
  }
  while (state.current && state.exclusiveOffset <= 0) {
    advanceSegment(activePath, state);
  }
  const exhausted = state.current === null;
  return {
    lines,
    exhausted,
    ...(!exhausted ? { nextCursor: encodeCursor(state) } : {}),
  };
}
