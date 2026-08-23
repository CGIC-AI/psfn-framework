import type {
  CompanionTreeCaptureResult,
  CompanionTreeVerificationResult,
  WorkspaceTreeCaptureResult,
  WorkspaceTreeVerificationResult,
} from './companion-tree.js';
import type {
  BackupEncryptionRuntimeConfig,
  EncryptedBackupPackageResult,
} from './encryption.js';
import type { PostgresRestoreVerificationResult } from './postgres-restore.js';
import type {
  SystemConfigSnapshotCaptureResult,
  SystemConfigSnapshotVerificationResult,
} from './system-config-tree.js';
import type {
  KubernetesHelmBackupConfig,
  KubernetesHelmSnapshotCaptureResult,
  KubernetesHelmSnapshotVerificationResult,
} from './kubernetes-helm.js';
import type { BackupContentsManifest } from './backup-contents.js';
import type { TieredRetentionResult } from './retention.js';

export interface BackupPostgresOptions {
  databaseUrl: string;
  restoreVerifyDatabaseUrl?: string;
  schema?: string;
  pgDumpBinary?: string;
  pgRestoreBinary?: string;
  psqlBinary?: string;
}

export interface FleetArtifactIdentity {
  schemaVersion: 1;
  kind: 'companion' | 'cluster' | 'group';
  companionId?: string;
  postgresSchema?: string;
  postgresSchemas?: string[];
}

export interface BackupRunOptions {
  postgres?: BackupPostgresOptions;
  preCapturedPostgresDumpPath?: string;
  companionDataDir?: string;
  workspacePath?: string;
  workspaceExcludePaths?: string[];
  workspaceProtectedPaths?: string[];
  systemDataDir?: string;
  kubernetesHelm?: KubernetesHelmBackupConfig;
  sessionsDir: string;
  /** Exact additional files below sessionsDir needed for a recovery operation. */
  additionalSessionSnapshotFiles?: string[];
  backupRootDir: string;
  retentionCount?: number;
  maxRotatingBackups?: number;
  maxDailyBackups?: number;
  maxWeeklyBackups?: number;
  maxMonthlyBackups?: number;
  memoriesJournalPath?: string;
  characterCardPath?: string;
  characterCardHistoryPath?: string;
  mirrorDir?: string;
  verifyRestore?: boolean;
  encryption?: BackupEncryptionRuntimeConfig;
  fleetArtifactIdentity?: FleetArtifactIdentity;
  now?: () => number;
}

export interface PostgresDumpVerificationResult {
  dumpPath: string;
  tocEntryCount: number;
}

export interface BackupRunResult {
  backupDir: string;
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
  kubernetesHelm?: KubernetesHelmSnapshotCaptureResult;
  kubernetesHelmVerification?: KubernetesHelmSnapshotVerificationResult;
  backupContents: BackupContentsManifest;
  backupContentsVerification?: BackupContentsManifest;
  l0JournalVerification?: { lineCount: number };
  encryptedBackup?: EncryptedBackupPackageResult;
  tieredRetention?: TieredRetentionResult;
  mirrorDir?: string;
}

export interface FleetBackupCompanionUnit {
  companionId: string;
  postgresSchema: string;
  companionDataDir: string;
  sessionsDir: string;
  personalWorkspacePath: string;
  characterCardPath?: string;
  characterCardHistoryPath?: string;
  memoriesJournalPath?: string;
}

export interface FleetBackupRunOptions {
  postgres: BackupPostgresOptions;
  companions: FleetBackupCompanionUnit[];
  systemDataDir: string;
  sharedWorkspacePath: string;
  kubernetesHelm?: KubernetesHelmBackupConfig;
  sharedSchema?: string;
  backupRootDir: string;
  groupMode?: boolean;
  groupCompanionDataDir?: string;
  groupWorkspacesRoot?: string;
  maxRotatingBackups?: number;
  maxDailyBackups?: number;
  maxWeeklyBackups?: number;
  maxMonthlyBackups?: number;
  mirrorDir?: string;
  verifyRestore?: boolean;
  encryption?: BackupEncryptionRuntimeConfig;
  now?: () => number;
  consistentSnapshotDumpPaths?: Readonly<Record<string, string>>;
}

export type FleetBackupUnitKind = 'companion' | 'cluster' | 'group';

export interface FleetBackupUnitOutcome {
  kind: FleetBackupUnitKind;
  companionId?: string;
  postgresSchema?: string;
  postgresSchemas?: string[];
  status: 'success' | 'failure';
  artifactDir?: string;
  error?: string;
}

export interface FleetBackupRunResult {
  mode: 'per-companion' | 'group';
  backupRootDir: string;
  fleetManifestPath: string;
  overallStatus: 'success' | 'failure';
  units: FleetBackupUnitOutcome[];
  results: BackupRunResult[];
}

/**
 * Thrown when at least one unit in a fleet backup failed. The fleet manifest has
 * already been written (recording every unit's per-unit outcome) before this is
 * raised, so a partial run can never be mistaken for a full success.
 *
 * It lives with the contracts rather than with the runner so every consumer —
 * the fleet lane, the gateway-owned fleet-auth lane, restore tooling — can name
 * the failing companion without importing the runner and forming a cycle.
 */
export class FleetBackupPartialFailureError extends Error {
  readonly fleetManifestPath: string;
  readonly units: FleetBackupUnitOutcome[];

  constructor(fleetManifestPath: string, units: FleetBackupUnitOutcome[]) {
    const failed = units.filter(unit => unit.status === 'failure');
    const summary = failed
      .map(unit => `${unit.kind}${unit.companionId ? `(${unit.companionId})` : ''}: ${unit.error ?? 'unknown error'}`)
      .join('; ');
    super(
      `Fleet backup failed for ${failed.length} of ${units.length} unit(s): ${summary}. `
      + `Per-unit outcomes recorded in ${fleetManifestPath}.`,
    );
    this.name = 'FleetBackupPartialFailureError';
    this.fleetManifestPath = fleetManifestPath;
    this.units = units;
  }
}
