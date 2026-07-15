// ── Kube Helm rollback record store ──
//
// Persists the latest Helm rollback action durably (fsync + dirsync via
// writeFileDurableAtomicSync) plus a bounded JSONL history. The history is the
// ACT-ONCE ledger the automatic rollback surface (x5rt.8) reads to guarantee it
// never rolls back twice away from the same failed revision: after a rollback,
// the post-rollout verdict file still holds the FAILED verdict of the
// rolled-back-from revision, so the auto surface keys its decision on
// (release, fromHelmRevision) and consults this ledger before acting again.
//
// Durability is load-bearing here: the ledger is the loop-prevention anchor, so
// a power-loss window between `helm rollback` and disk commit must not be able
// to drop the just-written act-once entry. Both writes fsync the file and the
// directory before returning. System-owned/trusted: reads use raw JSON.parse and
// throw on corruption (fail-safe), never silently coerce.

import { existsSync, readFileSync } from 'node:fs';
import { writeFileDurableAtomicSync } from '../../shared/utils/fs.js';
import { isRecord } from '../../shared/utils/types.js';
import {
  resolveKubeRollbackHistoryPath,
  resolveKubeRollbackLatestPath,
} from '../../persistence/layout.js';

/** Maximum number of rollback records retained in the history JSONL file. */
export const KUBE_ROLLBACK_HISTORY_LIMIT = 50;

export const KUBE_ROLLBACK_RECORD_SCHEMA_VERSION = 1 as const;

export interface KubeRollbackRecord {
  schemaVersion: typeof KUBE_ROLLBACK_RECORD_SCHEMA_VERSION;
  namespace: string;
  release: string;
  /** Whether the operator requested this (manual) or the safety net fired it (automatic). */
  trigger: 'manual' | 'automatic';
  /**
   * The Helm revision the rollback moved AWAY from (the failed revision). Present
   * for automatic rollbacks (bound from the post-rollout verdict) and drives the
   * act-once ledger. Optional for a manual rollback where the live revision is
   * whatever Helm currently reports.
   */
  fromHelmRevision?: number;
  /** Source commit of the failed revision, when known (automatic path binds it). */
  fromSourceCommit?: string;
  /** The Helm revision the rollback targeted (rolled back TO). */
  targetHelmRevision: number;
  /** The new Helm revision Helm created to enact the rollback, when the command succeeded. */
  resultingHelmRevision?: number;
  /** Operator-provided reason (manual) or the derived automatic reason. */
  reason: string;
  /** Ids of the required post-rollout checks that failed (automatic path). */
  failedChecks?: string[];
  /** Post-rollback readiness/validation outcome. */
  validationResult: 'passed' | 'failed' | 'not_run';
  /** Whether the rollback command itself completed and the release came back ready. */
  outcome: 'succeeded' | 'failed';
  startedAt: number;
  completedAt: number;
  /** Short, secret-free human detail (escalation reason on failure). */
  detail?: string;
}

function appendBoundedHistory(historyPath: string, record: KubeRollbackRecord): void {
  const existingLines = existsSync(historyPath)
    ? readFileSync(historyPath, 'utf-8').split('\n').map(line => line.trim()).filter(Boolean)
    : [];
  existingLines.push(JSON.stringify(record));
  const bounded = existingLines.slice(-KUBE_ROLLBACK_HISTORY_LIMIT);
  writeFileDurableAtomicSync(historyPath, `${bounded.join('\n')}\n`);
}

/**
 * Persist a rollback action: durable latest write plus a bounded history append.
 * Both writes fsync the file and its directory (writeFileDurableAtomicSync) so a
 * power-loss window cannot drop the just-written act-once entry. The latest write
 * happens first so a failed history append cannot leave the latest file missing.
 */
export function writeKubeRollbackRecord(
  systemDataDir: string,
  record: KubeRollbackRecord,
): void {
  writeFileDurableAtomicSync(
    resolveKubeRollbackLatestPath(systemDataDir),
    `${JSON.stringify(record, null, 2)}\n`,
  );
  appendBoundedHistory(resolveKubeRollbackHistoryPath(systemDataDir), record);
}

/** Read the latest persisted rollback record, or null if none exists. */
export function readKubeRollbackLatest(
  systemDataDir: string,
): KubeRollbackRecord | null {
  const path = resolveKubeRollbackLatestPath(systemDataDir);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf-8')) as KubeRollbackRecord;
}

/**
 * Read the bounded rollback history (oldest first). Corrupt lines throw
 * (fail-safe) rather than being silently skipped — the act-once ledger must not
 * quietly lose an entry that would otherwise prevent a rollback loop.
 */
export function readKubeRollbackHistory(
  systemDataDir: string,
): KubeRollbackRecord[] {
  const path = resolveKubeRollbackHistoryPath(systemDataDir);
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf-8')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => JSON.parse(line) as KubeRollbackRecord);
}

/**
 * Act-once predicate: has a rollback already been recorded that moved away from
 * `fromHelmRevision` for this release? Scans the bounded history so a single
 * overwritten `latest` file cannot mask a prior rollback. Any record with a
 * matching (release, fromHelmRevision) counts, regardless of trigger or outcome
 * — a rollback that already fired (even one that failed and escalated) must not
 * be silently re-fired by the automatic surface.
 */
export function hasRolledBackFrom(
  history: readonly KubeRollbackRecord[],
  release: string,
  fromHelmRevision: number,
): boolean {
  return history.some(record =>
    isRecord(record)
    && record.release === release
    && typeof record.fromHelmRevision === 'number'
    && record.fromHelmRevision === fromHelmRevision);
}
