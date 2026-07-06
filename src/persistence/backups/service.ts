import { execFile } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { createComponentLogger } from '../../shared/logger.js';
import { recordBackupDiagnosticOutcome } from '../../shared/diagnostics/runtime-diagnostics.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import {
  captureCompanionTree,
  captureWorkspaceTree,
  verifyCompanionTreeSnapshot,
  verifyWorkspaceTreeSnapshot,
  type CompanionTreeCaptureResult,
  type CompanionTreeVerificationResult,
  type WorkspaceTreeCaptureResult,
  type WorkspaceTreeVerificationResult,
} from './companion-tree.js';
import {
  assertEncryptedBackupPackage,
  encryptBackupDirectory,
  type BackupEncryptionRuntimeConfig,
  type EncryptedBackupPackageResult,
} from './encryption.js';
import {
  verifyPostgresDumpRestore,
  type PostgresRestoreVerificationResult,
} from './postgres-restore.js';
import {
  captureSystemConfigSnapshot,
  verifySystemConfigSnapshot,
  type SystemConfigSnapshotCaptureResult,
  type SystemConfigSnapshotVerificationResult,
} from './system-config-tree.js';
import type { BackupRuntimeConfig } from './config.js';
import { applyTieredRetention, type TieredRetentionResult } from './retention.js';

const log = createComponentLogger('BackupService');
const execFileAsync = promisify(execFile);
const PG_RESTORE_LIST_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

export const SCHEDULED_BACKUP_TASK_ID = 'scheduled-backup';
export const SCHEDULED_BACKUP_TASK_NAME = 'Session + database backup';

export interface BackupPostgresOptions {
  databaseUrl: string;
  /**
   * Dedicated scratch database for full restore verification. When set and
   * verifyRestore is enabled, every cycle restores the dump into this
   * database and asserts schema, pgvector, and critical-table fidelity.
   */
  restoreVerifyDatabaseUrl?: string;
  /** Override the pg_dump binary (defaults to `pg_dump` on PATH). */
  pgDumpBinary?: string;
  /** Override the pg_restore binary used for dump verification (defaults to `pg_restore` on PATH). */
  pgRestoreBinary?: string;
  /** Override the psql binary used for restore verification (defaults to `psql` on PATH). */
  psqlBinary?: string;
}

export interface BackupRunOptions {
  /** When set, a pg_dump custom-format archive of this database is captured. */
  postgres?: BackupPostgresOptions;
  /**
   * When set, the full companion-data file tree is captured with a per-file
   * hash manifest (sessions and backup targets excluded — sessions are
   * captured separately).
   */
  companionDataDir?: string;
  /**
   * Personal workspace root captured as a dedicated workspace-tree snapshot.
   * This is separate from DATA_DIR/systemDataDir/companionDataDir and includes
   * durable wiki/reference documents when configured.
   */
  workspacePath?: string;
  /** Additional paths excluded from the workspace-tree capture. */
  workspaceExcludePaths?: string[];
  /** Runtime roots that must not overlap workspacePath. */
  workspaceProtectedPaths?: string[];
  /** System-data root containing JSON owner files such as settings.json and models.json. */
  systemDataDir?: string;
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
  encryption?: BackupEncryptionRuntimeConfig;
  now?: () => number;
}

export interface PostgresDumpVerificationResult {
  dumpPath: string;
  tocEntryCount: number;
}

export interface BackupRunResult {
  backupDir: string;
  /** Present when a Postgres pg_dump archive was captured. */
  postgresDumpPath?: string;
  postgresDumpCaptured: boolean;
  sessionSnapshotDir: string;
  copiedSessionFiles: string[];
  prunedBackupDirs: string[];
  postgresDumpVerification?: PostgresDumpVerificationResult;
  postgresRestoreVerification?: PostgresRestoreVerificationResult;
  companionTree?: CompanionTreeCaptureResult;
  companionTreeVerification?: CompanionTreeVerificationResult;
  workspaceTree?: WorkspaceTreeCaptureResult;
  workspaceTreeVerification?: WorkspaceTreeVerificationResult;
  systemConfig?: SystemConfigSnapshotCaptureResult;
  systemConfigVerification?: SystemConfigSnapshotVerificationResult;
  l0JournalVerification?: { lineCount: number };
  encryptedBackup?: EncryptedBackupPackageResult;
  tieredRetention?: TieredRetentionResult;
  mirrorDir?: string;
}

export interface RegisterScheduledBackupTaskOptions {
  scheduler: Scheduler;
  postgres?: BackupPostgresOptions;
  companionDataDir?: string;
  workspacePath?: string;
  workspaceExcludePaths?: string[];
  workspaceProtectedPaths?: string[];
  systemDataDir?: string;
  sessionsDir: string;
  memoriesJournalPath?: string;
  characterCardPath?: string;
  characterCardHistoryPath?: string;
  config: BackupRuntimeConfig;
  skipFirstRun?: boolean;
  /** Invoked when a scheduled backup cycle fails, so the runtime can surface the failure. */
  onBackupFailure?: (error: unknown) => void;
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

function isSameOrSubpath(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path));
  return relativePath.length === 0 || (!relativePath.startsWith('..') && !isAbsolute(relativePath));
}

function assertWorkspaceBackupRootsDoNotOverlap(
  workspacePath: string,
  protectedPaths: readonly string[],
): void {
  for (const protectedPath of protectedPaths) {
    const trimmed = protectedPath.trim();
    if (!trimmed) continue;
    if (isSameOrSubpath(workspacePath, trimmed) || isSameOrSubpath(trimmed, workspacePath)) {
      throw new Error(
        `Workspace backup root (${workspacePath}) must not overlap protected runtime/backup path (${trimmed})`,
      );
    }
  }
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

function describeExecError(error: unknown): string {
  if (error && typeof error === 'object') {
    const execError = error as NodeJS.ErrnoException & { stderr?: string };
    if (execError.code === 'ENOENT') {
      return `binary not found (${execError.message})`;
    }
    const stderr = typeof execError.stderr === 'string' ? execError.stderr.trim() : '';
    if (stderr) {
      return `${execError.message}: ${stderr}`;
    }
  }
  return error instanceof Error ? error.message : String(error);
}

function verifyJsonlSnapshot(path: string): { lineCount: number } {
  const lines = readFileSync(path, 'utf-8').split('\n');
  let lineCount = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    try {
      JSON.parse(line);
    } catch {
      throw new Error(`L0 journal snapshot has invalid JSONL at ${path}:${index + 1}`);
    }
    lineCount += 1;
  }
  return { lineCount };
}

function postgresDumpFileName(databaseUrl: string): string {
  try {
    const databaseName = new URL(databaseUrl).pathname.replace(/^\//, '').trim();
    if (databaseName) {
      return `${databaseName.replace(/[^A-Za-z0-9._-]+/g, '-')}.dump`;
    }
  } catch {
    // Fall through to the generic name for non-URL connection strings.
  }
  return 'postgres.dump';
}

async function dumpPostgresDatabase(
  postgres: BackupPostgresOptions,
  databaseDir: string,
): Promise<string> {
  const binary = postgres.pgDumpBinary?.trim() || 'pg_dump';
  const dumpPath = join(databaseDir, postgresDumpFileName(postgres.databaseUrl));
  mkdirSync(databaseDir, { recursive: true });
  try {
    await execFileAsync(binary, [
      '--format=custom',
      '--no-password',
      `--file=${dumpPath}`,
      postgres.databaseUrl,
    ]);
  } catch (error) {
    throw new Error(`pg_dump failed: ${describeExecError(error)}`);
  }
  if (!existsSync(dumpPath) || statSync(dumpPath).size === 0) {
    throw new Error(`pg_dump produced no archive at ${dumpPath}`);
  }
  return dumpPath;
}

/**
 * Validates that a pg_dump custom-format archive is readable and non-trivial
 * by listing its table of contents. Full restore-into-scratch-database
 * fidelity verification is a separate concern (restore verification tooling).
 */
export async function verifyPostgresDumpArchive(
  dumpPath: string,
  pgRestoreBinary?: string,
): Promise<PostgresDumpVerificationResult> {
  const binary = pgRestoreBinary?.trim() || 'pg_restore';
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(binary, ['--list', dumpPath], {
      maxBuffer: PG_RESTORE_LIST_MAX_BUFFER_BYTES,
    }));
  } catch (error) {
    throw new Error(`pg_restore --list failed for ${dumpPath}: ${describeExecError(error)}`);
  }
  const tocEntryCount = stdout
    .split('\n')
    .filter(line => /^\d+;/.test(line.trim()))
    .length;
  if (tocEntryCount === 0) {
    throw new Error(`Postgres dump archive has no table-of-contents entries: ${dumpPath}`);
  }
  return { dumpPath, tocEntryCount };
}

export async function runBackupCycle(
  options: BackupRunOptions,
): Promise<BackupRunResult> {
  if (!options.postgres) {
    throw new Error('Backup requires Postgres dump configuration — refusing to capture a database-less backup');
  }

  const now = options.now ?? (() => Date.now());
  const timestamp = formatTimestamp(now());
  const finalBackupDir = join(options.backupRootDir, timestamp);
  const stagingRootDir = options.encryption
    ? mkdtempSync(join(tmpdir(), 'psfn-backup-stage-'))
    : undefined;
  const backupDir = stagingRootDir ? join(stagingRootDir, timestamp) : finalBackupDir;
  const databaseDir = join(backupDir, 'database');
  const sessionSnapshotDir = join(backupDir, 'sessions');
  const workspacePath = options.workspacePath?.trim();

  if (workspacePath) {
    assertWorkspaceBackupRootsDoNotOverlap(workspacePath, [
      options.backupRootDir,
      ...(options.mirrorDir?.trim() ? [options.mirrorDir.trim()] : []),
      options.sessionsDir,
      ...(options.companionDataDir?.trim() ? [options.companionDataDir.trim()] : []),
      ...(options.workspaceProtectedPaths ?? []),
    ]);
  }

  try {
    mkdirSync(databaseDir, { recursive: true });

    const postgresDumpPath = await dumpPostgresDatabase(options.postgres, databaseDir);

    const copiedSessionFiles = copySessionSnapshotFiles(
      options.sessionsDir,
      sessionSnapshotDir,
    );

    // Back up the L0 memories journal (notes/memories.jsonl) if available.
    const { memoriesJournalPath } = options;
    let memoriesJournalBackupPath: string | undefined;
    if (memoriesJournalPath && existsSync(memoriesJournalPath)) {
      const notesDir = join(backupDir, 'notes');
      mkdirSync(notesDir, { recursive: true });
      memoriesJournalBackupPath = join(notesDir, basename(memoriesJournalPath));
      copyFileSync(memoriesJournalPath, memoriesJournalBackupPath);
    }

    const companionDir = join(backupDir, 'companion');
    copyOptionalBackupFile(options.characterCardPath, companionDir);
    copyOptionalBackupFile(options.characterCardHistoryPath, companionDir);

    let companionTree: CompanionTreeCaptureResult | undefined;
    const companionDataDir = options.companionDataDir?.trim();
    if (companionDataDir) {
      companionTree = captureCompanionTree({
        companionDataDir,
        backupDir,
        excludePaths: [
          // Sessions get a dedicated first-class snapshot above.
          options.sessionsDir,
          // Never recurse into backup targets.
          options.backupRootDir,
          ...(options.mirrorDir?.trim() ? [options.mirrorDir.trim()] : []),
          'backups',
          // Runtime repair snapshots are recovery artifacts, not companion-authored state.
          'state/repair-backups',
        ],
        now,
      });
    }

    let workspaceTree: WorkspaceTreeCaptureResult | undefined;
    if (workspacePath) {
      workspaceTree = captureWorkspaceTree({
        workspacePath,
        backupDir,
        excludePaths: [
          options.backupRootDir,
          ...(options.mirrorDir?.trim() ? [options.mirrorDir.trim()] : []),
          ...(options.workspaceExcludePaths ?? []),
          ...(options.workspaceProtectedPaths ?? []),
        ],
        now,
      });
    }

    let systemConfig: SystemConfigSnapshotCaptureResult | undefined;
    const systemDataDir = options.systemDataDir?.trim();
    if (systemDataDir) {
      systemConfig = captureSystemConfigSnapshot({
        systemDataDir,
        backupDir,
        now,
      });
    }

    const postgresDumpVerification = options.verifyRestore && postgresDumpPath
      ? await verifyPostgresDumpArchive(postgresDumpPath, options.postgres.pgRestoreBinary)
      : undefined;

    const postgresRestoreVerification = options.verifyRestore
      && postgresDumpPath
      && options.postgres.restoreVerifyDatabaseUrl
      ? await verifyPostgresDumpRestore({
        dumpPath: postgresDumpPath,
        scratchDatabaseUrl: options.postgres.restoreVerifyDatabaseUrl,
        sourceDatabaseUrl: options.postgres.databaseUrl,
        psqlBinary: options.postgres.psqlBinary,
        pgRestoreBinary: options.postgres.pgRestoreBinary,
      })
      : undefined;

    const companionTreeVerification = options.verifyRestore && companionTree
      ? verifyCompanionTreeSnapshot(backupDir)
      : undefined;

    const workspaceTreeVerification = options.verifyRestore && workspaceTree
      ? verifyWorkspaceTreeSnapshot(backupDir)
      : undefined;

    const systemConfigVerification = options.verifyRestore && systemConfig
      ? verifySystemConfigSnapshot(backupDir)
      : undefined;

    const l0JournalVerification = options.verifyRestore && memoriesJournalBackupPath
      ? verifyJsonlSnapshot(memoriesJournalBackupPath)
      : undefined;

    let encryptedBackup: EncryptedBackupPackageResult | undefined;
    if (options.encryption) {
      encryptedBackup = await encryptBackupDirectory({
        sourceDir: backupDir,
        outputDir: finalBackupDir,
        encryption: options.encryption,
        now,
      });
      assertEncryptedBackupPackage(finalBackupDir);
    }

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
    if (effectiveMirrorDir && existsSync(finalBackupDir)) {
      try {
        mkdirSync(effectiveMirrorDir, { recursive: true });
        mirrorBackupToDir(finalBackupDir, effectiveMirrorDir);
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

    return {
      backupDir: finalBackupDir,
      ...(options.encryption ? {} : { postgresDumpPath }),
      postgresDumpCaptured: Boolean(postgresDumpPath),
      sessionSnapshotDir: options.encryption ? finalBackupDir : sessionSnapshotDir,
      copiedSessionFiles,
      prunedBackupDirs: tieredRetention.prunedBackupDirs,
      postgresDumpVerification,
      postgresRestoreVerification,
      companionTree,
      companionTreeVerification,
      workspaceTree,
      workspaceTreeVerification,
      systemConfig,
      systemConfigVerification,
      l0JournalVerification,
      encryptedBackup,
      tieredRetention,
      mirrorDir,
    };
  } finally {
    if (stagingRootDir && existsSync(stagingRootDir)) {
      rmSync(stagingRootDir, { recursive: true, force: true });
    }
  }
}

export function registerScheduledBackupTask(
  options: RegisterScheduledBackupTaskOptions,
): void {
  if (!options.postgres) {
    throw new Error('Scheduled backups require Postgres dump configuration');
  }

  options.scheduler.register(
    {
      id: SCHEDULED_BACKUP_TASK_ID,
      name: SCHEDULED_BACKUP_TASK_NAME,
      type: 'every',
      intervalMs: options.config.intervalMs,
      handler: async () => {
        let result: BackupRunResult;
        try {
          result = await runBackupCycle({
            postgres: options.postgres,
            companionDataDir: options.companionDataDir,
            workspacePath: options.workspacePath,
            workspaceExcludePaths: options.workspaceExcludePaths,
            workspaceProtectedPaths: options.workspaceProtectedPaths,
            systemDataDir: options.systemDataDir,
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
            encryption: options.config.encryption,
          });
        } catch (error) {
          const observedAt = Date.now();
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error('Scheduled backup failed', {
            error: errorMessage,
          });
          recordBackupDiagnosticOutcome({
            status: 'failure',
            observedAt,
            taskId: SCHEDULED_BACKUP_TASK_ID,
            taskName: SCHEDULED_BACKUP_TASK_NAME,
            message: errorMessage,
          });
          options.onBackupFailure?.(error);
          throw error;
        }

        recordBackupDiagnosticOutcome({
          status: 'success',
          taskId: SCHEDULED_BACKUP_TASK_ID,
          taskName: SCHEDULED_BACKUP_TASK_NAME,
          message: 'Scheduled backup completed',
          backupDir: result.backupDir,
          details: {
            postgresDumpCaptured: result.postgresDumpCaptured,
            copiedSessionFiles: result.copiedSessionFiles.length,
            prunedBackupDirs: result.prunedBackupDirs.length,
            mirrored: Boolean(result.mirrorDir),
            postgresRestoreVerified: Boolean(result.postgresRestoreVerification),
            encrypted: Boolean(result.encryptedBackup),
          },
        });
        log.info('Scheduled backup completed', {
          backupDir: result.backupDir,
          postgresDumpCaptured: result.postgresDumpCaptured,
          copiedSessionFiles: result.copiedSessionFiles.length,
          prunedBackupDirs: result.prunedBackupDirs.length,
          weeklySlots: result.tieredRetention?.weeklyCount,
          monthlySlots: result.tieredRetention?.monthlyCount,
          mirrored: Boolean(result.mirrorDir),
          postgresDumpTocEntries: result.postgresDumpVerification?.tocEntryCount,
          postgresRestoreVerified: Boolean(result.postgresRestoreVerification),
          postgresRestoredTables: result.postgresRestoreVerification?.restoredTableCount,
          companionTreeFiles: result.companionTree?.fileCount,
          companionTreeBytes: result.companionTree?.totalBytes,
          companionTreeVerifiedFiles: result.companionTreeVerification?.verifiedFileCount,
          workspaceTreeFiles: result.workspaceTree?.fileCount,
          workspaceTreeBytes: result.workspaceTree?.totalBytes,
          workspaceTreeVerifiedFiles: result.workspaceTreeVerification?.verifiedFileCount,
          systemConfigFiles: result.systemConfig?.fileCount,
          systemConfigVerifiedFiles: result.systemConfigVerification?.verifiedFileCount,
          l0JournalLines: result.l0JournalVerification?.lineCount,
          encrypted: Boolean(result.encryptedBackup),
          encryptedBackupBytes: result.encryptedBackup?.encryptedSizeBytes,
        });
      },
      state: 'idle',
    },
    { skipFirstRun: options.skipFirstRun ?? true },
  );
}
