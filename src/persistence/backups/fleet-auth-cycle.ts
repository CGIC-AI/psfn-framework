import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import { recordBackupDiagnosticOutcome } from '../../shared/diagnostics/runtime-diagnostics.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import type { FleetAuthAuthorityFloorStore } from '../postgres/fleet-auth/authority-floor.js';
import type { BackupRuntimeConfig } from './config.js';
import type {
  FleetBackupRunOptions,
  FleetBackupRunResult,
} from './fleet-backup-contracts.js';
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

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface FleetAuthConsistentBackupCycleOptions {
  backupRestoreDatabaseUrl: string;
  restoreVerifySchemaOwnerDatabaseUrl?: string;
  roles: FleetAuthDatabaseRoles;
  schemas: ReadonlyArray<{
    kind: 'companion' | 'shared';
    schema: string;
    ownerRole: string;
    runtimeRoles: readonly string[];
  }>;
  systemDataDir: string;
  backupRootDir: string;
  config: BackupRuntimeConfig;
  /** Complete filesystem/topology coverage formerly owned by the agent lane. */
  fleetBackupOptions: FleetBackupRunOptions;
  /** Non-restored authority source cloned only into the scratch verifier. */
  authorityFloors: FleetAuthAuthorityFloorStore;
  verifyFamilyRestore?: (options: FleetAuthFamilyRestoreVerificationOptions) => Promise<void>;
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
  recoveryUnitCount: number;
  familyRestoreVerified: boolean;
}

export interface FleetAuthFamilyRestoreVerificationOptions {
  manifestPath: string;
  fleetManifestPath: string;
  scratchDatabaseUrl: string;
  scratchSchemaOwnerDatabaseUrl: string;
  roles: FleetAuthDatabaseRoles;
  authorityFloors: FleetAuthAuthorityFloorStore;
  activationGeneration: number;
  pgRestoreBinary?: string;
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
  mirrorBackup(backupDir: string, mirrorRootDir: string): void;
  runFleetBackup(options: FleetBackupRunOptions): Promise<FleetBackupRunResult>;
}

export async function runFleetAuthConsistentBackupCycleImplementation(
  options: FleetAuthConsistentBackupCycleOptions,
  dependencies: FleetAuthBackupCycleDependencies,
): Promise<FleetAuthConsistentBackupCycleResult> {
  const now = options.now ?? (() => Date.now());
  const cycleTimestamp = now();
  const capturedAt = options.capturedAt ?? new Date(cycleTimestamp).toISOString();
  const finalBackupDir = join(options.backupRootDir, dependencies.formatTimestamp(cycleTimestamp));
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
      capturedAt,
      ...(options.pgDumpBinary ? { pgDumpBinary: options.pgDumpBinary } : {}),
    });
    const expectedManifestPath = join(familyDir, FLEET_AUTH_BACKUP_MANIFEST_NAME);
    if (resolve(coordinatorResult.manifestPath) !== resolve(expectedManifestPath)) {
      throw new Error('Fleet auth backup coordinator published its manifest outside the staged family');
    }

    if (options.fleetBackupOptions.groupMode) {
      throw new Error(
        'Fleet auth recovery packaging requires schema-scoped per-companion artifacts; refusing whole-database group mode',
      );
    }
    if (options.fleetBackupOptions.postgres.databaseUrl !== options.backupRestoreDatabaseUrl) {
      throw new Error(
        'Fleet auth recovery packaging must use only the dedicated backup/restore credential',
      );
    }
    const recoveryRoot = join(familyDir, 'recovery');
    const fleetResult = await dependencies.runFleetBackup({
      ...options.fleetBackupOptions,
      postgres: {
        ...options.fleetBackupOptions.postgres,
        databaseUrl: options.backupRestoreDatabaseUrl,
      },
      backupRootDir: recoveryRoot,
      groupMode: false,
      consistentSnapshotDumpPaths: coordinatorResult.schemaDumpPaths,
      verifyRestore: false,
      mirrorDir: undefined,
      encryption: undefined,
      now: () => cycleTimestamp,
    });
    if (fleetResult.overallStatus !== 'success') {
      throw new Error('Fleet auth recovery packaging produced an incomplete fleet family');
    }
    for (const [index, unit] of fleetResult.units.entries()) {
      const schema = unit.postgresSchema;
      const recoveryDumpPath = fleetResult.results[index]?.postgresDumpPath;
      const snapshotDumpPath = schema ? coordinatorResult.schemaDumpPaths[schema] : undefined;
      if (!schema || !recoveryDumpPath || !snapshotDumpPath
        || sha256(recoveryDumpPath) !== sha256(snapshotDumpPath)) {
        throw new Error(
          'Fleet auth recovery database artifact is not bound to the exported snapshot family',
        );
      }
    }

    let manifestVerified = false;
    let familyRestoreVerified = false;
    if (options.config.verifyRestore) {
      verifyFleetAuthBackupManifest(expectedManifestPath);
      const scratchDatabaseUrl = options.fleetBackupOptions.postgres.restoreVerifyDatabaseUrl;
      if (!scratchDatabaseUrl
        || !options.restoreVerifySchemaOwnerDatabaseUrl
        || !options.verifyFamilyRestore) {
        throw new Error(
          'Fleet auth verifyRestore requires a scratch database and full-family restore verifier',
        );
      }
      await options.verifyFamilyRestore({
        manifestPath: expectedManifestPath,
        fleetManifestPath: fleetResult.fleetManifestPath,
        scratchDatabaseUrl,
        scratchSchemaOwnerDatabaseUrl: options.restoreVerifySchemaOwnerDatabaseUrl,
        roles: options.roles,
        authorityFloors: options.authorityFloors,
        activationGeneration: options.authorityFloors.read().trustedHost.activationGeneration,
      });
      manifestVerified = true;
      familyRestoreVerified = true;
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
      maxDailyBackups: options.config.maxDailyBackups,
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
      recoveryUnitCount: fleetResult.units.length,
      familyRestoreVerified,
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
            familyRestoreVerified: result.familyRestoreVerified,
            recoveryUnitCount: result.recoveryUnitCount,
            encrypted: result.encrypted,
            prunedBackupDirs: result.prunedBackupDirs.length,
            mirrored: Boolean(result.mirrorDir),
          },
        });
        log.info('Scheduled fleet auth consistent backup completed', {
          backupDir: result.backupDir,
          manifestVerified: result.manifestVerified,
          familyRestoreVerified: result.familyRestoreVerified,
          recoveryUnitCount: result.recoveryUnitCount,
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
