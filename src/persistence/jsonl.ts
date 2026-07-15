import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { createComponentLogger } from '../shared/logger.js';

const log = createComponentLogger('Jsonl');
const ensuredAppendDirectories = new Set<string>();

function isMissingPathError(error: unknown): boolean {
  return error instanceof Error
    && 'code' in error
    && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function ensureAppendDirectory(directory: string): void {
  if (ensuredAppendDirectories.has(directory)) return;
  mkdirSync(directory, { recursive: true });
  ensuredAppendDirectories.add(directory);
}

export interface ReadJsonLineContext {
  path: string;
  line: number;
  rawLine: string;
}

export interface ReadJsonLineErrorContext extends ReadJsonLineContext {
  error: unknown;
}

export interface ReadJsonLinesOptions {
  onError?: (context: ReadJsonLineErrorContext) => void;
  warnLabel?: string;
}

export interface ReadJsonLinesResult<T> {
  entries: T[];
  skipped: number;
  corrupt: number;
}

type JsonLineNormalizer<T> = (raw: unknown, context: ReadJsonLineContext) => T | null;

export function appendJsonLine(path: string, entry: unknown): void {
  const directory = dirname(path);
  ensureAppendDirectory(directory);
  const serialized = `${JSON.stringify(entry)}\n`;
  try {
    appendFileSync(path, serialized, 'utf-8');
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    ensuredAppendDirectories.delete(directory);
    ensureAppendDirectory(directory);
    appendFileSync(path, serialized, 'utf-8');
  }
}

export function readJsonLines<T>(
  path: string,
  normalize: JsonLineNormalizer<T>,
  opts: ReadJsonLinesOptions = {},
): ReadJsonLinesResult<T> {
  if (!existsSync(path)) {
    return { entries: [], skipped: 0, corrupt: 0 };
  }

  const raw = readFileSync(path, 'utf-8');
  if (raw.trim().length === 0) {
    return { entries: [], skipped: 0, corrupt: 0 };
  }

  const entries: T[] = [];
  let skipped = 0;
  let corrupt = 0;

  raw.split('\n').forEach((rawLine, index) => {
    const line = rawLine.trim();
    if (line.length === 0) return;

    const context: ReadJsonLineContext = {
      path,
      line: index + 1,
      rawLine,
    };

    try {
      const entry = normalize(JSON.parse(line) as unknown, context);
      if (entry === null) {
        skipped += 1;
        return;
      }
      entries.push(entry);
    } catch (error) {
      corrupt += 1;
      const errorContext: ReadJsonLineErrorContext = { ...context, error };
      if (opts.onError) {
        opts.onError(errorContext);
        return;
      }
      if (opts.warnLabel) {
        log.warn(opts.warnLabel, {
          path,
          line: context.line,
          error: String(error),
        });
      }
    }
  });

  return { entries, skipped, corrupt };
}

export interface ShardSessionMemorySyncAuditJsonlEntry {
  timestamp: number;
  shardId: string;
  syncClass: 'transcript_fact' | 'derived_memory' | 'runtime_state';
  direction: 'prime_to_shard' | 'shard_to_prime';
  authority: 'prime' | 'shard' | 'runtime';
  operation: string;
  sourceId: string;
  targetId: string;
  idempotencyKey: string;
  decision: 'ALLOW' | 'DENY';
  reason: string;
}

export function appendShardSessionMemorySyncAudit(
  path: string,
  entry: ShardSessionMemorySyncAuditJsonlEntry,
): void {
  appendJsonLine(path, entry);
}
