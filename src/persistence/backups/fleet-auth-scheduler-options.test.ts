import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ResolvedCompanionsFleetConfig } from '../../system/config/companions-config.js';
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import type { BackupRuntimeConfig } from './config.js';
import { buildFleetAuthBackupCycleOptions } from './fleet-scheduler.js';
import { FleetAuthAuthorityFloorStore } from '../postgres/fleet-auth/authority-floor.js';
import type { KubernetesHelmBackupConfig } from './kubernetes-helm.js';

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
const KUBERNETES_HELM: KubernetesHelmBackupConfig = {
  chartSourceDir: '/runtime/chart',
  releaseName: 'psfn',
  namespace: 'psfn-test',
  revision: 1,
  chartName: 'psfn',
  chartVersion: '1.0.0',
  appVersion: '1.0.0',
  chartContentSha256: 'a'.repeat(64),
  images: {
    agent: { repository: 'example/agent', tag: '1.0.0' },
    gateway: { repository: 'example/gateway', tag: '1.0.0' },
    garden: { repository: 'example/garden', tag: '1.0.0' },
  },
};

const roots: string[] = [];

function makeAuthorityFloors(): FleetAuthAuthorityFloorStore {
  const root = join(tmpdir(), `psfn-fleet-auth-options-${Date.now()}-${Math.random()}`);
  mkdirSync(root, { recursive: true });
  roots.push(root);
  const floors = new FleetAuthAuthorityFloorStore(root);
  floors.open({ activationGeneration: 1, databaseHasDurableAuthority: false });
  return floors;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('buildFleetAuthBackupCycleOptions', () => {
  it('derives every recovery slice with distinct authoritative companion owners and shared access', () => {
    const authorityFloors = makeAuthorityFloors();
    const options = buildFleetAuthBackupCycleOptions({
      fleet: FLEET,
      systemDataDir: '/runtime/system-data',
      backupRestoreDatabaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
      schemaOwnerDatabaseUrl: 'postgresql://auth_migration:secret@127.0.0.1:5432/app',
      roles: ROLES,
      authorityFloors,
      schemaAccessContracts: [
        {
          kind: 'companion',
          schema: 'companion_one',
          ownerRole: 'companion_one_runtime',
          runtimeRoles: ['companion_one_runtime'],
        },
        {
          kind: 'companion',
          schema: 'companion_two',
          ownerRole: 'companion_two_runtime',
          runtimeRoles: ['companion_two_runtime'],
        },
        {
          kind: 'shared',
          schema: 'shared',
          ownerRole: 'shared_migration',
          runtimeRoles: ['companion_one_runtime', 'companion_two_runtime'],
        },
      ],
      backupConfig: BACKUP_CONFIG,
      kubernetesHelm: KUBERNETES_HELM,
      pgDumpBinary: '/usr/local/bin/pg_dump',
    });

    expect(options).toMatchObject({
      backupRestoreDatabaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
      roles: ROLES,
      schemas: [
        {
          kind: 'companion', schema: 'companion_one', ownerRole: 'companion_one_runtime',
          runtimeRoles: ['companion_one_runtime'],
        },
        {
          kind: 'companion', schema: 'companion_two', ownerRole: 'companion_two_runtime',
          runtimeRoles: ['companion_two_runtime'],
        },
        {
          kind: 'shared', schema: 'shared', ownerRole: 'shared_migration',
          runtimeRoles: ['companion_one_runtime', 'companion_two_runtime'],
        },
      ],
      systemDataDir: '/runtime/system-data',
      backupRootDir: '/runtime/backups',
      config: BACKUP_CONFIG,
      pgDumpBinary: '/usr/local/bin/pg_dump',
      authorityFloors,
      fleetBackupOptions: {
        postgres: {
          databaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
          restoreVerifyDatabaseUrl:
            'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app_restore_verify',
        },
        companions: [
          {
            companionId: FLEET.companions[0].companionId,
            companionDataDir: FLEET.companions[0].companionDataDir,
            personalWorkspacePath: FLEET.companions[0].personalWorkspacePath,
          },
          {
            companionId: FLEET.companions[1].companionId,
            companionDataDir: FLEET.companions[1].companionDataDir,
            personalWorkspacePath: FLEET.companions[1].personalWorkspacePath,
          },
        ],
        sharedWorkspacePath: FLEET.sharedWorkspacePath,
        kubernetesHelm: KUBERNETES_HELM,
        groupMode: false,
      },
    });
    expect(options.verifyFamilyRestore).toBeTypeOf('function');
  });

  it('rejects one companion role mapped across sibling schemas', () => {
    expect(() => buildFleetAuthBackupCycleOptions({
      fleet: FLEET,
      systemDataDir: '/runtime/system-data',
      backupRestoreDatabaseUrl: 'postgresql://auth_backup_restore:secret@127.0.0.1:5432/app',
      schemaOwnerDatabaseUrl: 'postgresql://auth_migration:secret@127.0.0.1:5432/app',
      roles: ROLES,
      authorityFloors: makeAuthorityFloors(),
      schemaAccessContracts: [
        {
          kind: 'companion', schema: 'companion_one', ownerRole: 'companion_runtime',
          runtimeRoles: ['companion_runtime'],
        },
        {
          kind: 'companion', schema: 'companion_two', ownerRole: 'companion_runtime',
          runtimeRoles: ['companion_runtime'],
        },
        {
          kind: 'shared', schema: 'shared', ownerRole: 'shared_migration',
          runtimeRoles: ['companion_runtime'],
        },
      ],
      backupConfig: BACKUP_CONFIG,
    })).toThrow(/one companion role across sibling schemas/i);
  });
});
