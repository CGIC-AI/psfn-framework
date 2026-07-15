import { describe, expect, it } from 'vitest';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import type { BackupRuntimeConfig } from './config.js';
import { buildFleetAuthBackupCycleOptions } from './fleet-scheduler.js';

const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'auth_runtime',
  migration: 'auth_migration',
  backupRestore: 'auth_backup_restore',
};

const FLEET: ResolvedCompanionsFleetConfig = {
  persistenceRoot: '/runtime',
  workspacesRoot: '/runtime/workspaces',
  sharedWorkspacePath: '/runtime/workspaces/shared',
  companions: [
    {
      companionId: '11111111-1111-4111-8111-111111111111',
      companionDataDir: '/runtime/companion-data/11111111-1111-4111-8111-111111111111',
      characterCardPath: '/runtime/companion-data/11111111-1111-4111-8111-111111111111/character.json',
      postgresSchema: 'companion_one',
      personalWorkspacePath: '/runtime/workspaces/personal/11111111-1111-4111-8111-111111111111',
    },
    {
      companionId: '22222222-2222-4222-8222-222222222222',
      companionDataDir: '/runtime/companion-data/22222222-2222-4222-8222-222222222222',
      characterCardPath: '/runtime/companion-data/22222222-2222-4222-8222-222222222222/character.json',
      postgresSchema: 'companion_two',
      personalWorkspacePath: '/runtime/workspaces/personal/22222222-2222-4222-8222-222222222222',
    },
  ],
};

const BACKUP_CONFIG: BackupRuntimeConfig = {
  intervalMs: 60_000,
  maxRotatingBackups: 9,
  maxWeeklyBackups: 2,
  maxMonthlyBackups: 1,
  rootDir: '/runtime/backups',
  mirrorDir: '/mirror/backups',
  verifyRestore: true,
  groupMode: false,
  encryption: {
    mode: 'required',
    keyRef: { kind: 'env', envName: 'PSFN_BACKUP_TEST_KEY' },
    passphrase: 'test-backup-secret',
  },
};

describe('buildFleetAuthBackupCycleOptions', () => {
  it('derives every companion schema plus exactly one shared schema', () => {
    const options = buildFleetAuthBackupCycleOptions({
      fleet: FLEET,
      systemDataDir: '/runtime/system-data',
      backupRestoreDatabaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
      roles: ROLES,
      backupConfig: BACKUP_CONFIG,
      pgDumpBinary: '/usr/local/bin/pg_dump',
    });

    expect(options).toEqual({
      backupRestoreDatabaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
      roles: ROLES,
      schemas: [
        { kind: 'companion', schema: 'companion_one' },
        { kind: 'companion', schema: 'companion_two' },
        { kind: 'shared', schema: 'shared' },
      ],
      systemDataDir: '/runtime/system-data',
      backupRootDir: '/runtime/backups',
      config: BACKUP_CONFIG,
      pgDumpBinary: '/usr/local/bin/pg_dump',
    });
  });
});
