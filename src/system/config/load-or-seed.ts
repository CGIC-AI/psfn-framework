import * as fs from 'node:fs';

export type JsonValidator<T> = (value: unknown, sourcePath: string) => T;

export interface LoadOrSeedJsonOptions<T> {
  dataPath: string;
  seedPath: string;
  validate: JsonValidator<T>;
}

export interface LoadRequiredJsonOptions<T> {
  dataPath: string;
  examplePath?: string;
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

export function formatMissingRequiredOwnerFileMessage(input: {
  dataPath: string;
  examplePath?: string;
}): string {
  const exampleGuidance = input.examplePath
    ? ` To bootstrap intentionally, copy the example template (${input.examplePath}) to ${input.dataPath}, then edit it for this deployment.`
    : '';
  return `Missing required JSON owner file at ${input.dataPath}. Startup no longer copies distributed seed/example files into runtime state.${exampleGuidance}`;
}

export function loadRequiredJson<T>(options: LoadRequiredJsonOptions<T>): T {
  const { dataPath, examplePath, validate } = options;

  try {
    const dataRaw = parseJsonFile(dataPath);
    return validate(dataRaw, dataPath);
  } catch (error) {
    if (isEnoent(error)) {
      throw new Error(formatMissingRequiredOwnerFileMessage({ dataPath, examplePath }));
    }

    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Invalid JSON owner file at ${dataPath}. Repair it in place; PSFN will not overwrite it from seed/example templates. Cause: ${reason}`,
    );
  }
}

/**
 * @deprecated Runtime config must not seed itself. This compatibility wrapper
 * treats seedPath as example guidance only and requires dataPath to exist.
 */
export function loadOrSeedJson<T>(options: LoadOrSeedJsonOptions<T>): T {
  return loadRequiredJson({
    dataPath: options.dataPath,
    examplePath: options.seedPath,
    validate: options.validate,
  });
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

export function loadRequiredJsonCached<T>(options: LoadRequiredJsonOptions<T>): T {
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
    const loaded = loadRequiredJson(options);
    cacheJsonValue(options.dataPath, loaded);
    return cloneJsonValue(loaded);
  } catch (error) {
    invalidateCachedJsonValue(options.dataPath);
    throw error;
  }
}

/**
 * @deprecated Runtime config must not seed itself. This compatibility wrapper
 * treats seedPath as example guidance only and requires dataPath to exist.
 */
export function loadOrSeedJsonCached<T>(options: LoadOrSeedJsonOptions<T>): T {
  return loadRequiredJsonCached({
    dataPath: options.dataPath,
    examplePath: options.seedPath,
    validate: options.validate,
  });
}
