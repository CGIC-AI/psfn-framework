import * as fs from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic as writeJsonAtomicFile } from '../../shared/utils/fs.js';

export type JsonValidator<T> = (value: unknown, sourcePath: string) => T;

export interface LoadOrSeedJsonOptions<T> {
  dataPath: string;
  seedPath: string;
  validate: JsonValidator<T>;
}

export interface LoadSeedJsonOptions<T> {
  seedPath: string;
  validate: JsonValidator<T>;
}

interface NodeErrorLike {
  code?: string;
}

interface JsonFileFingerprint {
  ctimeNs: bigint;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

interface CachedJsonValue {
  fingerprint: JsonFileFingerprint;
  value: unknown;
}

interface CachedJsonDiagnostics {
  hits: number;
  misses: number;
}

const cachedJsonValues = new Map<string, CachedJsonValue>();
const cachedJsonDiagnostics = new Map<string, CachedJsonDiagnostics>();

function isNodeErrorLike(value: unknown): value is NodeErrorLike {
  return typeof value === 'object' && value !== null;
}

function isEnoent(error: unknown): boolean {
  return isNodeErrorLike(error) && error.code === 'ENOENT';
}

function cloneJsonValue<T>(value: T): T {
  return structuredClone(value);
}

function readJsonFileFingerprint(path: string): JsonFileFingerprint | undefined {
  try {
    const stats = fs.statSync(path, { bigint: true });
    return {
      ctimeNs: stats.ctimeNs,
      ino: stats.ino,
      mtimeNs: stats.mtimeNs,
      size: stats.size,
    };
  } catch (error) {
    if (isEnoent(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameFingerprint(
  left: JsonFileFingerprint | undefined,
  right: JsonFileFingerprint | undefined,
): boolean {
  return left?.ctimeNs === right?.ctimeNs
    && left?.ino === right?.ino
    && left?.mtimeNs === right?.mtimeNs
    && left?.size === right?.size;
}

function parseJsonFile(path: string): unknown {
  const raw = fs.readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  fs.mkdirSync(dirname(path), { recursive: true });
  writeJsonAtomicFile(path, value);
}

export function loadOrSeedJson<T>(options: LoadOrSeedJsonOptions<T>): T {
  const { dataPath, seedPath, validate } = options;

  const loadSeed = (): T => {
    const seedRaw = parseJsonFile(seedPath);
    const seed = validate(seedRaw, seedPath);
    writeJsonAtomic(dataPath, seed);
    return seed;
  };

  try {
    const dataRaw = parseJsonFile(dataPath);
    return validate(dataRaw, dataPath);
  } catch (error) {
    if (isEnoent(error)) {
      return loadSeed();
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Refusing to reseed invalid JSON config at ${dataPath}; fix or remove the file explicitly. Cause: ${reason}`,
    );
  }
}

export function loadSeedJson<T>(options: LoadSeedJsonOptions<T>): T {
  const { seedPath, validate } = options;
  const seedRaw = parseJsonFile(seedPath);
  return validate(seedRaw, seedPath);
}

export function invalidateCachedJsonValue(path: string): void {
  cachedJsonValues.delete(path);
}

export function cacheJsonValue<T>(path: string, value: T): void {
  const fingerprint = readJsonFileFingerprint(path);
  if (!fingerprint) {
    invalidateCachedJsonValue(path);
    return;
  }

  cachedJsonValues.set(path, {
    fingerprint,
    value: cloneJsonValue(value),
  });
}

export function getCachedJsonValueDiagnostics(path: string): CachedJsonDiagnostics & {
  hasCachedValue: boolean;
} {
  const diagnostics = cachedJsonDiagnostics.get(path);
  return {
    hits: diagnostics?.hits ?? 0,
    misses: diagnostics?.misses ?? 0,
    hasCachedValue: cachedJsonValues.has(path),
  };
}

export function loadOrSeedJsonCached<T>(options: LoadOrSeedJsonOptions<T>): T {
  const fingerprint = readJsonFileFingerprint(options.dataPath);
  const cached = cachedJsonValues.get(options.dataPath);
  const diagnostics = cachedJsonDiagnostics.get(options.dataPath) ?? { hits: 0, misses: 0 };
  cachedJsonDiagnostics.set(options.dataPath, diagnostics);
  if (cached && sameFingerprint(cached.fingerprint, fingerprint)) {
    diagnostics.hits += 1;
    return cloneJsonValue(cached.value as T);
  }
  diagnostics.misses += 1;

  try {
    const loaded = loadOrSeedJson(options);
    cacheJsonValue(options.dataPath, loaded);
    return cloneJsonValue(loaded);
  } catch (error) {
    invalidateCachedJsonValue(options.dataPath);
    throw error;
  }
}
