import {
  mkdirSync,
  readFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic as writeJsonAtomicFile } from '../utils/fs.js';

export type JsonValidator<T> = (value: unknown, sourcePath: string) => T;

export interface LoadOrSeedJsonOptions<T> {
  dataPath: string;
  seedPath: string;
  validate: JsonValidator<T>;
}

interface NodeErrorLike {
  code?: string;
}

function isNodeErrorLike(value: unknown): value is NodeErrorLike {
  return typeof value === 'object' && value !== null;
}

function isEnoent(error: unknown): boolean {
  return isNodeErrorLike(error) && error.code === 'ENOENT';
}

function parseJsonFile(path: string): unknown {
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw);
}

export function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
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

    // Corrupt or invalid data config: recover by reseeding from canonical defaults.
    return loadSeed();
  }
}
