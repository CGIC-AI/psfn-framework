import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { BackupRuntimeConfig } from './config.js';
import { runDatabaseIntegrityCheck } from './startup-checks.js';
import { applyTieredRetention, type TieredRetentionResult } from './retention.js';

const log = createComponentLogger('BackupService');

export const SCHEDULED_BACKUP_TASK_ID = 'scheduled-backup';
export const SCHEDULED_BACKUP_TASK_NAME = 'Session + SQLite backup';

export interface BackupRunOptions {
  db: Database.Database;
  databasePath: string;
  sessionsDir: string;
  backupRootDir: string;
  /** @deprecated Use maxRotatingBackups */
  retentionCount?: number;
  maxRotatingBackups?: number;
  maxWeeklyBackups?: number;
  maxMonthlyBackups?: number;
  /** Path to memories.jsonl (L0 memory journal); if set, included in backup. */
  memoriesJournalPath?: string;
  /** Path to the current character card JSON; if set, included in backup. */
  characterCardPath?: string;
  /** Path to the character card history JSONL; if set, included in backup. */
  characterCardHistoryPath?: string;
  /** When non-empty, mirror the completed backup to this directory. */
  mirrorDir?: string;
  verifyRestore?: boolean;
  now?: () => number;
}

export interface BackupRestoreVerificationOptions {
  databaseBackupPath: string;
  sessionSnapshotDir: string;
  expectedSessionFiles?: string[];
  restoreScratchRootDir?: string;
  cleanupRestoreDir?: boolean;
}

export interface BackupRestoreVerificationResult {
  restoreDir: string;
  restoredDatabasePath: string;
  restoredSessionDir: string;
  restoredSessionFiles: string[];
  integrityDetails: string[];
  cleanupRestoreDir: boolean;
}

export interface BackupRunResult {
  backupDir: string;
  databaseBackupPath: string;
  sessionSnapshotDir: string;
  copiedSessionFiles: string[];
  prunedBackupDirs: string[];
  restoreVerification?: BackupRestoreVerificationResult;
  tieredRetention?: TieredRetentionResult;
  mirrorDir?: string;
}

export interface RegisterScheduledBackupTaskOptions {
  scheduler: Scheduler;
  db: Database.Database;
  databasePath: string;
  sessionsDir: string;
  memoriesJournalPath?: string;
  characterCardPath?: string;
  characterCardHistoryPath?: string;
  config: BackupRuntimeConfig;
  skipFirstRun?: boolean;
}

function formatTimestamp(timestampMs: number): string {
  const iso = new Date(timestampMs).toISOString();
  return iso.replace(/[-:]/g, '').replace('.', '');
}

function copySessionSnapshotFiles(
  sourceDir: string,
  destinationDir: string,
): string[] {
  mkdirSync(destinationDir, { recursive: true });
  const files = listSessionSnapshotFiles(sourceDir);

  for (const file of files) {
    copyFileSync(join(sourceDir, file), join(destinationDir, file));
  }
  return files;
}

function listSessionSnapshotFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

function copyOptionalBackupFile(
  sourcePath: string | undefined,
  destinationDir: string,
): void {
  const normalizedPath = sourcePath?.trim();
  if (!normalizedPath || !existsSync(normalizedPath)) return;
  mkdirSync(destinationDir, { recursive: true });
  copyFileSync(normalizedPath, join(destinationDir, basename(normalizedPath)));
}

/**
 * Mirrors a completed backup directory to a secondary location.
 * The destination is `<mirrorRoot>/<backupDirName>`.
 * Uses recursive cpSync with overwrite so incremental mirrors are safe.
 */
function mirrorBackupToDir(backupDir: string, mirrorRootDir: string): void {
  const dirName = basename(backupDir);
  const mirrorTarget = join(mirrorRootDir, dirName);
  mkdirSync(mirrorTarget, { recursive: true });
  cpSync(backupDir, mirrorTarget, { recursive: true, force: true });
}

export function verifyBackupRestore(
  options: BackupRestoreVerificationOptions,
): BackupRestoreVerificationResult {
  if (!existsSync(options.databaseBackupPath)) {
    throw new Error(`Backup database snapshot missing: ${options.databaseBackupPath}`);
  }
  if (!existsSync(options.sessionSnapshotDir)) {
    throw new Error(`Backup session snapshot directory missing: ${options.sessionSnapshotDir}`);
  }

  const expectedSessionFiles = (
    options.expectedSessionFiles
      ? [...options.expectedSessionFiles]
      : listSessionSnapshotFiles(options.sessionSnapshotDir)
  ).sort((a, b) => a.localeCompare(b));
  const restoreScratchRootDir = options.restoreScratchRootDir?.trim() || tmpdir();
  const cleanupRestoreDir = options.cleanupRestoreDir ?? true;
  const restoreDir = mkdtempSync(join(restoreScratchRootDir, 'psfn-backup-restore-'));
  const restoredDatabasePath = join(restoreDir, 'database', basename(options.databaseBackupPath));
  const restoredSessionDir = join(restoreDir, 'sessions');
  const restoredSessionFiles: string[] = [];

  try {
    mkdirSync(join(restoreDir, 'database'), { recursive: true });
    mkdirSync(restoredSessionDir, { recursive: true });

    copyFileSync(options.databaseBackupPath, restoredDatabasePath);

    for (const file of expectedSessionFiles) {
      const sourcePath = join(options.sessionSnapshotDir, file);
      if (!existsSync(sourcePath)) {
        throw new Error(`Expected session snapshot missing from backup: ${sourcePath}`);
      }
      copyFileSync(sourcePath, join(restoredSessionDir, file));
      restoredSessionFiles.push(file);
    }

    const restoredDb = new BetterSqlite3(restoredDatabasePath, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const integrity = runDatabaseIntegrityCheck(restoredDb);
      return {
        restoreDir,
        restoredDatabasePath,
        restoredSessionDir,
        restoredSessionFiles,
        integrityDetails: integrity.details,
        cleanupRestoreDir,
      };
    } finally {
      restoredDb.close();
    }
  } finally {
    if (cleanupRestoreDir && existsSync(restoreDir)) {
      rmSync(restoreDir, { recursive: true, force: true });
    }
  }
}

export async function runBackupCycle(
  options: BackupRunOptions,
): Promise<BackupRunResult> {
  const now = options.now ?? (() => Date.now());
  const timestamp = formatTimestamp(now());
  const backupDir = join(options.backupRootDir, timestamp);
  const databaseBackupPath = join(
    backupDir,
    'database',
    basename(options.databasePath),
  );
  const sessionSnapshotDir = join(backupDir, 'sessions');

  mkdirSync(join(backupDir, 'database'), { recursive: true });
  await options.db.backup(databaseBackupPath);
  const copiedSessionFiles = copySessionSnapshotFiles(
    options.sessionsDir,
    sessionSnapshotDir,
  );

  // Back up the L0 memories journal (notes/memories.jsonl) if available.
  const { memoriesJournalPath } = options;
  if (memoriesJournalPath && existsSync(memoriesJournalPath)) {
    const notesDir = join(backupDir, 'notes');
    mkdirSync(notesDir, { recursive: true });
    copyFileSync(memoriesJournalPath, join(notesDir, basename(memoriesJournalPath)));
  }

  const companionDir = join(backupDir, 'companion');
  copyOptionalBackupFile(options.characterCardPath, companionDir);
  copyOptionalBackupFile(options.characterCardHistoryPath, companionDir);

  // Apply tiered GFS retention (or fall back to flat count if tiering not configured).
  const maxRotating = options.maxRotatingBackups
    ?? options.retentionCount
    ?? 9;
  const maxWeekly = options.maxWeeklyBackups ?? 2;
  const maxMonthly = options.maxMonthlyBackups ?? 1;

  const tieredRetention = applyTieredRetention(options.backupRootDir, {
    maxRotatingBackups: maxRotating,
    maxWeeklyBackups: maxWeekly,
    maxMonthlyBackups: maxMonthly,
  });

  // Mirror to secondary location if configured.
  const effectiveMirrorDir = options.mirrorDir?.trim();
  let mirrorDir: string | undefined;
  if (effectiveMirrorDir && existsSync(backupDir)) {
    try {
      mkdirSync(effectiveMirrorDir, { recursive: true });
      mirrorBackupToDir(backupDir, effectiveMirrorDir);
      // Also sync pruned dirs: remove from mirror if they no longer exist locally.
      for (const pruned of tieredRetention.prunedBackupDirs) {
        const mirrorPruned = join(effectiveMirrorDir, basename(pruned));
        if (existsSync(mirrorPruned)) {
          rmSync(mirrorPruned, { recursive: true, force: true });
        }
      }
      mirrorDir = effectiveMirrorDir;
    } catch (mirrorErr) {
      log.warn('Backup mirror failed — local backup is intact', {
        mirrorDir: effectiveMirrorDir,
        error: String(mirrorErr),
      });
    }
  }

  const restoreVerification = options.verifyRestore
    ? verifyBackupRestore({
      databaseBackupPath,
      sessionSnapshotDir,
      expectedSessionFiles: copiedSessionFiles,
      cleanupRestoreDir: true,
    })
    : undefined;

  return {
    backupDir,
    databaseBackupPath,
    sessionSnapshotDir,
    copiedSessionFiles,
    prunedBackupDirs: tieredRetention.prunedBackupDirs,
    restoreVerification,
    tieredRetention,
    mirrorDir,
  };
}

export function registerScheduledBackupTask(
  options: RegisterScheduledBackupTaskOptions,
): void {
  options.scheduler.register(
    {
      id: SCHEDULED_BACKUP_TASK_ID,
      name: SCHEDULED_BACKUP_TASK_NAME,
      type: 'every',
      intervalMs: options.config.intervalMs,
      handler: async () => {
        const result = await runBackupCycle({
          db: options.db,
          databasePath: options.databasePath,
          sessionsDir: options.sessionsDir,
          memoriesJournalPath: options.memoriesJournalPath,
          characterCardPath: options.characterCardPath,
          characterCardHistoryPath: options.characterCardHistoryPath,
          backupRootDir: options.config.rootDir,
          maxRotatingBackups: options.config.maxRotatingBackups,
          maxWeeklyBackups: options.config.maxWeeklyBackups,
          maxMonthlyBackups: options.config.maxMonthlyBackups,
          mirrorDir: options.config.mirrorDir,
          verifyRestore: options.config.verifyRestore,
        });

        log.info('Scheduled backup completed', {
          backupDir: result.backupDir,
          copiedSessionFiles: result.copiedSessionFiles.length,
          prunedBackupDirs: result.prunedBackupDirs.length,
          weeklySlots: result.tieredRetention?.weeklyCount,
          monthlySlots: result.tieredRetention?.monthlyCount,
          mirrored: Boolean(result.mirrorDir),
          restoreVerified: Boolean(result.restoreVerification),
          restoreIntegrity: result.restoreVerification?.integrityDetails.join('; '),
        });
      },
      state: 'idle',
    },
    { skipFirstRun: options.skipFirstRun ?? true },
  );
}
