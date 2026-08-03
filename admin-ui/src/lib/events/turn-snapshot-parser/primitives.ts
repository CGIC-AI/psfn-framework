import {
  assertNoUnknownKeys,
  isRecord,
} from '../../../../../src/shared/utils/types.js';

export type TurnSnapshotFailureClassification = 'malformed' | 'unsupported_schema';

export class TurnSnapshotParserError extends Error {
  constructor(
    readonly classification: TurnSnapshotFailureClassification,
    message: string,
  ) {
    super(message);
    this.name = 'TurnSnapshotParserError';
  }
}

export function reject(path: string, message: string): never {
  throw new TurnSnapshotParserError('malformed', `${path} ${message}`);
}

export function requirePlainRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) reject(path, 'must be an object');
  if (Object.getPrototypeOf(value) !== Object.prototype) {
    reject(path, 'must have the canonical object prototype');
  }
  return value;
}

export function requireExactRecord(
  value: unknown,
  path: string,
  keys: readonly string[],
): Record<string, unknown> {
  const record = requirePlainRecord(value, path);
  try {
    assertNoUnknownKeys(record, keys, path, { errorPrefix: 'Malformed turn snapshot' });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : `${path} contains unsupported fields`;
    throw new TurnSnapshotParserError('unsupported_schema', message);
  }
  return record;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) reject(path, 'must be an array');
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    reject(path, 'must have the canonical array prototype');
  }
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) reject(path, 'must not be sparse');
  }
  for (const key of Object.keys(value)) {
    if (!/^(0|[1-9]\d*)$/u.test(key) || Number(key) >= value.length) {
      reject(path, `contains unsupported array property ${JSON.stringify(key)}`);
    }
  }
  return value;
}

export function parseArray<T>(
  value: unknown,
  path: string,
  parseItem: (item: unknown, itemPath: string) => T,
): T[] {
  const source = requireArray(value, path);
  const result: T[] = [];
  for (let index = 0; index < source.length; index += 1) {
    result.push(parseItem(source[index], `${path}[${String(index)}]`));
  }
  return result;
}

export function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') reject(path, 'must be a string');
  return value;
}

export function requireNonEmptyString(value: unknown, path: string): string {
  const result = requireString(value, path);
  if (!result.trim()) reject(path, 'must be non-empty');
  return result;
}

export function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
): string | undefined {
  const value = record[key];
  return value === undefined ? undefined : requireString(value, `${path}.${key}`);
}

export function requireFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    reject(path, 'must be a finite number');
  }
  return value;
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  const result = requireFiniteNumber(value, path);
  if (result < 0) reject(path, 'must be non-negative');
  return result;
}

export function requireNonNegativeInteger(value: unknown, path: string): number {
  const result = requireNonNegativeNumber(value, path);
  if (!Number.isSafeInteger(result)) reject(path, 'must be a safe integer');
  return result;
}

export function optionalNonNegativeInteger(
  record: Record<string, unknown>,
  key: string,
  path: string,
): number | undefined {
  const value = record[key];
  return value === undefined
    ? undefined
    : requireNonNegativeInteger(value, `${path}.${key}`);
}

export function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') reject(path, 'must be a boolean');
  return value;
}

export function optionalBoolean(
  record: Record<string, unknown>,
  key: string,
  path: string,
): boolean | undefined {
  const value = record[key];
  return value === undefined ? undefined : requireBoolean(value, `${path}.${key}`);
}

export function parseStringArray(value: unknown, path: string): string[] {
  return parseArray(value, path, requireString);
}

export function parseNumberArray(value: unknown, path: string): number[] {
  return parseArray(value, path, requireNonNegativeInteger);
}

export function parseJsonValue(
  value: unknown,
  path: string,
  seen: WeakSet<object>,
): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return requireFiniteNumber(value, path);
  if (Array.isArray(value)) {
    if (seen.has(value)) reject(path, 'must not contain a cycle');
    seen.add(value);
    const result = parseArray(
      value,
      path,
      (item, itemPath) => parseJsonValue(item, itemPath, seen),
    );
    seen.delete(value);
    return result;
  }
  const source = requirePlainRecord(value, path);
  if (seen.has(source)) reject(path, 'must not contain a cycle');
  seen.add(source);
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(source)) {
    const parsed = parseJsonValue(item, `${path}.${key}`, seen);
    Object.defineProperty(result, key, {
      value: parsed,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  seen.delete(source);
  return result;
}

export function parseJsonRecord(value: unknown, path: string): Record<string, unknown> {
  const source = requirePlainRecord(value, path);
  const result: Record<string, unknown> = {};
  const seen = new WeakSet<object>([source]);
  for (const [key, item] of Object.entries(source)) {
    const parsed = parseJsonValue(item, `${path}.${key}`, seen);
    Object.defineProperty(result, key, {
      value: parsed,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}
