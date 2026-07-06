// ── Tool-surface conformance result store ──
//
// Writes the latest run atomically (temp + rename) and keeps a bounded JSONL
// history of the last runs. The latest file is a stable cross-workstream
// contract read by another workstream; keep its schema exactly as defined in
// types.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from '../../../shared/utils/fs.js';
import {
  resolveToolConformanceHistoryPath,
  resolveToolConformanceLatestPath,
} from '../../../persistence/layout.js';
import type { ToolConformanceRunResult } from './types.js';

/** Maximum number of runs retained in the history JSONL file. */
export const TOOL_CONFORMANCE_HISTORY_LIMIT = 20;

function atomicWriteText(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmpPath = `${path}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
  try {
    writeFileSync(tmpPath, body, 'utf-8');
    renameSync(tmpPath, path);
  } catch (error) {
    try {
      unlinkSync(tmpPath);
    } catch {
      // Best-effort cleanup only.
    }
    throw error;
  }
}

function appendBoundedHistory(historyPath: string, result: ToolConformanceRunResult): void {
  const existingLines = existsSync(historyPath)
    ? readFileSync(historyPath, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean)
    : [];
  existingLines.push(JSON.stringify(result));
  const bounded = existingLines.slice(-TOOL_CONFORMANCE_HISTORY_LIMIT);
  atomicWriteText(historyPath, `${bounded.join('\n')}\n`);
}

/**
 * Persist a conformance run: atomic latest write plus a bounded history append.
 * The latest write happens first so a failed history append cannot leave the
 * latest file missing.
 */
export function writeToolConformanceResult(
  systemDataDir: string,
  result: ToolConformanceRunResult,
): void {
  writeJsonAtomic(resolveToolConformanceLatestPath(systemDataDir), result);
  appendBoundedHistory(resolveToolConformanceHistoryPath(systemDataDir), result);
}

/** Read the latest persisted run, or null if none exists / is unreadable. */
export function readToolConformanceLatest(systemDataDir: string): ToolConformanceRunResult | null {
  const path = resolveToolConformanceLatestPath(systemDataDir);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ToolConformanceRunResult;
  return parsed;
}
