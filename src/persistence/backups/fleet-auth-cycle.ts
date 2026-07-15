import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import { recordBackupDiagnosticOutcome } from '../../shared/diagnostics/runtime-diagnostics.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import type { BackupRuntimeConfig } from './config.js';
import {
  assertEncryptedBackupPackage,
  encryptBackupDirectory,
} from './encryption.js';
import {
  FLEET_AUTH_BACKUP_MANIFEST_NAME,
  runFleetAuthConsistentBackup,
  verifyFleetAuthBackupManifest,
  type FleetAuthConsistentBackupResult,
} from './fleet-auth-coordinator.js';
import { applyTieredRetention } from './retention.js';

const log = createComponentLogger('FleetAuthBackupCycle');

export interface FleetAuthConsistentBackupCycleOptions {
  backupRestoreDatabaseUrl: string;
  roles: FleetAuthDatabaseRoles;
  schemas: ReadonlyArray<{
    kind: 'companion' | 'shared';
    schema: string;
    runtimeRoles: readonly string[];
  }>;
  systemDataDir: string;
  backupRootDir: string;
  config: BackupRuntimeConfig;
  pgDumpBinary?: string;
  now?: () => number;
  capturedAt?: string;
  runCoordinator?: typeof runFleetAuthConsistentBackup;
}

export interface FleetAuthConsistentBackupCycleResult {
  backupDir: string;
  manifestVerified: boolean;
  encrypted: boolean;
  prunedBackupDirs: string[];
  mirrorDir?: string;
}

export interface RegisterScheduledFleetAuthBackupTaskOptions {
  scheduler: Scheduler;
  cycleOptions: FleetAuthConsistentBackupCycleOptions;
  config: BackupRuntimeConfig;
  onBackupFailure?: (error: unknown) => void;
  skipFirstRun?: boolean;
  runCycle?: (
    options: FleetAuthConsistentBackupCycleOptions,
  ) => Promise<FleetAuthConsistentBackupCycleResult>;
}

export interface FleetAuthBackupCycleDependencies {
  formatTimestamp(timestampMs: number): string;
  verifyDumpArchive(dumpPath: string): Promise<void>;
  mirrorBackup(backupDir: string, mirrorRootDir: string): void;
}

export async function runFleetAuthConsistentBackupCycleImplementation(
  options: FleetAuthConsistentBackupCycleOptions,
  dependencies: FleetAuthBackupCycleDependencies,
): Promise<FleetAuthConsistentBackupCycleResult> {
  const now = options.now ?? (() => Date.now());
  const finalBackupDir = join(options.backupRootDir, dependencies.formatTimestamp(now()));
  if (existsSync(finalBackupDir)) {
    throw new Error(`Fleet auth backup destination already exists: ${finalBackupDir}`);
  }

  mkdirSync(options.backupRootDir, { recursive: true });
  const stagingRootDir = mkdtempSync(join(tmpdir(), 'psfn-fleet-auth-backup-stage-'));
  const familyDir = join(stagingRootDir, 'family');
  mkdirSync(familyDir);
  const runCoordinator = options.runCoordinator ?? runFleetAuthConsistentBackup;

  try {
    const coordinatorResult: FleetAuthConsistentBackupResult = await runCoordinator({
      databaseUrl: options.backupRestoreDatabaseUrl,
      roles: options.roles,
      schemas: options.schemas,
      systemDataDir: options.systemDataDir,
      backupDir: familyDir,
      ...(options.capturedAt ? { capturedAt: options.capturedAt } : {}),
      ...(options.pgDumpBinary ? { pgDumpBinary: options.pgDumpBinary } : {}),
    });
    const expectedManifestPath = join(familyDir, FLEET_AUTH_BACKUP_MANIFEST_NAME);
    if (resolve(coordinatorResult.manifestPath) !== resolve(expectedManifestPath)) {
      throw new Error('Fleet auth backup coordinator published its manifest outside the staged family');
    }

    let manifestVerified = false;
    if (options.config.verifyRestore) {
      const manifest = verifyFleetAuthBackupManifest(expectedManifestPath);
      for (const artifact of manifest.artifacts) {
        if (artifact.kind === 'companion' || artifact.kind === 'shared') {
          await dependencies.verifyDumpArchive(join(familyDir, artifact.path));
        }
      }
      manifestVerified = true;
    }

    // Backup encryption is mandatory (BackupRuntimeConfig.encryption is always
    // present — resolveBackupRuntimeConfig fails closed without a key). The whole
    // same-snapshot family is sealed as one encrypted package, exactly like the
    // single/fleet lanes.
    await encryptBackupDirectory({
      sourceDir: familyDir,
      outputDir: finalBackupDir,
      encryption: options.config.encryption,
      now,
    });
    assertEncryptedBackupPackage(finalBackupDir);
    const encrypted = true;

    const retention = applyTieredRetention(options.backupRootDir, {
      maxRotatingBackups: options.config.maxRotatingBackups,
      maxWeeklyBackups: options.config.maxWeeklyBackups,
      maxMonthlyBackups: options.config.maxMonthlyBackups,
    });

    const effectiveMirrorDir = options.config.mirrorDir.trim();
    let mirrorDir: string | undefined;
    if (effectiveMirrorDir && existsSync(finalBackupDir)) {
      try {
        mkdirSync(effectiveMirrorDir, { recursive: true });
        dependencies.mirrorBackup(finalBackupDir, effectiveMirrorDir);
        for (const pruned of retention.prunedBackupDirs) {
          const mirrorPruned = join(effectiveMirrorDir, basename(pruned));
          if (existsSync(mirrorPruned)) {
            rmSync(mirrorPruned, { recursive: true, force: true });
          }
        }
        mirrorDir = effectiveMirrorDir;
      } catch (error) {
        log.warn('Fleet auth backup mirror failed — local backup is intact', {
          mirrorDir: effectiveMirrorDir,
          error: String(error),
        });
      }
    }

    return {
      backupDir: finalBackupDir,
      manifestVerified,
      encrypted,
      prunedBackupDirs: retention.prunedBackupDirs,
      ...(mirrorDir ? { mirrorDir } : {}),
    };
  } finally {
    rmSync(stagingRootDir, { recursive: true, force: true });
  }
}

export function registerScheduledFleetAuthBackupTaskImplementation(
  options: RegisterScheduledFleetAuthBackupTaskOptions,
  dependencies: {
    taskId: string;
    taskName: string;
    runDefaultCycle: (
      cycleOptions: FleetAuthConsistentBackupCycleOptions,
    ) => Promise<FleetAuthConsistentBackupCycleResult>;
  },
): void {
  const runCycle = options.runCycle ?? dependencies.runDefaultCycle;
  options.scheduler.register(
    {
      id: dependencies.taskId,
      name: dependencies.taskName,
      type: 'every',
      intervalMs: options.config.intervalMs,
      handler: async () => {
        let result: FleetAuthConsistentBackupCycleResult;
        try {
          result = await runCycle(options.cycleOptions);
        } catch (error) {
          const observedAt = Date.now();
          const errorMessage = error instanceof Error ? error.message : String(error);
          log.error('Scheduled fleet auth consistent backup failed', {
            error: errorMessage,
          });
          recordBackupDiagnosticOutcome({
            status: 'failure',
            observedAt,
            taskId: dependencies.taskId,
            taskName: dependencies.taskName,
            message: errorMessage,
          });
          options.onBackupFailure?.(error);
          throw error;
        }

        recordBackupDiagnosticOutcome({
          status: 'success',
          taskId: dependencies.taskId,
          taskName: dependencies.taskName,
          message: 'Scheduled fleet auth consistent backup completed',
          backupDir: result.backupDir,
          details: {
            manifestVerified: result.manifestVerified,
            encrypted: result.encrypted,
            prunedBackupDirs: result.prunedBackupDirs.length,
            mirrored: Boolean(result.mirrorDir),
          },
        });
        log.info('Scheduled fleet auth consistent backup completed', {
          backupDir: result.backupDir,
          manifestVerified: result.manifestVerified,
          encrypted: result.encrypted,
          prunedBackupDirs: result.prunedBackupDirs.length,
          mirrored: Boolean(result.mirrorDir),
        });
      },
      state: 'idle',
    },
    { skipFirstRun: options.skipFirstRun ?? true },
  );
}
