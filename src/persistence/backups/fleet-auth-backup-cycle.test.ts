import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import { EventBus } from '../../shared/event-bus.js';
import {
  buildRuntimeDiagnosticsSnapshot,
  resetRuntimeDiagnosticsForTests,
} from '../../shared/diagnostics/runtime-diagnostics.js';
import { describeStartupOwnerFileChecks } from '../../system/config/startup-owner-files.js';
import type { FleetAuthFamilyDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import { FleetAuthAuthorityFloorStore } from '../postgres/fleet-auth/authority-floor.js';
import type { BackupRuntimeConfig } from './config.js';
import { verifyWorkspaceTreeSnapshot } from './companion-tree.js';
import {
  decryptEncryptedBackupPackage,
  ENCRYPTED_BACKUP_MANIFEST_NAME,
  ENCRYPTED_BACKUP_PAYLOAD_NAME,
  type BackupEncryptionRuntimeConfig,
} from './encryption.js';
import {
  FLEET_AUTH_BACKUP_MANIFEST_NAME,
  type FleetAuthBackupArtifact,
  type FleetAuthConsistentBackupResult,
} from './fleet-auth-coordinator.js';
import {
  registerScheduledFleetAuthBackupTask,
  runFleetAuthConsistentBackupCycle,
  SCHEDULED_BACKUP_TASK_ID,
  type FleetAuthConsistentBackupCycleOptions,
} from './service.js';
import {
  BackupRootNotWritableError,
  FLEET_AUTH_BACKUP_WATERMARK_NAME,
  writeFleetAuthBackupWatermark,
} from './backup-root.js';
import { FleetBackupPartialFailureError } from './fleet-backup-contracts.js';
import {
  runFleetAuthConsistentBackupCycleImplementation,
  type FleetAuthConsistentBackupCycleResult,
} from './fleet-auth-cycle.js';
import { restoreFleetCompanionSlice } from './fleet-restore.js';

const ROLES: FleetAuthFamilyDatabaseRoles = {
  runtime: 'auth_runtime',
  migration: 'auth_migration',
  backupRestore: 'auth_backup_restore',
  sharedMigration: 'shared_migration',
};

const ENCRYPTION: BackupEncryptionRuntimeConfig = {
  mode: 'required',
  keyRef: { kind: 'env', envName: 'PSFN_BACKUP_TEST_KEY' },
  passphrase: 'test-backup-secret',
};

const roots: string[] = [];
const COMPANION_ID = '11111111-1111-4111-8111-111111111111';
const BACKUP_TIMESTAMP = '20260715T150000000Z';

function makeRoot(): string {
  const root = join(
    tmpdir(),
    `psfn-fleet-auth-cycle-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`,
  );
  mkdirSync(root, { recursive: true });
  roots.push(root);
  return root;
}

function hashArtifact(path: string): Pick<FleetAuthBackupArtifact, 'sha256' | 'sizeBytes'> {
  const bytes = readFileSync(path);
  return {
    sha256: createHash('sha256').update(bytes).digest('hex'),
    sizeBytes: bytes.length,
  };
}

function writeFakeFamily(
  backupDir: string,
  tamperAfterManifest = false,
  emptyCompanionDump = false,
): FleetAuthConsistentBackupResult {
  const files = [
    { kind: 'companion' as const, path: 'postgres/companion_one.dump', schema: 'companion_one' },
    { kind: 'shared' as const, path: 'postgres/shared.dump', schema: 'shared' },
    { kind: 'fleet_auth' as const, path: 'fleet-auth.snapshot.json', schema: 'fleet_auth' },
    { kind: 'fleet_auth_config' as const, path: 'system-config/fleet-auth.json' },
  ];
  for (const file of files) {
    const absolutePath = join(backupDir, file.path);
    mkdirSync(dirname(absolutePath), { recursive: true });
    writeFileSync(
      absolutePath,
      emptyCompanionDump && file.kind === 'companion' ? '' : `${file.kind}-bytes\n`,
      'utf8',
    );
  }
  const artifacts: FleetAuthBackupArtifact[] = files.map(file => ({
    kind: file.kind,
    path: file.path,
    ...(file.schema ? { postgresSchema: file.schema } : {}),
    ...(file.kind === 'companion' || file.kind === 'shared'
      ? { ownerRole: 'companion_runtime', runtimeRoles: ['companion_runtime'] }
      : {}),
    ...hashArtifact(join(backupDir, file.path)),
  }));
  const manifestPath = join(backupDir, FLEET_AUTH_BACKUP_MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 5,
    capturedAt: '2026-07-15T15:00:00.000Z',
    postgresSnapshot: '100:200:',
    authorityLineageId: 'a'.repeat(64),
    artifacts,
  }), 'utf8');
  if (tamperAfterManifest) {
    writeFileSync(join(backupDir, files[0].path), 'tampered\n', 'utf8');
  }
  return {
    manifestPath,
    fleetAuthSnapshotPath: join(backupDir, 'fleet-auth.snapshot.json'),
    schemaDumpPaths: {
      companion_one: join(backupDir, 'postgres/companion_one.dump'),
      shared: join(backupDir, 'postgres/shared.dump'),
    },
  };
}

function makeConfig(
  rootDir: string,
  overrides: Partial<BackupRuntimeConfig> = {},
): BackupRuntimeConfig {
  return {
    intervalMs: 60_000,
    maxRotatingBackups: 1,
    maxDailyBackups: 0,
    maxWeeklyBackups: 0,
    maxMonthlyBackups: 0,
    rootDir,
    mirrorDir: '',
    verifyRestore: false,
    groupMode: false,
    encryption: ENCRYPTION,
    ...overrides,
  };
}

function makeCycleOptions(
  root: string,
  config: BackupRuntimeConfig,
  runCoordinator: FleetAuthConsistentBackupCycleOptions['runCoordinator'],
  verifyFamilyRestore: NonNullable<FleetAuthConsistentBackupCycleOptions['verifyFamilyRestore']>
    = async () => undefined,
): FleetAuthConsistentBackupCycleOptions {
  const companionDataDir = join(root, 'companion-data', COMPANION_ID);
  const sessionsDir = join(companionDataDir, 'state', 'sessions');
  const personalWorkspacePath = join(root, 'workspaces', 'personal', COMPANION_ID);
  const sharedWorkspacePath = join(root, 'workspaces', 'shared');
  const systemDataDir = join(root, 'system-data');
  const authorityRoot = join(root, 'authority-floor');
  for (const directory of [
    join(companionDataDir, 'vault'),
    sessionsDir,
    join(companionDataDir, 'notes'),
    join(companionDataDir, 'state'),
    join(personalWorkspacePath, 'journal'),
    join(sharedWorkspacePath, 'artifacts'),
    systemDataDir,
    authorityRoot,
  ]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(companionDataDir, 'vault', 'marker.txt'), 'companion-data\n');
  writeFileSync(join(sessionsDir, 'channel.jsonl'), '{"session":true}\n');
  writeFileSync(join(companionDataDir, 'notes', 'memories.jsonl'), '{"memory":true}\n');
  writeFileSync(join(companionDataDir, 'character.json'), '{"name":"Companion"}\n');
  writeFileSync(join(companionDataDir, 'state', 'character-card-history.jsonl'), '{"version":1}\n');
  writeFileSync(join(personalWorkspacePath, 'journal', 'marker.txt'), 'personal-workspace\n');
  writeFileSync(join(sharedWorkspacePath, 'artifacts', 'world.txt'), 'shared-workspace\n');
  writeFileSync(join(systemDataDir, 'settings.json'), '{}\n');
  writeFileSync(join(systemDataDir, 'fleet-auth.json'), '{}\n');
  writeFileSync(join(systemDataDir, 'companions.json'), `${JSON.stringify({
    postgres: {
      sharedMigrationRole: 'shared_schema_migration',
      sharedMigrationDatabaseUrlRef: {
        kind: 'env',
        envName: 'SHARED_SCHEMA_MIGRATION_DATABASE_URL',
      },
    },
    companions: [{
      companionId: COMPANION_ID,
      companionDataDir: 'companions/one',
      characterCardPath: 'companions/one/character-card.json',
      postgresSchema: 'companion_one',
      postgresRole: 'companion_runtime',
      postgresDatabaseUrlRef: {
        kind: 'env',
        envName: 'COMPANION_ONE_DATABASE_URL',
      },
    }],
  }, null, 2)}\n`);
  for (const descriptor of describeStartupOwnerFileChecks()) {
    if (descriptor.scope !== 'system'
      || descriptor.optionalWhenMissing
      || existsSync(join(systemDataDir, descriptor.ownerFileName))) {
      continue;
    }
    writeFileSync(
      join(systemDataDir, descriptor.ownerFileName),
      readFileSync(join(process.cwd(), 'config', descriptor.seedFileName)),
    );
  }
  const authorityFloors = new FleetAuthAuthorityFloorStore(authorityRoot);
  if (!authorityFloors.exists()) {
    authorityFloors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
  }
  const backupRestoreDatabaseUrl =
    'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app';
  return {
    backupRestoreDatabaseUrl,
    restoreVerifySchemaOwnerDatabaseUrl:
      'postgresql://auth_migration:secret@127.0.0.1:5432/app_restore_verify',
    roles: ROLES,
    schemas: [
      {
        kind: 'companion', schema: 'companion_one', ownerRole: 'companion_runtime',
        runtimeRoles: ['companion_runtime'],
      },
      {
        kind: 'shared', schema: 'shared', ownerRole: 'companion_runtime',
        runtimeRoles: ['companion_runtime'],
      },
    ],
    systemDataDir,
    backupRootDir: config.rootDir,
    config,
    fleetBackupOptions: {
      postgres: {
        databaseUrl: backupRestoreDatabaseUrl,
        restoreVerifyDatabaseUrl:
          'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app_restore_verify',
      },
      companions: [{
        companionId: COMPANION_ID,
        postgresSchema: 'companion_one',
        companionDataDir,
        sessionsDir,
        personalWorkspacePath,
        characterCardPath: join(companionDataDir, 'character.json'),
        characterCardHistoryPath: join(companionDataDir, 'state', 'character-card-history.jsonl'),
        memoriesJournalPath: join(companionDataDir, 'notes', 'memories.jsonl'),
      }],
      systemDataDir,
      sharedWorkspacePath,
      backupRootDir: config.rootDir,
      groupMode: false,
    },
    authorityFloors,
    scratchSchemaOwnerDatabaseUrls: {
      companion_one:
        'postgresql://companion_runtime:secret@127.0.0.1:5432/app_restore_verify',
      shared: 'postgresql://companion_runtime:secret@127.0.0.1:5432/app_restore_verify',
    },
    verifyFamilyRestore,
    now: () => Date.UTC(2026, 6, 15, 15, 0, 0),
    runCoordinator,
  };
}

async function restoreCompanionSliceForCycleVerification(
  root: string,
  fleetManifestPath: string,
): Promise<void> {
  await restoreFleetCompanionSlice({
    fleetManifestPath,
    companionId: COMPANION_ID,
    destinations: {
      companionDataDir: join(root, 'scratch', 'companion-data'),
      personalWorkspacePath: join(root, 'scratch', 'workspace'),
    },
    postgres: {
      databaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app_restore_verify',
    },
  });
}

beforeEach(() => {
  resetRuntimeDiagnosticsForTests();
});

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('runFleetAuthConsistentBackupCycle', () => {
  it('packages, retains, mirrors, and decrypts a complete consistent family', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const mirrorDir = join(root, 'mirror');
    const oldName = '20260714T150000000Z';
    mkdirSync(join(backupRootDir, oldName), { recursive: true });
    mkdirSync(join(mirrorDir, oldName), { recursive: true });
    writeFileSync(join(backupRootDir, oldName, 'old.txt'), 'old\n');
    writeFileSync(join(mirrorDir, oldName, 'old.txt'), 'old\n');
    const config = makeConfig(backupRootDir, { mirrorDir, verifyRestore: true });
    const verifyFamilyRestore = vi.fn(async () => undefined);
    const result = await runFleetAuthConsistentBackupCycle(makeCycleOptions(
      root,
      config,
      async options => writeFakeFamily(options.backupDir),
      verifyFamilyRestore,
    ));

    expect(result).toMatchObject({
      manifestVerified: true,
      encrypted: true,
      mirrorDir,
      prunedBackupDirs: [join(backupRootDir, oldName)],
      familyRestoreVerified: true,
      recoveryUnitCount: 2,
    });
    expect(verifyFamilyRestore).toHaveBeenCalledOnce();
    expect(verifyFamilyRestore).toHaveBeenCalledWith(expect.objectContaining({
      scratchSchemaOwnerDatabaseUrls: {
        companion_one:
          'postgresql://companion_runtime:secret@127.0.0.1:5432/app_restore_verify',
        shared: 'postgresql://companion_runtime:secret@127.0.0.1:5432/app_restore_verify',
      },
    }));
    expect(existsSync(join(result.backupDir, ENCRYPTED_BACKUP_PAYLOAD_NAME))).toBe(true);
    expect(existsSync(join(result.backupDir, ENCRYPTED_BACKUP_MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(mirrorDir, '20260715T150000000Z', ENCRYPTED_BACKUP_PAYLOAD_NAME)))
      .toBe(true);
    expect(existsSync(join(mirrorDir, oldName))).toBe(false);

    const restoredDir = join(root, 'restored');
    await decryptEncryptedBackupPackage({
      encryptedBackupDir: result.backupDir,
      outputDir: restoredDir,
      encryption: ENCRYPTION,
    });
    expect(existsSync(join(restoredDir, FLEET_AUTH_BACKUP_MANIFEST_NAME))).toBe(true);
    expect(readFileSync(join(restoredDir, 'postgres/companion_one.dump'), 'utf8'))
      .toBe('companion-bytes\n');
    const companionArtifact = join(
      restoredDir,
      'recovery',
      'companions',
      COMPANION_ID,
      BACKUP_TIMESTAMP,
    );
    expect(readFileSync(join(companionArtifact, 'companion-tree/vault/marker.txt'), 'utf8'))
      .toBe('companion-data\n');
    expect(readFileSync(join(companionArtifact, 'sessions/channel.jsonl'), 'utf8'))
      .toBe('{"session":true}\n');
    expect(readFileSync(join(companionArtifact, 'notes/memories.jsonl'), 'utf8'))
      .toBe('{"memory":true}\n');
    expect(readFileSync(join(companionArtifact, 'companion/character.json'), 'utf8'))
      .toBe('{"name":"Companion"}\n');
    expect(readFileSync(
      join(companionArtifact, 'companion/character-card-history.jsonl'),
      'utf8',
    )).toBe('{"version":1}\n');
    expect(readFileSync(join(companionArtifact, 'workspace-tree/journal/marker.txt'), 'utf8'))
      .toBe('personal-workspace\n');
    const clusterArtifact = join(restoredDir, 'recovery', 'cluster', BACKUP_TIMESTAMP);
    expect(readFileSync(join(clusterArtifact, 'workspace-tree/artifacts/world.txt'), 'utf8'))
      .toBe('shared-workspace\n');
    expect(readFileSync(join(clusterArtifact, 'system-config/settings.json'), 'utf8'))
      .toBe('{}\n');
    expect(readFileSync(join(clusterArtifact, 'system-config/companions.json'), 'utf8'))
      .toContain(COMPANION_ID);
    expect(readFileSync(join(clusterArtifact, 'system-config/fleet-auth.json'), 'utf8'))
      .toBe('{}\n');
  });

  it('rejects a tampered family before publishing a backup', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, {
      verifyRestore: true,
      encryption: ENCRYPTION,
    });
    await expect(runFleetAuthConsistentBackupCycle(makeCycleOptions(
      root,
      config,
      async options => writeFakeFamily(options.backupDir, true),
    ))).rejects.toThrow(/digest mismatch/);

    expect(existsSync(join(backupRootDir, '20260715T150000000Z'))).toBe(false);
  });

  it('rejects an empty dump even when restore verification is disabled', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { verifyRestore: false });

    await expect(runFleetAuthConsistentBackupCycle(makeCycleOptions(
      root,
      config,
      async options => writeFakeFamily(options.backupDir, false, true),
    ))).rejects.toThrow(/sizeBytes is invalid/);

    expect(existsSync(join(backupRootDir, BACKUP_TIMESTAMP))).toBe(false);
  });

  it('rejects a missing workspace member before publishing the encrypted family', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { verifyRestore: true });
    await expect(runFleetAuthConsistentBackupCycle(makeCycleOptions(
      root,
      config,
      async options => writeFakeFamily(options.backupDir),
      async ({ fleetManifestPath }) => {
        const artifactDir = join(
          dirname(fleetManifestPath),
          'companions',
          COMPANION_ID,
          BACKUP_TIMESTAMP,
        );
        rmSync(join(artifactDir, 'workspace-tree/journal/marker.txt'));
        verifyWorkspaceTreeSnapshot(artifactDir);
      },
    ))).rejects.toThrow(/missing|mismatch/i);
    expect(existsSync(join(backupRootDir, BACKUP_TIMESTAMP))).toBe(false);
  });

  it('rejects a deleted session snapshot member before publishing the encrypted family', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { verifyRestore: true });
    await expect(runFleetAuthConsistentBackupCycle(makeCycleOptions(
      root,
      config,
      async options => writeFakeFamily(options.backupDir),
      async ({ fleetManifestPath }) => {
        rmSync(join(
          dirname(fleetManifestPath),
          'companions',
          COMPANION_ID,
          BACKUP_TIMESTAMP,
          'sessions',
          'channel.jsonl',
        ));
        await restoreCompanionSliceForCycleVerification(root, fleetManifestPath);
      },
    ))).rejects.toThrow(/session snapshot membership mismatch/u);
    expect(existsSync(join(backupRootDir, BACKUP_TIMESTAMP))).toBe(false);
  });

  it('rejects a tampered session snapshot member before publishing the encrypted family', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { verifyRestore: true });
    await expect(runFleetAuthConsistentBackupCycle(makeCycleOptions(
      root,
      config,
      async options => writeFakeFamily(options.backupDir),
      async ({ fleetManifestPath }) => {
        writeFileSync(join(
          dirname(fleetManifestPath),
          'companions',
          COMPANION_ID,
          BACKUP_TIMESTAMP,
          'sessions',
          'channel.jsonl',
        ), '{"session":"tampered"}\n');
        await restoreCompanionSliceForCycleVerification(root, fleetManifestPath);
      },
    ))).rejects.toThrow(/session snapshot digest mismatch/u);
    expect(existsSync(join(backupRootDir, BACKUP_TIMESTAMP))).toBe(false);
  });

  it('rejects a partial session JSONL line before publishing the encrypted family', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { verifyRestore: true });
    const options = makeCycleOptions(
      root,
      config,
      async coordinatorOptions => writeFakeFamily(coordinatorOptions.backupDir),
      async ({ fleetManifestPath }) => {
        await restoreCompanionSliceForCycleVerification(root, fleetManifestPath);
      },
    );
    writeFileSync(
      join(root, 'companion-data', COMPANION_ID, 'state', 'sessions', 'channel.jsonl'),
      '{"session":',
    );

    await expect(runFleetAuthConsistentBackupCycle(options))
      .rejects.toThrow(/session snapshot has invalid JSONL/u);
    expect(existsSync(join(backupRootDir, BACKUP_TIMESTAMP))).toBe(false);
  });

  it('rejects a restore-only failure before publishing the encrypted family', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { verifyRestore: true });
    await expect(runFleetAuthConsistentBackupCycle(makeCycleOptions(
      root,
      config,
      async options => writeFakeFamily(options.backupDir),
      async () => { throw new Error('scratch restore rejected durable family'); },
    ))).rejects.toThrow('scratch restore rejected durable family');
    expect(existsSync(join(backupRootDir, BACKUP_TIMESTAMP))).toBe(false);
  });
});

function scheduledBackupHandler(scheduler: Scheduler): () => Promise<void> {
  const task = scheduler.getTask(SCHEDULED_BACKUP_TASK_ID);
  if (!task) throw new Error('Scheduled backup task was not registered');
  return async () => await task.handler();
}

describe('registerScheduledFleetAuthBackupTask', () => {
  it('records success when the gateway-owned family cycle completes', async () => {
    const root = makeRoot();
    const config = makeConfig(join(root, 'backups'));
    const scheduler = new Scheduler(new EventBus());
    const onBackupFailure = vi.fn();
    registerScheduledFleetAuthBackupTask({
      scheduler,
      cycleOptions: makeCycleOptions(root, config, async options => writeFakeFamily(options.backupDir)),
      config,
      onBackupFailure,
      runCycle: async () => ({
        backupDir: join(root, 'backups/complete'),
        manifestVerified: true,
        familyRestoreVerified: true,
        encrypted: true,
        prunedBackupDirs: [],
        recoveryUnitCount: 2,
      }),
    });

    await scheduledBackupHandler(scheduler)();

    const diagnostics = buildRuntimeDiagnosticsSnapshot({ includeFileLogs: false });
    expect(diagnostics.backup.lastSuccess).toMatchObject({
      status: 'success',
      taskId: SCHEDULED_BACKUP_TASK_ID,
    });
    expect(onBackupFailure).not.toHaveBeenCalled();
  });

  it('records, reports, and rethrows a family-cycle failure', async () => {
    const root = makeRoot();
    const config = makeConfig(join(root, 'backups'));
    const scheduler = new Scheduler(new EventBus());
    const onBackupFailure = vi.fn();
    const failure = new Error('consistent family failed');
    registerScheduledFleetAuthBackupTask({
      scheduler,
      cycleOptions: makeCycleOptions(root, config, async options => writeFakeFamily(options.backupDir)),
      config,
      onBackupFailure,
      runCycle: async () => { throw failure; },
    });

    await expect(scheduledBackupHandler(scheduler)()).rejects.toBe(failure);
    expect(onBackupFailure).toHaveBeenCalledWith(failure);
    const diagnostics = buildRuntimeDiagnosticsSnapshot({ includeFileLogs: false });
    expect(diagnostics.backup.lastFailure).toMatchObject({
      status: 'failure',
      taskId: SCHEDULED_BACKUP_TASK_ID,
      message: 'consistent family failed',
    });
  });

  it('awaits operator-alert escalation before rethrowing a family-cycle failure', async () => {
    const root = makeRoot();
    const config = makeConfig(join(root, 'backups'));
    const scheduler = new Scheduler(new EventBus());
    const failure = new Error('consistent family failed');
    let releaseAlert: (() => void) | undefined;
    const onBackupFailure = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseAlert = resolve;
      });
    });
    registerScheduledFleetAuthBackupTask({
      scheduler,
      cycleOptions: makeCycleOptions(root, config, async options => writeFakeFamily(options.backupDir)),
      config,
      onBackupFailure,
      runCycle: async () => { throw failure; },
    });

    const handled = scheduledBackupHandler(scheduler)();
    await vi.waitFor(() => expect(onBackupFailure).toHaveBeenCalledWith(failure));
    let settled = false;
    void handled.catch(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    releaseAlert?.();
    await expect(handled).rejects.toBe(failure);
  });
});

// ── Startup guarantees for the gateway-owned lane (psfn-framework-vcyxv) ──
// The deployed lane logged "enabled" against a backup root the gateway could not
// write and, on a 6h in-memory interval seeded with skipFirstRun, never fired a
// cycle in a pod that lived under 6h. Both directions were silent.

const HOUR_MS = 60 * 60 * 1000;
const SIX_HOURS_MS = 6 * HOUR_MS;

function completedCycleResult(root: string): FleetAuthConsistentBackupCycleResult {
  return {
    backupDir: join(root, 'backups', BACKUP_TIMESTAMP),
    manifestVerified: true,
    familyRestoreVerified: true,
    encrypted: true,
    prunedBackupDirs: [],
    recoveryUnitCount: 2,
  };
}

function armLane(
  root: string,
  config: BackupRuntimeConfig,
  runCycle: () => Promise<FleetAuthConsistentBackupCycleResult>,
): { scheduler: Scheduler; runCycle: ReturnType<typeof vi.fn> } {
  const scheduler = new Scheduler(new EventBus());
  const spy = vi.fn(runCycle);
  registerScheduledFleetAuthBackupTask({
    scheduler,
    cycleOptions: makeCycleOptions(root, config, async options => writeFakeFamily(options.backupDir)),
    config,
    runCycle: spy,
  });
  return { scheduler, runCycle: spy };
}

describe('fleet auth backup lane writability gate', () => {
  it('fails closed instead of arming a lane whose backup root cannot hold a tree', () => {
    const root = makeRoot();
    // A file where the root should be reproduces "BACKUP_ROOT_DIR points at a
    // path this process cannot turn into a backup tree" deterministically, with
    // no dependence on the uid running the suite.
    const backupRootDir = join(root, 'backups');
    writeFileSync(backupRootDir, 'not a directory\n');
    const config = makeConfig(backupRootDir);
    const scheduler = new Scheduler(new EventBus());
    const runCycle = vi.fn(async () => completedCycleResult(root));

    expect(() => registerScheduledFleetAuthBackupTask({
      scheduler,
      cycleOptions: makeCycleOptions(root, config, async options => writeFakeFamily(options.backupDir)),
      config,
      runCycle,
    })).toThrow(BackupRootNotWritableError);

    expect(scheduler.getTask(SCHEDULED_BACKUP_TASK_ID)).toBeUndefined();
    expect(runCycle).not.toHaveBeenCalled();
  });

  const asNonRoot = process.getuid?.() === 0 ? it.skip : it;
  asNonRoot('fails closed when the root exists but the runtime uid cannot write it', () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    mkdirSync(backupRootDir, { recursive: true });
    // The deployed shape exactly: the directory exists and lists fine, the
    // process just cannot create anything in it.
    chmodSync(backupRootDir, 0o555);
    const config = makeConfig(backupRootDir);
    const scheduler = new Scheduler(new EventBus());
    try {
      expect(() => registerScheduledFleetAuthBackupTask({
        scheduler,
        cycleOptions: makeCycleOptions(root, config, async options => writeFakeFamily(options.backupDir)),
        config,
        runCycle: async () => completedCycleResult(root),
      })).toThrow(BackupRootNotWritableError);
    } finally {
      chmodSync(backupRootDir, 0o755);
    }
    expect(scheduler.getTask(SCHEDULED_BACKUP_TASK_ID)).toBeUndefined();
  });
});

describe('fleet auth backup lane catch-up watermark', () => {
  it('runs a catch-up cycle at boot when the lane has never completed one', async () => {
    const root = makeRoot();
    const config = makeConfig(join(root, 'backups'), { intervalMs: SIX_HOURS_MS });
    const { scheduler, runCycle } = armLane(root, config, async () => completedCycleResult(root));

    // A pod that never lives six hours: under the old in-memory seeding this
    // task was never due, so the lane produced nothing and reported nothing.
    await scheduler.tick();

    expect(runCycle).toHaveBeenCalledTimes(1);
  });

  it('runs a catch-up cycle when the persisted watermark is older than the interval', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    mkdirSync(backupRootDir, { recursive: true });
    const staleAt = new Date(Date.now() - SIX_HOURS_MS - HOUR_MS).toISOString();
    writeFleetAuthBackupWatermark(backupRootDir, {
      lastAttemptStartedAt: staleAt,
      lastCompletedAt: staleAt,
      lastBackupDir: join(backupRootDir, '20260715T090000000Z'),
    });
    const config = makeConfig(backupRootDir, { intervalMs: SIX_HOURS_MS });
    const { scheduler, runCycle } = armLane(root, config, async () => completedCycleResult(root));

    await scheduler.tick();

    expect(runCycle).toHaveBeenCalledTimes(1);
  });

  it('waits out the remaining interval when the watermark is recent', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    mkdirSync(backupRootDir, { recursive: true });
    const recentAt = new Date(Date.now() - HOUR_MS).toISOString();
    writeFleetAuthBackupWatermark(backupRootDir, {
      lastAttemptStartedAt: recentAt,
      lastCompletedAt: recentAt,
    });
    const config = makeConfig(backupRootDir, { intervalMs: SIX_HOURS_MS });
    const { scheduler, runCycle } = armLane(root, config, async () => completedCycleResult(root));

    // Restart churn must not turn a heavy consistent backup into a per-boot job.
    await scheduler.tick();

    expect(runCycle).not.toHaveBeenCalled();
  });

  it('stamps the attempt before the cycle and the completion after it', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { intervalMs: SIX_HOURS_MS });
    const watermarkPath = join(backupRootDir, FLEET_AUTH_BACKUP_WATERMARK_NAME);
    let attemptStampedBeforeCycle = false;
    const { scheduler } = armLane(root, config, async () => {
      attemptStampedBeforeCycle = existsSync(watermarkPath);
      return completedCycleResult(root);
    });

    await scheduler.tick();

    expect(attemptStampedBeforeCycle).toBe(true);
    const persisted = JSON.parse(readFileSync(watermarkPath, 'utf8')) as {
      lastAttemptStartedAt: string;
      lastCompletedAt?: string;
      lastBackupDir?: string;
    };
    expect(Number.isFinite(Date.parse(persisted.lastAttemptStartedAt))).toBe(true);
    expect(Number.isFinite(Date.parse(persisted.lastCompletedAt ?? ''))).toBe(true);
    expect(persisted.lastBackupDir).toBe(completedCycleResult(root).backupDir);
  });

  it('stamps the attempt even when the cycle fails, so a crash loop cannot re-run it', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const config = makeConfig(backupRootDir, { intervalMs: SIX_HOURS_MS });
    const { scheduler, runCycle } = armLane(root, config, async () => {
      throw new Error('consistent family failed');
    });

    await scheduler.tick();
    expect(runCycle).toHaveBeenCalledTimes(1);

    const persisted = JSON.parse(
      readFileSync(join(backupRootDir, FLEET_AUTH_BACKUP_WATERMARK_NAME), 'utf8'),
    ) as { lastAttemptStartedAt: string; lastCompletedAt?: string };
    expect(Number.isFinite(Date.parse(persisted.lastAttemptStartedAt))).toBe(true);
    expect(persisted.lastCompletedAt).toBeUndefined();

    // A fresh process seeded from that watermark stays quiet for the interval.
    const { scheduler: rebooted, runCycle: afterReboot } = armLane(
      root,
      config,
      async () => completedCycleResult(root),
    );
    await rebooted.tick();
    expect(afterReboot).not.toHaveBeenCalled();
  });
});

describe('fleet auth backup partial-failure attribution', () => {
  const partialFailure = () => new FleetBackupPartialFailureError(
    '/runtime/backups/fleet-backup-manifest.json',
    [
      {
        kind: 'companion',
        companionId: COMPANION_ID,
        postgresSchema: 'companion_one',
        status: 'failure',
        error: 'pg_dump exited 1',
      },
      {
        kind: 'cluster',
        postgresSchema: 'shared',
        status: 'success',
        artifactDir: '/runtime/backups/cluster',
      },
    ],
  );

  it('records which companion failed instead of a bare message', async () => {
    const root = makeRoot();
    const config = makeConfig(join(root, 'backups'));
    const failure = partialFailure();
    const { scheduler } = armLane(root, config, async () => { throw failure; });

    await scheduler.tick();

    const diagnostics = buildRuntimeDiagnosticsSnapshot({ includeFileLogs: false });
    expect(diagnostics.backup.lastFailure).toMatchObject({
      status: 'failure',
      taskId: SCHEDULED_BACKUP_TASK_ID,
    });
    expect(diagnostics.backup.lastFailure?.details).toMatchObject({
      partialFailure: true,
      fleetManifestPath: '/runtime/backups/fleet-backup-manifest.json',
      failedUnitCount: 1,
      totalUnitCount: 2,
      failedUnits: `companion(${COMPANION_ID})`,
    });
  });

  it('raises a typed partial failure when the fleet runner reports an incomplete family', async () => {
    const root = makeRoot();
    const config = makeConfig(join(root, 'backups'));
    await expect(runFleetAuthConsistentBackupCycleImplementation(
      makeCycleOptions(root, config, async options => writeFakeFamily(options.backupDir)),
      {
        formatTimestamp: () => BACKUP_TIMESTAMP,
        mirrorBackup: () => undefined,
        runFleetBackup: async () => ({
          mode: 'per-companion',
          backupRootDir: config.rootDir,
          fleetManifestPath: join(config.rootDir, 'fleet-backup-manifest.json'),
          overallStatus: 'failure',
          units: [{
            kind: 'companion',
            companionId: COMPANION_ID,
            postgresSchema: 'companion_one',
            status: 'failure',
            error: 'pg_dump exited 1',
          }],
          results: [],
        }),
      },
    )).rejects.toThrow(FleetBackupPartialFailureError);
  });
});
