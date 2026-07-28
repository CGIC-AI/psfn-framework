import {
  closeSync,
  createReadStream,
  fstatSync,
  openSync,
} from 'node:fs';
import { createInterface } from 'node:readline';
import { backfillLegacyTurnId, parseTurnId } from '../../core/turns/id.js';
import type { TurnRecord } from '../../shared/contracts/runtime.js';
import { isRecord } from '../../shared/utils/types.js';
import { fileIdentityKey } from '../jsonl-segments.js';
import type { TurnRecordIdentityLookup } from './turn-record-store-port.js';

const LOOKUP_YIELD_RECORDS = 8;

export interface TurnRecordIdentityLookupStats {
  linesScanned: number;
  recordsNormalized: number;
}

export interface TurnRecordIdentitySnapshotOptions {
  activePath: string;
  channelId: string;
  turnId: string;
  listRotatedPaths: () => string[];
  normalizeMatch: (raw: unknown) => TurnRecord;
  onMalformedLine: (path: string, line: string, error: unknown) => void;
  stats?: TurnRecordIdentityLookupStats;
}

interface IdentityFields {
  turnId?: unknown;
  requestId?: unknown;
  startedAt?: unknown;
  completedAt?: unknown;
}

function skipWhitespace(text: string, from: number): number {
  let cursor = from;
  while (cursor < text.length && /\s/u.test(text[cursor]!)) cursor += 1;
  return cursor;
}

function stringTokenEnd(text: string, from: number): number {
  if (text[from] !== '"') throw new Error('Expected a JSON string');
  let escaped = false;
  for (let cursor = from + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor]!;
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return cursor + 1;
  }
  throw new Error('Unterminated JSON string');
}

function compositeTokenEnd(text: string, from: number): number {
  const opening = text[from]!;
  const expectedClosers = [opening === '{' ? '}' : ']'];
  let cursor = from + 1;
  while (cursor < text.length && expectedClosers.length > 0) {
    const character = text[cursor]!;
    if (character === '"') {
      cursor = stringTokenEnd(text, cursor);
      continue;
    }
    if (character === '{') expectedClosers.push('}');
    else if (character === '[') expectedClosers.push(']');
    else if (character === '}' || character === ']') {
      if (expectedClosers.pop() !== character) {
        throw new Error('Mismatched JSON composite delimiter');
      }
    }
    cursor += 1;
  }
  if (expectedClosers.length > 0) throw new Error('Unterminated JSON composite');
  return cursor;
}

function valueTokenEnd(text: string, from: number): number {
  const cursor = skipWhitespace(text, from);
  const character = text[cursor];
  if (character === '"') return stringTokenEnd(text, cursor);
  if (character === '{' || character === '[') return compositeTokenEnd(text, cursor);
  let end = cursor;
  while (end < text.length && text[end] !== ',' && text[end] !== '}') end += 1;
  if (end === cursor) throw new Error('Missing JSON value');
  return end;
}

/**
 * Reads four scalar identity fields while skipping nested message/tool bodies
 * byte-for-byte. Matching rows still go through the canonical full normalizer;
 * unrelated rows never materialize their content trees.
 */
function readIdentityFields(line: string): IdentityFields {
  const fields: IdentityFields = {};
  let cursor = skipWhitespace(line, 0);
  if (line[cursor] !== '{') throw new Error('TurnRecord entry must be a JSON object');
  cursor = skipWhitespace(line, cursor + 1);
  while (cursor < line.length && line[cursor] !== '}') {
    const keyEnd = stringTokenEnd(line, cursor);
    const key = JSON.parse(line.slice(cursor, keyEnd)) as unknown;
    if (typeof key !== 'string') throw new Error('TurnRecord field name must be a string');
    cursor = skipWhitespace(line, keyEnd);
    if (line[cursor] !== ':') throw new Error('TurnRecord field is missing its colon');
    const valueStart = skipWhitespace(line, cursor + 1);
    const valueEnd = valueTokenEnd(line, valueStart);
    if (
      key === 'turnId'
      || key === 'requestId'
      || key === 'startedAt'
      || key === 'completedAt'
    ) {
      fields[key] = JSON.parse(line.slice(valueStart, valueEnd)) as unknown;
    }
    cursor = skipWhitespace(line, valueEnd);
    if (line[cursor] === ',') {
      cursor = skipWhitespace(line, cursor + 1);
      continue;
    }
    if (line[cursor] !== '}') throw new Error('TurnRecord fields must be comma separated');
  }
  if (line[cursor] !== '}') throw new Error('Unterminated TurnRecord JSON object');
  if (skipWhitespace(line, cursor + 1) !== line.length) {
    throw new Error('Unexpected bytes after TurnRecord JSON object');
  }
  return fields;
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

function projectTurnId(line: string, channelId: string): string {
  const fields = readIdentityFields(line);
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

/**
 * Resolve zero/one/many exact identities from one pinned source generation.
 *
 * The active descriptor and byte length are captured before rotated paths are
 * listed. A concurrent append or rotation therefore belongs wholly to either
 * this lookup or the next one. Inode de-duplication handles the interrupted
 * hard-link rotation state without double counting.
 */
export async function lookupTurnRecordIdentitySnapshot(
  options: TurnRecordIdentitySnapshotOptions,
): Promise<TurnRecordIdentityLookup> {
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
    let linesSinceYield = 0;
    for (const item of paths) {
      const snapshot = item.snapshot ?? openSnapshot(item.path, false);
      if (!snapshot) continue;
      if (scannedIdentities.has(snapshot.identity) || snapshot.size === 0) {
        closeSync(snapshot.fd);
        continue;
      }
      scannedIdentities.add(snapshot.identity);
      const input = createReadStream(item.path, {
        fd: snapshot.fd,
        autoClose: true,
        start: 0,
        end: snapshot.size - 1,
      });
      const lines = createInterface({ input, crlfDelay: Infinity });
      try {
        for await (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;
          if (options.stats) options.stats.linesScanned += 1;
          try {
            if (projectTurnId(line, options.channelId) === expectedTurnId) {
              const parsed = JSON.parse(line) as unknown;
              if (!isRecord(parsed)) throw new Error('TurnRecord entry must be a JSON object');
              const record = options.normalizeMatch(parsed);
              if (options.stats) options.stats.recordsNormalized += 1;
              if (unique) return { kind: 'duplicated' };
              unique = record;
            }
          } catch (error) {
            options.onMalformedLine(item.path, line, error);
          }
          linesSinceYield += 1;
          if (linesSinceYield >= LOOKUP_YIELD_RECORDS) {
            linesSinceYield = 0;
            await new Promise<void>(resolve => setImmediate(resolve));
          }
        }
      } finally {
        lines.close();
        input.destroy();
      }
    }
    return unique ? { kind: 'unique', record: unique } : { kind: 'missing' };
  } finally {
    if (active && !activeHandedOff) closeSync(active.fd);
  }
}
