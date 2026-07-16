// ── Post-rollout validation verdict store ──
//
// Persists the latest post-rollout validation verdict atomically (temp + rename)
// plus a bounded JSONL history. The latest file is the stable cross-workstream
// contract the Helm-rollback surface (x5rt.8) reads to decide whether a freshly
// rolled companion container proved itself healthy — it must be written on BOTH
// the healthy and unhealthy paths so the rollback decision always has a verdict.
// Keep the schema exactly as defined in kube-post-rollout-validation.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { writeJsonAtomic } from '../../shared/utils/fs.js';
import {
  resolvePostRolloutValidationHistoryPath,
  resolvePostRolloutValidationLatestPath,
} from '../../persistence/layout.js';
import type { PostRolloutValidationRecord } from './kube-post-rollout-validation.js';

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

function appendBoundedHistory(
  historyPath: string,
  record: PostRolloutValidationRecord,
  historyLimit: number,
): void {
  const existingLines = existsSync(historyPath)
    ? readFileSync(historyPath, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean)
    : [];
  existingLines.push(JSON.stringify(record));
  const bounded = existingLines.slice(-historyLimit);
  atomicWriteText(historyPath, `${bounded.join('\n')}\n`);
}

/**
 * Persist a post-rollout validation verdict: atomic latest write plus a bounded
 * history append. The latest write happens first so a failed history append
 * cannot leave the latest file missing.
 */
export function writePostRolloutValidationVerdict(
  systemDataDir: string,
  record: PostRolloutValidationRecord,
  historyLimit: number,
): void {
  if (!Number.isSafeInteger(historyLimit) || historyLimit <= 0) {
    throw new Error('Post-rollout validation history limit must be a positive integer.');
  }
  writeJsonAtomic(resolvePostRolloutValidationLatestPath(systemDataDir), record);
  appendBoundedHistory(
    resolvePostRolloutValidationHistoryPath(systemDataDir),
    record,
    historyLimit,
  );
}

/** Read the latest persisted verdict, or null if none exists. */
export function readPostRolloutValidationLatest(
  systemDataDir: string,
): PostRolloutValidationRecord | null {
  const path = resolvePostRolloutValidationLatestPath(systemDataDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as PostRolloutValidationRecord;
}
