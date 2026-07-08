import { isAbsolute, resolve, sep } from 'node:path';
import { createComponentLogger } from '../../shared/logger.js';
import { recordBackupDiagnosticOutcome } from '../../shared/diagnostics/runtime-diagnostics.js';
import {
  isStrictSubpath,
  resolveCharacterCardHistoryPath,
  resolveMemoryJournalPath,
  resolveSessionsDir,
} from '../layout.js';
import type { Scheduler } from '../../core/scheduler/scheduler.js';
import type { CompanionsFleetConfig } from '../../system/config/companions-config.js';
import type { BackupRuntimeConfig } from './config.js';
import { deriveRestoreVerifyDatabaseUrl } from './postgres-restore.js';
import {
  FleetBackupPartialFailureError,
  runFleetBackupCycle,
  SCHEDULED_BACKUP_TASK_ID,
  SCHEDULED_BACKUP_TASK_NAME,
  type BackupPostgresOptions,
  type FleetBackupCompanionUnit,
  type FleetBackupRunOptions,
  type FleetBackupRunResult,
} from './service.js';

const log = createComponentLogger('FleetBackupScheduler');

/**
 * Multi-companion fleet-backup wiring (sprint 10, W2).
 *
 * The single-companion scheduled backup runs one `runBackupCycle` per agent
 * process. In multi-companion mode every companion is its own OS process behind
 * one gateway, so a naive "each process backs itself up" would produce N
 * independent, uncoordinated backups. Instead exactly ONE process — the fleet
 * LEADER, deterministically the first companion in `companions.json` order —
 * runs a single {@link runFleetBackupCycle} that captures every companion slice
 * (+ the cluster/shared artifact, or one whole-database family artifact in group
 * mode). Follower processes register no backup lane. This keeps the tenant
 * boundary honest (one companion, one restorable slice) with no duplicated work.
 */

/**
 * Deterministic leader election: the process whose companion id is the FIRST
 * entry in the validated fleet manifest owns the fleet backup. Fail-closed —
 * a companion id absent from its own fleet is a topology invariant violation.
 */
export function isFleetBackupLeader(
  ownCompanionId: string | undefined,
  fleet: CompanionsFleetConfig,
): boolean {
  const id = ownCompanionId?.trim();
  if (!id) {
    throw new Error(
      'Multi-companion fleet backup requires this process to carry a COMPANION_ID — refusing to elect a backup leader without one',
    );
  }
  if (!fleet.companions.some(entry => entry.companionId === id)) {
    throw new Error(
      `Multi-companion fleet backup: this process's companion id "${id}" is not present in the fleet manifest — refusing to run with an inconsistent fleet`,
    );
  }
  return fleet.companions[0].companionId === id;
}

/**
 * Derive the persistence anchor directory from the leader's OWN entry: the base
 * `X` such that `resolve(X, ownEntry.companionDataDir)` is the absolute
 * companion-data dir the runtime already resolved for this process. Every other
 * companion's relative manifest path is then anchored the same way, so a sibling
 * resolves identically to how that sibling's own agent process would. Fail-closed
 * when the resolved dir does not carry the manifest-relative suffix (a layout /
 * manifest mismatch we must not paper over).
 */
export function deriveFleetAnchorDir(
  ownRelativeCompanionDataDir: string,
  ownResolvedCompanionDataDir: string,
): string {
  const ownAbs = resolve(ownResolvedCompanionDataDir);
  // The anchor is the ancestor of ownAbs obtained by dropping as many trailing
  // segments as the relative manifest path has. This mirrors exactly how the
  // runtime joined the relative path onto its base, without assuming any
  // particular base value (cwd vs runtime root vs explicit absolute).
  const relParts = ownRelativeCompanionDataDir
    .split(/[\\/]+/)
    .filter(part => part.length > 0 && part !== '.');
  const absParts = ownAbs.split(sep);
  if (relParts.length === 0 || relParts.length >= absParts.length) {
    throw new Error(
      `Fleet backup cannot anchor companion paths: own companion-data dir "${ownResolvedCompanionDataDir}" `
      + `is not under a base that ends with manifest path "${ownRelativeCompanionDataDir}"`,
    );
  }
  const tail = absParts.slice(absParts.length - relParts.length);
  for (let i = 0; i < relParts.length; i += 1) {
    if (tail[i] !== relParts[i]) {
      throw new Error(
        `Fleet backup cannot anchor companion paths: own companion-data dir "${ownResolvedCompanionDataDir}" `
        + `does not end with manifest path "${ownRelativeCompanionDataDir}"`,
      );
    }
  }
  const anchor = absParts.slice(0, absParts.length - relParts.length).join(sep);
  return anchor.length > 0 ? anchor : sep;
}

/**
 * The common companion-data parent captured whole in group mode: the longest
 * shared directory ancestor of every companion's resolved data dir. Fail-closed
 * if it collapses to the filesystem root or would swallow the system-data root
 * (system-owned config must never land inside the companion tree).
 */
export function resolveGroupCompanionDataDir(
  companionDataDirs: readonly string[],
  systemDataDir: string,
): string {
  if (companionDataDirs.length === 0) {
    throw new Error('Group fleet backup requires at least one companion data dir');
  }
  const split = companionDataDirs.map(dir => resolve(dir).split(sep));
  let common = split[0];
  for (const parts of split.slice(1)) {
    let i = 0;
    while (i < common.length && i < parts.length && common[i] === parts[i]) {
      i += 1;
    }
    common = common.slice(0, i);
  }
  const groupDir = common.join(sep) || sep;
  if (groupDir === sep || common.filter(part => part.length > 0).length < 1) {
    throw new Error(
      'Group fleet backup: companion data dirs share no meaningful parent — refusing to capture the filesystem root',
    );
  }
  const resolvedSystem = resolve(systemDataDir);
  if (resolvedSystem === groupDir || isStrictSubpath(resolvedSystem, groupDir)) {
    throw new Error(
      `Group fleet backup: computed group companion-data parent "${groupDir}" contains the system-data root `
      + `"${resolvedSystem}" — refusing to capture system-owned config inside the companion tree`,
    );
  }
  return groupDir;
}

export interface BuildFleetBackupRunOptionsParams {
  fleet: CompanionsFleetConfig;
  ownCompanionId: string | undefined;
  /** This process's already-resolved absolute companion-data dir (path snapshot). */
  ownResolvedCompanionDataDir: string;
  systemDataDir: string;
  postgres: BackupPostgresOptions;
  backupConfig: BackupRuntimeConfig;
}

/**
 * Build the fully-resolved {@link FleetBackupRunOptions} from the validated fleet
 * manifest, this process's resolved layout, and the backup runtime config. Pure:
 * no scheduler, no I/O.
 */
export function buildFleetBackupRunOptions(
  params: BuildFleetBackupRunOptionsParams,
): FleetBackupRunOptions {
  const { fleet, ownCompanionId, ownResolvedCompanionDataDir, systemDataDir, backupConfig } = params;
  const ownEntry = fleet.companions.find(entry => entry.companionId === ownCompanionId?.trim());
  if (!ownEntry) {
    throw new Error(
      `Fleet backup: this process's companion id ${JSON.stringify(ownCompanionId)} is not present in the fleet manifest`,
    );
  }
  const anchor = deriveFleetAnchorDir(ownEntry.companionDataDir, ownResolvedCompanionDataDir);

  const companions: FleetBackupCompanionUnit[] = fleet.companions.map(entry => {
    const companionDataDir = resolve(anchor, entry.companionDataDir);
    const characterCardPath = isAbsolute(entry.characterCardPath)
      ? entry.characterCardPath
      : resolve(anchor, entry.characterCardPath);
    return {
      companionId: entry.companionId,
      postgresSchema: entry.postgresSchema,
      companionDataDir,
      sessionsDir: resolveSessionsDir(companionDataDir),
      characterCardPath,
      characterCardHistoryPath: resolveCharacterCardHistoryPath(companionDataDir),
      memoriesJournalPath: resolveMemoryJournalPath(companionDataDir),
    };
  });

  // Match the single-companion path: derive a scratch restore-verify DB only
  // when verifyRestore is on. The fleet library scopes it to companion units and
  // deliberately drops it for the cluster/group artifacts.
  const postgres: BackupPostgresOptions = { ...params.postgres };
  if (backupConfig.verifyRestore) {
    const derived = deriveRestoreVerifyDatabaseUrl(postgres.databaseUrl);
    if (!derived) {
      throw new Error(
        'Backup verifyRestore is enabled but the restore-verify scratch database URL cannot be derived from the Postgres connection string',
      );
    }
    postgres.restoreVerifyDatabaseUrl = derived;
  }

  const groupMode = backupConfig.groupMode;
  const groupCompanionDataDir = groupMode
    ? resolveGroupCompanionDataDir(companions.map(unit => unit.companionDataDir), systemDataDir)
    : undefined;

  return {
    postgres,
    companions,
    systemDataDir,
    backupRootDir: backupConfig.rootDir,
    groupMode,
    ...(groupCompanionDataDir ? { groupCompanionDataDir } : {}),
    maxRotatingBackups: backupConfig.maxRotatingBackups,
    maxWeeklyBackups: backupConfig.maxWeeklyBackups,
    maxMonthlyBackups: backupConfig.maxMonthlyBackups,
    ...(backupConfig.mirrorDir ? { mirrorDir: backupConfig.mirrorDir } : {}),
    verifyRestore: backupConfig.verifyRestore,
    encryption: backupConfig.encryption,
  };
}

export interface RegisterScheduledFleetBackupTaskOptions {
  scheduler: Scheduler;
  fleetOptions: FleetBackupRunOptions;
  config: BackupRuntimeConfig;
  skipFirstRun?: boolean;
  /** Invoked when a fleet backup cycle fails (incl. partial failure). */
  onBackupFailure?: (error: unknown) => void;
  /** Test seam: override the fleet runner (defaults to the real cycle). */
  runFleetBackup?: (options: FleetBackupRunOptions) => Promise<FleetBackupRunResult>;
}

/**
 * Register the multi-companion fleet backup on the same scheduled-backup lane
 * (task id {@link SCHEDULED_BACKUP_TASK_ID}) the single-companion path uses, so
 * backup diagnostics/Garden/`backup.failed` surface identically. A partial fleet
 * failure ({@link FleetBackupPartialFailureError}) is recorded and re-thrown —
 * never swallowed — so a partial run can never read as a healthy backup.
 */
export function registerScheduledFleetBackupTask(
  options: RegisterScheduledFleetBackupTaskOptions,
): void {
  const runFleetBackup = options.runFleetBackup ?? runFleetBackupCycle;
  options.scheduler.register(
    {
      id: SCHEDULED_BACKUP_TASK_ID,
      name: SCHEDULED_BACKUP_TASK_NAME,
      type: 'every',
      intervalMs: options.config.intervalMs,
      handler: async () => {
        let result: FleetBackupRunResult;
        try {
          result = await runFleetBackup(options.fleetOptions);
        } catch (error) {
          const observedAt = Date.now();
          const errorMessage = error instanceof Error ? error.message : String(error);
          const partial = error instanceof FleetBackupPartialFailureError;
          log.error('Scheduled fleet backup failed', {
            error: errorMessage,
            partialFailure: partial,
            ...(partial
              ? {
                fleetManifestPath: error.fleetManifestPath,
                failedUnits: error.units.filter(unit => unit.status === 'failure').length,
                totalUnits: error.units.length,
              }
              : {}),
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
          message: 'Scheduled fleet backup completed',
          backupDir: result.backupRootDir,
          details: {
            mode: result.mode,
            unitCount: result.units.length,
            fleetManifestPath: result.fleetManifestPath,
          },
        });
        log.info('Scheduled fleet backup completed', {
          mode: result.mode,
          backupRootDir: result.backupRootDir,
          fleetManifestPath: result.fleetManifestPath,
          unitCount: result.units.length,
        });
      },
      state: 'idle',
    },
    { skipFirstRun: options.skipFirstRun ?? true },
  );
}
