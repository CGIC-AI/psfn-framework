import { createHash } from 'node:crypto';
import {
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
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import type { BackupRuntimeConfig } from './config.js';
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

const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'auth_runtime',
  migration: 'auth_migration',
  backupRestore: 'auth_backup_restore',
};

const ENCRYPTION: BackupEncryptionRuntimeConfig = {
  mode: 'required',
  keyRef: { kind: 'env', envName: 'PSFN_BACKUP_TEST_KEY' },
  passphrase: 'test-backup-secret',
};

const roots: string[] = [];

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
    writeFileSync(absolutePath, `${file.kind}-bytes\n`, 'utf8');
  }
  const artifacts: FleetAuthBackupArtifact[] = files.map(file => ({
    kind: file.kind,
    path: file.path,
    ...(file.schema ? { postgresSchema: file.schema } : {}),
    ...(file.kind === 'companion' || file.kind === 'shared'
      ? { runtimeRoles: ['companion_runtime'] }
      : {}),
    ...hashArtifact(join(backupDir, file.path)),
  }));
  const manifestPath = join(backupDir, FLEET_AUTH_BACKUP_MANIFEST_NAME);
  writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 3,
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
): FleetAuthConsistentBackupCycleOptions {
  return {
    backupRestoreDatabaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
    roles: ROLES,
    schemas: [
      { kind: 'companion', schema: 'companion_one', runtimeRoles: ['companion_runtime'] },
      { kind: 'shared', schema: 'shared', runtimeRoles: ['companion_runtime'] },
    ],
    systemDataDir: join(root, 'system-data'),
    backupRootDir: config.rootDir,
    config,
    now: () => Date.UTC(2026, 6, 15, 15, 0, 0),
    runCoordinator,
  };
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
    const binDir = join(root, 'bin');
    const pgRestoreLog = join(root, 'pg-restore.log');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'pg_restore'),
      `#!/bin/sh\nprintf '%s\\n' "$*" >> '${pgRestoreLog}'\nprintf "1; 0 100 TABLE public sample owner\\n"\n`,
      { mode: 0o755 },
    );
    const oldName = '20260714T150000000Z';
    mkdirSync(join(backupRootDir, oldName), { recursive: true });
    mkdirSync(join(mirrorDir, oldName), { recursive: true });
    writeFileSync(join(backupRootDir, oldName, 'old.txt'), 'old\n');
    writeFileSync(join(mirrorDir, oldName, 'old.txt'), 'old\n');
    const config = makeConfig(backupRootDir, { mirrorDir, verifyRestore: true });
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ''}`;
    let result: Awaited<ReturnType<typeof runFleetAuthConsistentBackupCycle>>;
    try {
      result = await runFleetAuthConsistentBackupCycle(makeCycleOptions(
        root,
        config,
        async options => writeFakeFamily(options.backupDir),
      ));
    } finally {
      process.env.PATH = priorPath;
    }

    expect(result).toMatchObject({
      manifestVerified: true,
      encrypted: true,
      mirrorDir,
      prunedBackupDirs: [join(backupRootDir, oldName)],
    });
    expect(existsSync(join(result.backupDir, ENCRYPTED_BACKUP_PAYLOAD_NAME))).toBe(true);
    expect(existsSync(join(result.backupDir, ENCRYPTED_BACKUP_MANIFEST_NAME))).toBe(true);
    expect(existsSync(join(mirrorDir, '20260715T150000000Z', ENCRYPTED_BACKUP_PAYLOAD_NAME)))
      .toBe(true);
    expect(existsSync(join(mirrorDir, oldName))).toBe(false);
    expect(readFileSync(pgRestoreLog, 'utf8').trim().split('\n')).toHaveLength(2);

    const restoredDir = join(root, 'restored');
    await decryptEncryptedBackupPackage({
      encryptedBackupDir: result.backupDir,
      outputDir: restoredDir,
      encryption: ENCRYPTION,
    });
    expect(existsSync(join(restoredDir, FLEET_AUTH_BACKUP_MANIFEST_NAME))).toBe(true);
    expect(readFileSync(join(restoredDir, 'postgres/companion_one.dump'), 'utf8'))
      .toBe('companion-bytes\n');
  });

  it('rejects a tampered family before publishing a backup', async () => {
    const root = makeRoot();
    const backupRootDir = join(root, 'backups');
    const binDir = join(root, 'bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'pg_restore'),
      '#!/bin/sh\nprintf "1; 0 100 TABLE companion_one sample owner\\n"\n',
      { mode: 0o755 },
    );
    const priorPath = process.env.PATH;
    process.env.PATH = `${binDir}:${priorPath ?? ''}`;
    const config = makeConfig(backupRootDir, {
      verifyRestore: true,
      encryption: ENCRYPTION,
    });
    try {
      await expect(runFleetAuthConsistentBackupCycle(makeCycleOptions(
        root,
        config,
        async options => writeFakeFamily(options.backupDir, true),
      ))).rejects.toThrow(/digest mismatch/);
    } finally {
      process.env.PATH = priorPath;
    }

    expect(existsSync(join(backupRootDir, '20260715T150000000Z'))).toBe(false);
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
        encrypted: true,
        prunedBackupDirs: [],
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
});
