import type Database from 'better-sqlite3';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import { createComponentLogger } from '../logger.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import type { BackupRuntimeConfig } from './config.js';

const log = createComponentLogger('BackupService');

export const SCHEDULED_BACKUP_TASK_ID = 'scheduled-backup';
export const SCHEDULED_BACKUP_TASK_NAME = 'Session + SQLite backup';

export interface BackupRunOptions {
  db: Database.Database;
  databasePath: string;
  sessionsDir: string;
  backupRootDir: string;
  retentionCount: number;
  now?: () => number;
}

export interface BackupRunResult {
  backupDir: string;
  databaseBackupPath: string;
  sessionSnapshotDir: string;
  copiedSessionFiles: string[];
  prunedBackupDirs: string[];
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
  if (!existsSync(sourceDir)) return [];

  const files = readdirSync(sourceDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));

  for (const file of files) {
    copyFileSync(join(sourceDir, file), join(destinationDir, file));
  }
  return files;
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

  return {
    backupDir,
    databaseBackupPath,
    sessionSnapshotDir,
    copiedSessionFiles,
    prunedBackupDirs,
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
        });

        log.info('Scheduled backup completed', {
          backupDir: result.backupDir,
          copiedSessionFiles: result.copiedSessionFiles.length,
          prunedBackupDirs: result.prunedBackupDirs.length,
        });
      },
      state: 'idle',
    },
    { skipFirstRun: options.skipFirstRun ?? true },
  );
}
