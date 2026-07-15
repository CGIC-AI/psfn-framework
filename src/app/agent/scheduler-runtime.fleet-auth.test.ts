import { describe, expect, it } from 'vitest';
import { Scheduler } from '../../core/scheduler/scheduler.js';
import type { BackupRuntimeConfig } from '../../persistence/backups/config.js';
import { SCHEDULED_BACKUP_TASK_ID } from '../../persistence/backups/service.js';
import type { RuntimePathSnapshot } from '../../persistence/layout.js';
import { EventBus } from '../../shared/event-bus.js';
import type { FleetAuthVerifierConfig } from '../../system/config/fleet-auth-config.js';
import { registerAgentDatabaseBackupLane } from './scheduler-runtime.js';

const BACKUP_CONFIG: BackupRuntimeConfig = {
  intervalMs: 60_000,
  maxRotatingBackups: 9,
  maxWeeklyBackups: 2,
  maxMonthlyBackups: 1,
  rootDir: '/runtime/backups',
  mirrorDir: '',
  verifyRestore: false,
  groupMode: false,
  encryption: {
    mode: 'required',
    keyRef: { kind: 'env', envName: 'PSFN_BACKUP_TEST_KEY' },
    passphrase: 'test-backup-secret',
  },
};

const PATH_SNAPSHOT: RuntimePathSnapshot = {
  dataDir: '/runtime',
  systemDataDir: '/runtime/system-data',
  companionDataDir: '/runtime/companion-data',
  workspacePath: '/runtime/workspace',
  workspaceRoot: '/runtime/workspace',
  runtimePathLayout: {
    mode: 'production',
    runtimeRoot: '/runtime',
    systemDataDir: '/runtime/system-data',
    companionDataDir: '/runtime/companion-data',
    workspacePath: '/runtime/workspace',
    logsDir: '/runtime/logs',
    tempDir: '/runtime/tmp',
    backupsDir: '/runtime/backups',
  },
};

const VERIFIER: FleetAuthVerifierConfig = {
  kind: 'verifier',
  enabled: true,
  canonicalOrigin: 'https://auth.example.test',
  verifierKeys: [],
};

function buildScheduler(fleetAuthVerifier?: FleetAuthVerifierConfig): Scheduler {
  const eventBus = new EventBus();
  const scheduler = new Scheduler(eventBus);
  const config = {
    characterCardPath: '/runtime/companion-data/character.json',
    postgresDatabaseUrl: 'postgresql://companion:secret@127.0.0.1:5432/app',
    ...(fleetAuthVerifier ? { fleetAuthVerifier } : {}),
  };
  registerAgentDatabaseBackupLane({
    scheduler,
    eventBus,
    config,
    backupConfig: BACKUP_CONFIG,
    pathSnapshot: PATH_SNAPSHOT,
    env: {},
  });
  return scheduler;
}

describe('fleet-auth agent backup-lane handoff', () => {
  it('registers no database backup task when the verifier projection is present', () => {
    const scheduler = buildScheduler(VERIFIER);

    expect(scheduler.getTask(SCHEDULED_BACKUP_TASK_ID)).toBeUndefined();
  });

  it('preserves the single-companion database backup task when fleet auth is off', () => {
    const scheduler = buildScheduler();

    expect(scheduler.getTask(SCHEDULED_BACKUP_TASK_ID)).toMatchObject({
      id: SCHEDULED_BACKUP_TASK_ID,
      type: 'every',
      intervalMs: BACKUP_CONFIG.intervalMs,
    });
  });
});
