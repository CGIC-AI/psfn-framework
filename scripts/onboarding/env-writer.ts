// ── .env bootstrap writer (psfn-framework-wckv.1.2) ──
// Secrets and process/layout wiring belong in .env, never in the JSON owner
// files. This module merges new entries into an existing .env preserving
// comments and ordering, upserting matched keys. Values are never logged.

import { existsSync, readFileSync } from 'node:fs';
import { writeFileDurableAtomicSync } from '../../src/shared/utils/fs.js';

export interface EnvEntry {
  envName: string;
  value: string;
  /** Optional comment written directly above a newly-added key. */
  comment?: string;
  /** Do not rotate an already-present value when merging. */
  preserveExisting?: boolean;
  /** Remove this key if present and do not append it. */
  remove?: boolean;
}

const ENV_LINE = /^\s*([A-Z][A-Z0-9_]*)\s*=/u;

/**
 * Merge entries into existing .env text. Existing keys are updated in place;
 * new keys are appended (with their comment). Returns the full file text.
 * Pure: takes the current text and returns the next text.
 */
export function mergeEnvContent(currentText: string, entries: readonly EnvEntry[]): string {
  const lines = currentText.length > 0 ? currentText.split('\n') : [];
  const remaining = new Map(entries.map((entry) => [entry.envName, entry]));

  const nextLines = lines.flatMap((line) => {
    const match = ENV_LINE.exec(line);
    if (!match) return [line];
    const key = match[1];
    const entry = remaining.get(key);
    if (!entry) return [line];
    remaining.delete(key);
    if (entry.remove) return [];
    if (entry.preserveExisting) return [line];
    return [`${key}=${serializeValue(entry.value)}`];
  });

  const additions: string[] = [];
  for (const entry of entries) {
    if (!remaining.has(entry.envName) || entry.remove) continue;
    if (entry.comment) additions.push(`# ${entry.comment}`);
    additions.push(`${entry.envName}=${serializeValue(entry.value)}`);
  }

  if (additions.length > 0) {
    // Ensure a separating blank line when appending to a non-empty file.
    while (nextLines.length > 0 && nextLines[nextLines.length - 1].trim() === '') {
      nextLines.pop();
    }
    if (nextLines.length > 0) nextLines.push('');
    nextLines.push(...additions);
  }

  const body = nextLines.join('\n');
  return body.endsWith('\n') || body.length === 0 ? body : `${body}\n`;
}

/**
 * Quote a value only when it needs it (whitespace or shell-special chars). Keeps
 * plain keys unquoted so the file stays diff-friendly.
 */
function serializeValue(value: string): string {
  if (value === '') return '';
  if (/^[A-Za-z0-9._:\/@+-]+$/u.test(value)) return value;
  // Wrap in double quotes and escape embedded quotes/backslashes.
  return `"${value.replace(/([\\"])/gu, '\\$1')}"`;
}

/** Read current .env text (empty string when absent). */
export function readEnvText(envPath: string): string {
  return existsSync(envPath) ? readFileSync(envPath, 'utf-8') : '';
}

/** Merge entries into the .env at envPath and write atomically+durably. */
export function commitEnv(envPath: string, entries: readonly EnvEntry[]): void {
  const next = mergeEnvContent(readEnvText(envPath), entries);
  writeFileDurableAtomicSync(envPath, next);
}
