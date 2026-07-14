import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresPool } from '../postgres.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import {
  runFleetBackupCycle,
  type FleetBackupCompanionUnit,
} from './service.js';
import {
  restoreFleetClusterArtifact,
  restoreFleetCompanionSlice,
  restoreFleetGroupArtifact,
} from './fleet-restore.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const COMPANION_A = '11111111-1111-4111-8111-111111111111';
const COMPANION_B = '22222222-2222-4222-8222-222222222222';
const roots: string[] = [];
let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres integration harness is not available');
  return (await harness.createDatabase()).databaseUrl;
}

function createFleetFiles(root: string): {
  companions: FleetBackupCompanionUnit[];
  systemDataDir: string;
  sharedWorkspacePath: string;
} {
  const systemDataDir = join(root, 'system-data');
  mkdirSync(systemDataDir, { recursive: true });
  writeFileSync(join(systemDataDir, 'settings.json'), '{}\n');
  writeFileSync(join(systemDataDir, 'models.json'), '{"schemaVersion":1,"models":[]}\n');
  writeFileSync(join(systemDataDir, 'channels.json'), '{}\n');
  writeFileSync(join(systemDataDir, 'backup.json'), JSON.stringify({
    intervalHours: 12,
    maxRotatingBackups: 9,
    maxWeeklyBackups: 2,
    maxMonthlyBackups: 1,
    mirrorDir: '',
    verifyRestore: false,
    groupMode: false,
    encryption: { mode: 'off' },
  }));

  const companions = [
    [COMPANION_A, 'companion_alpha', 'alpha'],
    [COMPANION_B, 'companion_beta', 'beta'],
  ].map(([companionId, postgresSchema, marker]) => {
    const companionDataDir = join(root, 'companion-data', companionId);
    const sessionsDir = join(companionDataDir, 'state', 'sessions');
    const personalWorkspacePath = join(root, 'workspaces', 'personal', companionId);
    mkdirSync(join(companionDataDir, 'vault'), { recursive: true });
    mkdirSync(sessionsDir, { recursive: true });
    mkdirSync(join(personalWorkspacePath, 'journal'), { recursive: true });
    writeFileSync(join(companionDataDir, 'companion.json'), JSON.stringify({ id: companionId }));
    writeFileSync(join(companionDataDir, 'vault', 'marker.txt'), `${marker}\n`);
    writeFileSync(join(sessionsDir, 'channel.jsonl'), '{"id":1}\n');
    writeFileSync(join(personalWorkspacePath, 'journal', 'marker.txt'), `${marker}\n`);
    return { companionId, postgresSchema, companionDataDir, sessionsDir, personalWorkspacePath };
  });
  const sharedWorkspacePath = join(root, 'workspaces', 'shared');
  mkdirSync(join(sharedWorkspacePath, 'artifacts'), { recursive: true });
  writeFileSync(join(sharedWorkspacePath, 'artifacts', 'world.txt'), 'shared\n');
  return { companions, systemDataDir, sharedWorkspacePath };
}

async function expectProbe(databaseUrl: string, schema: string, expected: string): Promise<void> {
  const pool = createPostgresPool(databaseUrl, { max: 1 });
  try {
    const result = await pool.query<{ marker: string }>(`SELECT marker FROM "${schema}".restore_probe`);
    expect(result.rows).toEqual([{ marker: expected }]);
  } finally {
    await pool.end();
  }
}

describe('fleet restore against real Postgres', () => {
  it('restores exact companion/shared/group scopes and rolls back collisions and partial failures', async () => {
    const root = join(tmpdir(), `psfn-fleet-restore-pg-${Date.now()}`);
    roots.push(root);
    const sourceDatabaseUrl = await freshDatabaseUrl();
    const sourcePool = createPostgresPool(sourceDatabaseUrl, { max: 1 });
    try {
      await sourcePool.query(`
        CREATE SCHEMA companion_alpha;
        CREATE TABLE companion_alpha.restore_probe(marker text NOT NULL);
        INSERT INTO companion_alpha.restore_probe VALUES ('alpha');
        CREATE SCHEMA companion_beta;
        CREATE TABLE companion_beta.restore_probe(marker text NOT NULL);
        INSERT INTO companion_beta.restore_probe VALUES ('beta');
        CREATE SCHEMA shared;
        CREATE TABLE shared.restore_probe(marker text NOT NULL);
        INSERT INTO shared.restore_probe VALUES ('shared');
      `);
    } finally {
      await sourcePool.end();
    }

    const fleet = createFleetFiles(root);
    const perCompanion = await runFleetBackupCycle({
      postgres: { databaseUrl: sourceDatabaseUrl },
      companions: fleet.companions,
      systemDataDir: fleet.systemDataDir,
      sharedWorkspacePath: fleet.sharedWorkspacePath,
      backupRootDir: join(root, 'backups-per-companion'),
      now: () => Date.UTC(2026, 6, 14, 5, 0, 0),
    });

    const sliceTargetUrl = await freshDatabaseUrl();
    const restorePostgres = { databaseUrl: sliceTargetUrl };
    const alphaDestinations = {
      companionDataDir: join(root, 'restore-slices', 'alpha-data'),
      personalWorkspacePath: join(root, 'restore-slices', 'alpha-workspace'),
    };
    await restoreFleetCompanionSlice({
      fleetManifestPath: perCompanion.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: alphaDestinations,
      postgres: restorePostgres,
    });
    await restoreFleetCompanionSlice({
      fleetManifestPath: perCompanion.fleetManifestPath,
      companionId: COMPANION_B,
      destinations: {
        companionDataDir: join(root, 'restore-slices', 'beta-data'),
        personalWorkspacePath: join(root, 'restore-slices', 'beta-workspace'),
      },
      postgres: restorePostgres,
    });
    await restoreFleetClusterArtifact({
      fleetManifestPath: perCompanion.fleetManifestPath,
      destinations: {
        systemDataDir: join(root, 'restore-slices', 'system'),
        sharedWorkspacePath: join(root, 'restore-slices', 'shared-workspace'),
      },
      postgres: restorePostgres,
    });
    await expectProbe(sliceTargetUrl, 'companion_alpha', 'alpha');
    await expectProbe(sliceTargetUrl, 'companion_beta', 'beta');
    await expectProbe(sliceTargetUrl, 'shared', 'shared');
    expect(readFileSync(join(alphaDestinations.companionDataDir, 'vault', 'marker.txt'), 'utf8')).toBe('alpha\n');

    const group = await runFleetBackupCycle({
      postgres: { databaseUrl: sourceDatabaseUrl },
      companions: fleet.companions,
      systemDataDir: fleet.systemDataDir,
      sharedWorkspacePath: fleet.sharedWorkspacePath,
      backupRootDir: join(root, 'backups-group'),
      groupMode: true,
      groupCompanionDataDir: join(root, 'companion-data'),
      groupWorkspacesRoot: join(root, 'workspaces'),
      now: () => Date.UTC(2026, 6, 14, 5, 1, 0),
    });
    const groupTargetUrl = await freshDatabaseUrl();
    await restoreFleetGroupArtifact({
      fleetManifestPath: group.fleetManifestPath,
      destinations: {
        groupCompanionDataDir: join(root, 'restore-group', 'companion-data'),
        groupWorkspacesRoot: join(root, 'restore-group', 'workspaces'),
        systemDataDir: join(root, 'restore-group', 'system'),
      },
      postgres: { databaseUrl: groupTargetUrl },
    });
    await expectProbe(groupTargetUrl, 'companion_alpha', 'alpha');
    await expectProbe(groupTargetUrl, 'companion_beta', 'beta');
    await expectProbe(groupTargetUrl, 'shared', 'shared');

    const collisionTargetUrl = await freshDatabaseUrl();
    const collisionPool = createPostgresPool(collisionTargetUrl, { max: 1 });
    await collisionPool.query('CREATE SCHEMA companion_alpha');
    await collisionPool.end();
    const collisionDestination = join(root, 'restore-collision');
    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: perCompanion.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: {
        companionDataDir: join(collisionDestination, 'data'),
        personalWorkspacePath: join(collisionDestination, 'workspace'),
      },
      postgres: { databaseUrl: collisionTargetUrl },
    })).rejects.toThrow(/schema already exists/);
    expect(existsSync(join(collisionDestination, 'data'))).toBe(false);

    const failureTargetUrl = await freshDatabaseUrl();
    const failurePool = createPostgresPool(failureTargetUrl, { max: 1 });
    await failurePool.query(`
      CREATE FUNCTION public.reject_restore_table() RETURNS event_trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected restore failure'; END $$;
      CREATE EVENT TRIGGER reject_restore_table ON ddl_command_start
      WHEN TAG IN ('CREATE TABLE') EXECUTE FUNCTION public.reject_restore_table();
    `);
    await failurePool.end();
    const failureDestination = join(root, 'restore-failure');
    await expect(restoreFleetCompanionSlice({
      fleetManifestPath: perCompanion.fleetManifestPath,
      companionId: COMPANION_A,
      destinations: {
        companionDataDir: join(failureDestination, 'data'),
        personalWorkspacePath: join(failureDestination, 'workspace'),
      },
      postgres: { databaseUrl: failureTargetUrl },
    })).rejects.toThrow(/pg_restore failed/);
    const failureVerificationPool = createPostgresPool(failureTargetUrl, { max: 1 });
    try {
      const schema = await failureVerificationPool.query<{ exists: boolean }>(
        "SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'companion_alpha') AS exists",
      );
      expect(schema.rows[0]?.exists).toBe(false);
    } finally {
      await failureVerificationPool.end();
    }
    expect(existsSync(join(failureDestination, 'data'))).toBe(false);
    expect(existsSync(join(failureDestination, 'workspace'))).toBe(false);
  }, INTEGRATION_TIMEOUT_MS);
});
