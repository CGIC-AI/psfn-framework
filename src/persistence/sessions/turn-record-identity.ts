import {
  closeSync,
  fstatSync,
  openSync,
  read,
} from 'node:fs';
import { backfillLegacyTurnId, parseTurnId } from '../../core/turns/id.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import { fileIdentityKey } from '../jsonl-segments.js';
import type { TurnRecordIdentityLookup } from './turn-record-store-port.js';

const LOOKUP_READ_CHUNK_BYTES = 64 * 1024;
const IDENTITY_TOKEN_BYTES = 512;
const WANTED_FIELDS = new Set(['turnId', 'requestId', 'startedAt', 'completedAt']);

export interface TurnRecordIdentityLookupStats {
  linesScanned: number;
  recordsNormalized: number;
  bytesRead: number;
  maxReadChunkBytes: number;
  cacheHits: number;
}

export interface TurnRecordIdentitySnapshotOptions {
  activePath: string;
  channelId: string;
  turnId: string;
  listRotatedPaths: () => string[];
  normalizeMatch: (raw: unknown) => TurnRecord;
  onMalformedLine: (path: string, rawLength: number, error: unknown) => void;
  signal?: AbortSignal;
  stats?: TurnRecordIdentityLookupStats;
}

interface IdentityFields {
  turnId?: unknown;
  requestId?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

interface IdentityProjection {
  fields: IdentityFields;
  error?: Error;
}

type ProjectionState =
  | 'start'
  | 'key-or-end'
  | 'key'
  | 'colon'
  | 'value'
  | 'string-value'
  | 'composite-value'
  | 'primitive-value'
  | 'comma-or-end'
  | 'done';

function isWhitespace(byte: number): boolean {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d;
}

/**
 * Extracts only the four small top-level identity scalars. Large message and
 * tool bodies pass through one byte at a time and are never accumulated.
 * Matching rows are subsequently read and normalized in full.
 */
class StreamingIdentityProjector {
  private state: ProjectionState = 'start';
  private readonly fields: IdentityFields = {};
  private firstError: Error | undefined;
  private token: number[] = [];
  private tokenOverflow = false;
  private escaped = false;
  private currentKey: string | null = null;
  private capturingValue = false;
  private readonly compositeClosers: number[] = [];
  private compositeString = false;
  private compositeEscaped = false;

  push(byte: number): void {
    switch (this.state) {
      case 'start':
        if (isWhitespace(byte)) return;
        if (byte !== 0x7b) {
          this.fail('TurnRecord entry must be a JSON object');
          return;
        }
        this.state = 'key-or-end';
        return;
      case 'key-or-end':
        if (isWhitespace(byte)) return;
        if (byte === 0x7d) {
          this.state = 'done';
          return;
        }
        if (byte !== 0x22) {
          this.fail('TurnRecord field name must be a string');
          return;
        }
        this.beginToken(byte);
        this.escaped = false;
        this.state = 'key';
        return;
      case 'key':
        this.captureToken(byte);
        if (this.escaped) {
          this.escaped = false;
          return;
        }
        if (byte === 0x5c) {
          this.escaped = true;
          return;
        }
        if (byte === 0x22) {
          this.currentKey = this.parseToken('TurnRecord field name') as string | null;
          this.state = 'colon';
        }
        return;
      case 'colon':
        if (isWhitespace(byte)) return;
        if (byte !== 0x3a) {
          this.fail('TurnRecord field is missing its colon');
          return;
        }
        this.state = 'value';
        return;
      case 'value':
        if (isWhitespace(byte)) return;
        if (byte === 0x22) {
          this.beginValueToken(byte);
          this.escaped = false;
          this.state = 'string-value';
          return;
        }
        if (byte === 0x7b || byte === 0x5b) {
          this.compositeClosers.push(byte === 0x7b ? 0x7d : 0x5d);
          this.compositeString = false;
          this.compositeEscaped = false;
          this.state = 'composite-value';
          return;
        }
        if (byte === 0x2c || byte === 0x7d) {
          this.fail('Missing JSON value');
          this.finishValueDelimiter(byte);
          return;
        }
        this.beginValueToken(byte);
        this.state = 'primitive-value';
        return;
      case 'string-value':
        if (this.capturingValue) this.captureToken(byte);
        if (this.escaped) {
          this.escaped = false;
          return;
        }
        if (byte === 0x5c) {
          this.escaped = true;
          return;
        }
        if (byte === 0x22) {
          this.assignCurrentField(this.parseValueToken());
          this.state = 'comma-or-end';
        }
        return;
      case 'composite-value':
        this.pushComposite(byte);
        return;
      case 'primitive-value':
        if (byte === 0x2c || byte === 0x7d) {
          this.assignCurrentField(this.parseValueToken());
          this.finishValueDelimiter(byte);
          return;
        }
        if (this.capturingValue) this.captureToken(byte);
        return;
      case 'comma-or-end':
        if (isWhitespace(byte)) return;
        if (byte === 0x2c || byte === 0x7d) {
          this.finishValueDelimiter(byte);
          return;
        }
        this.fail('TurnRecord fields must be comma separated');
        return;
      case 'done':
        if (!isWhitespace(byte)) this.fail('Unexpected bytes after TurnRecord JSON object');
    }
  }

  finish(): IdentityProjection {
    if (this.state !== 'done' && !this.firstError) {
      this.fail('Unterminated TurnRecord JSON object');
    }
    return {
      fields: this.fields,
      ...(this.firstError ? { error: this.firstError } : {}),
    };
  }

  private pushComposite(byte: number): void {
    if (this.compositeString) {
      if (this.compositeEscaped) {
        this.compositeEscaped = false;
      } else if (byte === 0x5c) {
        this.compositeEscaped = true;
      } else if (byte === 0x22) {
        this.compositeString = false;
      }
      return;
    }
    if (byte === 0x22) {
      this.compositeString = true;
      return;
    }
    if (byte === 0x7b || byte === 0x5b) {
      this.compositeClosers.push(byte === 0x7b ? 0x7d : 0x5d);
      return;
    }
    if (byte !== 0x7d && byte !== 0x5d) return;
    if (this.compositeClosers.pop() !== byte) {
      this.fail('Mismatched JSON composite delimiter');
      return;
    }
    if (this.compositeClosers.length === 0) {
      this.assignCurrentField(undefined);
      this.state = 'comma-or-end';
    }
  }

  private finishValueDelimiter(byte: number): void {
    this.currentKey = null;
    this.state = byte === 0x2c ? 'key-or-end' : 'done';
  }

  private beginToken(byte: number): void {
    this.token = [];
    this.tokenOverflow = false;
    this.captureToken(byte);
  }

  private beginValueToken(byte: number): void {
    this.capturingValue = this.currentKey !== null && WANTED_FIELDS.has(this.currentKey);
    if (this.capturingValue) this.beginToken(byte);
  }

  private parseValueToken(): unknown {
    return this.capturingValue
      ? this.parseToken('TurnRecord identity value')
      : undefined;
  }

  private captureToken(byte: number): void {
    if (this.tokenOverflow) return;
    if (this.token.length >= IDENTITY_TOKEN_BYTES) {
      this.tokenOverflow = true;
      this.token = [];
      return;
    }
    this.token.push(byte);
  }

  private parseToken(label: string): unknown {
    if (this.tokenOverflow) {
      this.fail(`${label} exceeds the bounded identity token limit`);
      return undefined;
    }
    try {
      return JSON.parse(Buffer.from(this.token).toString('utf8')) as unknown;
    } catch {
      this.fail(`${label} is malformed JSON`);
      return undefined;
    }
  }

  private assignCurrentField(value: unknown): void {
    if (this.currentKey && WANTED_FIELDS.has(this.currentKey)) {
      this.fields[this.currentKey as keyof IdentityFields] = value;
    }
    this.capturingValue = false;
  }

  private fail(message: string): void {
    this.firstError ??= new Error(message);
  }
}

function requiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`TurnRecord field "${fieldName}" must be a non-empty string`);
  }
  return value.trim();
}

function requiredTimestamp(value: unknown, fieldName: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`TurnRecord field "${fieldName}" must be a finite non-negative number`);
  }
  return Math.floor(value);
}

function projectTurnId(fields: IdentityFields, channelId: string): string {
  const parsed = parseTurnId(fields.turnId, 'turnId');
  if (parsed) return parsed;
  const requestId = requiredString(fields.requestId, 'requestId');
  const startedAt = requiredTimestamp(fields.startedAt, 'startedAt');
  const completedAt = requiredTimestamp(fields.completedAt, 'completedAt');
  return backfillLegacyTurnId(`${channelId}:${requestId}:${startedAt}:${completedAt}`);
}

interface OpenSnapshot {
  fd: number;
  size: number;
  identity: string;
}

function openSnapshot(path: string, missingIsAllowed: boolean): OpenSnapshot | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (error) {
    if (missingIsAllowed && (error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const snapshot = fstatSync(fd);
    return {
      fd,
      size: snapshot.size,
      identity: fileIdentityKey(snapshot),
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function readChunk(fd: number, buffer: Buffer, position: number): Promise<number> {
  return new Promise((resolve, reject) => {
    read(fd, buffer, 0, buffer.length, position, (error, bytesRead) => {
      if (error) reject(error);
      else resolve(bytesRead);
    });
  });
}

async function readLine(
  fd: number,
  start: number,
  end: number,
  signal?: AbortSignal,
  stats?: TurnRecordIdentityLookupStats,
): Promise<string> {
  const buffers: Buffer[] = [];
  let position = start;
  while (position < end) {
    signal?.throwIfAborted();
    const buffer = Buffer.allocUnsafe(Math.min(LOOKUP_READ_CHUNK_BYTES, end - position));
    const bytesRead = await readChunk(fd, buffer, position);
    if (bytesRead === 0) throw new Error('TurnRecord snapshot ended before the matching row');
    buffers.push(buffer.subarray(0, bytesRead));
    position += bytesRead;
    if (stats) {
      stats.bytesRead += bytesRead;
      stats.maxReadChunkBytes = Math.max(stats.maxReadChunkBytes, bytesRead);
    }
  }
  return Buffer.concat(buffers).toString('utf8').trim();
}

interface ScanResult {
  record: TurnRecord | null;
  ambiguous: boolean;
}

async function scanSnapshot(
  path: string,
  snapshot: OpenSnapshot,
  channelId: string,
  expectedTurnId: string,
  normalizeMatch: (raw: unknown) => TurnRecord,
  onMalformedLine: (path: string, rawLength: number, error: unknown) => void,
  signal?: AbortSignal,
  stats?: TurnRecordIdentityLookupStats,
): Promise<ScanResult> {
  const buffer = Buffer.allocUnsafe(LOOKUP_READ_CHUNK_BYTES);
  let position = 0;
  let lineStart = 0;
  let projector = new StreamingIdentityProjector();
  let record: TurnRecord | null = null;

  const finishLine = async (lineEnd: number): Promise<boolean> => {
    const rawLength = lineEnd - lineStart;
    const projection = projector.finish();
    projector = new StreamingIdentityProjector();
    if (rawLength === 0) return false;
    if (stats) stats.linesScanned += 1;
    let projectedTurnId: string | null = null;
    try {
      projectedTurnId = projectTurnId(projection.fields, channelId);
    } catch (error) {
      onMalformedLine(path, rawLength, projection.error ?? error);
      // Once a row cannot be projected, this lookup cannot prove that the row
      // belongs to a different TurnID. Treat it as ambiguity, never absence.
      return true;
    }
    if (projection.error) {
      onMalformedLine(path, rawLength, projection.error);
      return projectedTurnId === expectedTurnId;
    }
    if (projectedTurnId !== expectedTurnId) return false;
    try {
      const line = await readLine(snapshot.fd, lineStart, lineEnd, signal, stats);
      signal?.throwIfAborted();
      const parsed = JSON.parse(line) as unknown;
      if (!isRecord(parsed)) throw new Error('TurnRecord entry must be a JSON object');
      const match = normalizeMatch(parsed);
      if (stats) stats.recordsNormalized += 1;
      if (record) return true;
      record = match;
      return false;
    } catch (error) {
      signal?.throwIfAborted();
      onMalformedLine(path, rawLength, error);
      return true;
    }
  };

  let ambiguous = false;
  scan: while (position < snapshot.size) {
    signal?.throwIfAborted();
    const readBuffer = buffer.subarray(
      0,
      Math.min(buffer.length, snapshot.size - position),
    );
    const bytesRead = await readChunk(
      snapshot.fd,
      readBuffer,
      position,
    );
    if (bytesRead === 0) break;
    if (stats) {
      stats.bytesRead += bytesRead;
      stats.maxReadChunkBytes = Math.max(stats.maxReadChunkBytes, bytesRead);
    }
    for (let offset = 0; offset < bytesRead; offset += 1) {
      const byte = buffer[offset]!;
      if (byte === 0x0a) {
        const lineEnd = position + offset;
        if (await finishLine(lineEnd)) {
          ambiguous = true;
          break scan;
        }
        lineStart = lineEnd + 1;
      } else {
        projector.push(byte);
      }
    }
    position += bytesRead;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  if (!ambiguous && lineStart < snapshot.size) {
    ambiguous = await finishLine(snapshot.size);
  }
  return { record, ambiguous };
}

/**
 * Resolve zero/one/many exact identities from one pinned source generation.
 * Reads are fixed-size and yield after every chunk, so even one enormous JSONL
 * row cannot monopolize the primary agent loop or be buffered unless it is the
 * exact row that must be returned.
 */
export async function lookupTurnRecordIdentitySnapshot(
  options: TurnRecordIdentitySnapshotOptions,
): Promise<TurnRecordIdentityLookup> {
  options.signal?.throwIfAborted();
  const expectedTurnId = parseTurnId(options.turnId, 'turnId');
  if (!expectedTurnId) throw new Error('TurnRecord identity lookup requires a TurnID');
  const active = openSnapshot(options.activePath, true);
  let activeHandedOff = false;
  try {
    const rotatedPaths = options.listRotatedPaths();
    const paths = [
      ...(active ? [{ path: options.activePath, snapshot: active }] : []),
      ...rotatedPaths.map(path => ({ path, snapshot: null })),
    ];
    activeHandedOff = active !== null;
    const scannedIdentities = new Set<string>();
    let unique: TurnRecord | null = null;
    for (const item of paths) {
      options.signal?.throwIfAborted();
      const snapshot = item.snapshot ?? openSnapshot(item.path, false);
      if (!snapshot) continue;
      try {
        if (scannedIdentities.has(snapshot.identity) || snapshot.size === 0) continue;
        scannedIdentities.add(snapshot.identity);
        const result = await scanSnapshot(
          item.path,
          snapshot,
          options.channelId,
          expectedTurnId,
          options.normalizeMatch,
          options.onMalformedLine,
          options.signal,
          options.stats,
        );
        if (result.ambiguous || (unique && result.record)) return { kind: 'duplicated' };
        unique ??= result.record;
      } finally {
        closeSync(snapshot.fd);
      }
    }
    return unique ? { kind: 'unique', record: unique } : { kind: 'missing' };
  } finally {
    if (active && !activeHandedOff) closeSync(active.fd);
  }
}
