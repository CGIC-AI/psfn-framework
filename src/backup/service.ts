import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { createComponentLogger } from '../logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { BackupRuntimeConfig } from './config.js';
import { runDatabaseIntegrityCheck } from './startup-checks.js';

const log = createComponentLogger('BackupService');

export const SCHEDULED_BACKUP_TASK_ID = 'scheduled-backup';
export const SCHEDULED_BACKUP_TASK_NAME = 'Session + SQLite backup';

export interface BackupRunOptions {
  db: Database.Database;
  databasePath: string;
  sessionsDir: string;
  backupRootDir: string;
  retentionCount: number;
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
}

export interface RegisterScheduledBackupTaskOptions {
  scheduler: Scheduler;
  db: Database.Database;
  databasePath: string;
  sessionsDir: string;
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

function pruneBackups(
  backupRootDir: string,
  retentionCount: number,
): string[] {
  const directories = readdirSync(backupRootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  if (directories.length <= retentionCount) return [];

  const remove = directories.slice(0, directories.length - retentionCount);
  const removedPaths: string[] = [];
  for (const directory of remove) {
    const path = join(backupRootDir, directory);
    rmSync(path, { recursive: true, force: true });
    removedPaths.push(path);
  }
  return removedPaths;
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

  const prunedBackupDirs = pruneBackups(
    options.backupRootDir,
    options.retentionCount,
  );
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
    prunedBackupDirs,
    restoreVerification,
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
          backupRootDir: options.config.rootDir,
          retentionCount: options.config.retentionCount,
          verifyRestore: options.config.verifyRestore,
        });

        log.info('Scheduled backup completed', {
          backupDir: result.backupDir,
          copiedSessionFiles: result.copiedSessionFiles.length,
          prunedBackupDirs: result.prunedBackupDirs.length,
          restoreVerified: Boolean(result.restoreVerification),
          restoreIntegrity: result.restoreVerification?.integrityDetails.join('; '),
        });
      },
      state: 'idle',
    },
    { skipFirstRun: options.skipFirstRun ?? true },
  );
}
