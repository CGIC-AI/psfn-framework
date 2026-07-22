// Durable state that lives at the root of a backup tree: the writability
// contract every lane asserts before it arms itself, and the scheduling
// watermark that survives process restarts.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { writeJsonAtomic } from '../../shared/utils/fs.js';

const log = createComponentLogger('BackupRoot');

export type BackupRootProbeOperation = 'create' | 'write' | 'remove';

/**
 * Raised when a configured backup root cannot actually hold artifacts.
 *
 * Backup lanes assert writability before announcing themselves so a workload
 * whose backup volume was never mounted fails closed at startup instead of
 * logging the lane as enabled and then losing every scheduled cycle to EACCES
 * deep inside the scheduler, where nothing observes it.
 */
export class BackupRootNotWritableError extends Error {
  readonly rootDir: string;
  readonly operation: BackupRootProbeOperation;

  constructor(rootDir: string, operation: BackupRootProbeOperation, cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    const uid = process.getuid?.();
    super(
      `Backup root ${rootDir} is not writable: ${operation} probe failed`
      + `${uid === undefined ? '' : ` as uid ${uid}`} — ${reason}. `
      + 'The workload that owns this backup lane must mount a writable volume at '
      + 'this path (Helm: the runtime PVC "backups" subPath) or BACKUP_ROOT_DIR '
      + 'must point at one.',
      { cause },
    );
    this.name = 'BackupRootNotWritableError';
    this.rootDir = rootDir;
    this.operation = operation;
  }
}

/**
 * Proves the running process can create, write, and remove entries under
 * `rootDir`, throwing {@link BackupRootNotWritableError} otherwise.
 *
 * Only a probe write is honest here: an unmounted subPath leaves a directory
 * that exists and lists fine under a root-owned parent while the runtime uid
 * cannot create a single entry in it.
 */
export function assertBackupRootWritable(rootDir: string): void {
  const resolved = resolve(rootDir);
  try {
    mkdirSync(resolved, { recursive: true });
  } catch (error) {
    throw new BackupRootNotWritableError(resolved, 'create', error);
  }
  const probePath = join(
    resolved,
    `.psfn-backup-writable-probe-${process.pid}-${Date.now()}`,
  );
  try {
    writeFileSync(probePath, '', { flag: 'wx' });
  } catch (error) {
    throw new BackupRootNotWritableError(resolved, 'write', error);
  }
  try {
    rmSync(probePath, { force: true });
  } catch (error) {
    throw new BackupRootNotWritableError(resolved, 'remove', error);
  }
}

/**
 * Scheduling watermark for the gateway-owned fleet-auth consistent backup lane.
 *
 * The lane runs on a multi-hour interval held in process memory, so a pod that
 * never lives a full interval would never fire a cycle and would leave no trace
 * of having skipped one. Persisting the watermark in the backup root — beside
 * the artifacts, on the same volume, so a replaced volume correctly resets it —
 * makes the cadence survive restarts.
 *
 * It is a plain file at the root, which tiered retention never touches: pruning
 * only considers timestamp-named *directories* (`applyTieredRetention`).
 */
export const FLEET_AUTH_BACKUP_WATERMARK_NAME = 'fleet-auth-backup-watermark.json';
export const FLEET_AUTH_BACKUP_WATERMARK_SCHEMA_VERSION = 1;

export interface FleetAuthBackupWatermark {
  schemaVersion: number;
  /** ISO timestamp a cycle last *started*, whether or not it completed. */
  lastAttemptStartedAt: string;
  /** ISO timestamp a cycle last published a verified artifact. */
  lastCompletedAt?: string;
  /** Artifact directory the last completed cycle published. */
  lastBackupDir?: string;
}

export function readFleetAuthBackupWatermark(
  rootDir: string,
): FleetAuthBackupWatermark | null {
  const path = join(rootDir, FLEET_AUTH_BACKUP_WATERMARK_NAME);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<FleetAuthBackupWatermark>;
    if (typeof parsed.lastAttemptStartedAt !== 'string') {
      throw new Error('lastAttemptStartedAt is missing or not a string');
    }
    return {
      schemaVersion: typeof parsed.schemaVersion === 'number'
        ? parsed.schemaVersion
        : FLEET_AUTH_BACKUP_WATERMARK_SCHEMA_VERSION,
      lastAttemptStartedAt: parsed.lastAttemptStartedAt,
      ...(typeof parsed.lastCompletedAt === 'string'
        ? { lastCompletedAt: parsed.lastCompletedAt }
        : {}),
      ...(typeof parsed.lastBackupDir === 'string'
        ? { lastBackupDir: parsed.lastBackupDir }
        : {}),
    };
  } catch (error) {
    // A damaged watermark must not brick startup, and the safe direction is a
    // catch-up cycle: reporting "no watermark" makes the lane run once now and
    // rewrite the file. Erring the other way would suppress backups silently.
    log.warn('Fleet auth backup watermark is unreadable — scheduling a catch-up cycle', {
      path,
      error: String(error),
    });
    return null;
  }
}

export function writeFleetAuthBackupWatermark(
  rootDir: string,
  watermark: Omit<FleetAuthBackupWatermark, 'schemaVersion'>,
): FleetAuthBackupWatermark {
  const record: FleetAuthBackupWatermark = {
    schemaVersion: FLEET_AUTH_BACKUP_WATERMARK_SCHEMA_VERSION,
    ...watermark,
  };
  writeJsonAtomic(join(rootDir, FLEET_AUTH_BACKUP_WATERMARK_NAME), record);
  return record;
}

/**
 * Epoch (ms) the lane last cycled, or `null` when it never has.
 *
 * The *attempt* stamp counts, not only the completion: that is what bounds a
 * crash-looping pod to one heavy consistent backup per interval. A watermark
 * ahead of the clock (host skew, a volume restored from elsewhere) is clamped
 * to now rather than suppressing the lane until the clock catches up.
 */
export function lastFleetAuthBackupCycleAt(
  watermark: FleetAuthBackupWatermark | null,
  nowMs: number,
): number | null {
  if (!watermark) return null;
  const stamps = [watermark.lastAttemptStartedAt, watermark.lastCompletedAt]
    .map(value => (value === undefined ? Number.NaN : Date.parse(value)))
    .filter(value => Number.isFinite(value));
  if (stamps.length === 0) return null;
  return Math.min(Math.max(...stamps), nowMs);
}
