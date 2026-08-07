import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

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

/**
 * Append a single JSON object as one line to a JSONL file, creating the parent
 * directory if necessary. This lives in shared/utils so the telemetry ledgers
 * in shared/ can persist without importing upward into persistence/.
 */
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
