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
  invalidateRestoredMemorySubjectProjections,
  restoreFleetClusterArtifact,
  restoreFleetCompanionSlice,
  restoreFleetGroupArtifact,
} from './fleet-restore.js';
import {
  inspectFleetRestoreDatabaseMarker,
  prepareFleetRestoreDatabaseMarker,
  removeFleetRestoreDatabaseMarker,
  rollbackFleetRestoreDatabaseSchemas,
} from './fleet-restore-database-marker.js';

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
  it('invalidates restored memory subject projections before the database is accepted', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, { max: 1 });
    try {
      await pool.query(`
        CREATE SCHEMA companion_alpha;
        CREATE TABLE companion_alpha.l2_memories (
          id text PRIMARY KEY,
          authorization_revision bigint NOT NULL,
          subject_evidence_digest text
        );
        CREATE TABLE companion_alpha.l2_memory_subject_classifications (
          memory_id text PRIMARY KEY,
          status text NOT NULL,
          updated_at bigint NOT NULL
        );
        CREATE TABLE companion_alpha.l2_memory_subject_backfill_checkpoints (
          classifier_version integer PRIMARY KEY,
          cursor_memory_id text,
          completed boolean NOT NULL,
          processed_count bigint NOT NULL,
          updated_at bigint NOT NULL
        );
        INSERT INTO companion_alpha.l2_memories VALUES ('memory-1', 4, repeat('a', 64));
        INSERT INTO companion_alpha.l2_memory_subject_classifications VALUES ('memory-1', 'current', 1);
        INSERT INTO companion_alpha.l2_memory_subject_backfill_checkpoints VALUES (1, 'memory-1', TRUE, 1, 1);
      `);

      await invalidateRestoredMemorySubjectProjections({ databaseUrl }, ['companion_alpha']);
      const state = await pool.query<{
        authorization_revision: string;
        subject_evidence_digest: string | null;
        status: string;
        cursor_memory_id: string | null;
        completed: boolean;
        processed_count: string;
      }>(`
        SELECT memory.authorization_revision, memory.subject_evidence_digest,
               classification.status, checkpoint.cursor_memory_id,
               checkpoint.completed, checkpoint.processed_count
        FROM companion_alpha.l2_memories memory
        JOIN companion_alpha.l2_memory_subject_classifications classification
          ON classification.memory_id = memory.id
        CROSS JOIN companion_alpha.l2_memory_subject_backfill_checkpoints checkpoint
      `);
      expect(state.rows[0]).toEqual({
        authorization_revision: '5',
        subject_evidence_digest: null,
        status: 'invalidated',
        cursor_memory_id: null,
        completed: false,
        processed_count: '0',
      });
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('authenticates the exact durable marker inside schema rollback', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, { max: 1 });
    const operation = {
      operationId: '0123456789abcdef0123456789abcdef',
      operationIdentity: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    const foreignOperation = {
      operationId: 'abcdef0123456789abcdef0123456789',
      operationIdentity: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
    };
    try {
      await prepareFleetRestoreDatabaseMarker({ databaseUrl }, operation);
      await pool.query('CREATE SCHEMA companion_alpha');
      await expect(rollbackFleetRestoreDatabaseSchemas(
        { databaseUrl },
        foreignOperation,
        ['companion_alpha'],
      )).rejects.toThrow(/marker is missing or foreign/);
      expect(await pool.query<{ exists: boolean }>(
        "SELECT to_regnamespace('companion_alpha') IS NOT NULL AS exists",
      )).toMatchObject({ rows: [{ exists: true }] });

      await rollbackFleetRestoreDatabaseSchemas({ databaseUrl }, operation, ['companion_alpha']);
      expect(await pool.query<{ exists: boolean }>(
        "SELECT to_regnamespace('companion_alpha') IS NOT NULL AS exists",
      )).toMatchObject({ rows: [{ exists: false }] });
      await expect(inspectFleetRestoreDatabaseMarker({ databaseUrl }, operation))
        .resolves.toBe('prepared');
      await removeFleetRestoreDatabaseMarker({ databaseUrl }, operation);
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('authenticates query passwords with RFC3986 literal and percent decoding', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const adminPool = createPostgresPool(databaseUrl, { max: 1 });
    const roles: string[] = [];
    const cases = [
      ['literal+plus', 'literal+plus'],
      ['encoded+plus', 'encoded%2Bplus'],
      ['encoded space', 'encoded%20space'],
      ['encoded%percent', 'encoded%25percent'],
      [":/?#[]@!$&'()*+,;=", encodeURIComponent(":/?#[]@!$&'()*+,;=")],
    ] as const;
    const operation = {
      operationId: '0123456789abcdef0123456789abcdef',
      operationIdentity: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    };
    try {
      for (const [index, [password, encodedPassword]] of cases.entries()) {
        const role = `restore_uri_${Date.now()}_${index}`;
        roles.push(role);
        await adminPool.query(
          `CREATE ROLE "${role}" LOGIN PASSWORD '${password.replaceAll("'", "''")}'`,
        );
        const target = new URL(databaseUrl);
        target.username = role;
        target.password = '';
        target.search = `?password=${encodedPassword}`;
        await expect(inspectFleetRestoreDatabaseMarker(
          { databaseUrl: target.toString() },
          operation,
        )).resolves.toBe('absent');
      }
    } finally {
      for (const role of roles) await adminPool.query(`DROP ROLE IF EXISTS "${role}"`);
      await adminPool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

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
