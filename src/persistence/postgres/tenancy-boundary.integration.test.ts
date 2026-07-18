import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCompanionId } from '../../shared/routing/companion-id.js';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../test-support/postgres-test-harness.js';
import { restorePostgresSchemaSlice } from '../backups/fleet-restore.js';
import { runBackupCycle } from '../backups/service.js';
import { createPostgresPool, runPostgresMigrations } from '../postgres.js';
import { POSTGRES_CONTACT_MIGRATIONS } from './migrations.js';
import {
  applyPublicAdoptionPlan,
  buildPublicAdoptionPlan,
  inventoryLegacyPublicSchema,
  rollbackPublicAdoptionPlan,
} from './public-adoption.js';
import { createPostgresShardSchemaLifecycle } from './shard-schema-lifecycle.js';
import {
  assertPostgresTenantAccessProvisioned,
  derivePostgresShardSchema,
  dropPostgresShardSchema,
  dropPostgresTenantAccess,
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
} from './tenancy.js';

const INTEGRATION_TIMEOUT_MS = 120_000;
const PARENT_ID = createCompanionId(
  '11111111-1111-4111-8111-111111111111',
  'tenancy integration parent',
);

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  if (harness) await harness.stop();
}, INTEGRATION_TIMEOUT_MS);

async function freshDatabaseUrl(): Promise<string> {
  if (!harness) throw new Error('Postgres tenancy integration harness is unavailable');
  return (await harness.createDatabase()).databaseUrl;
}

function writeDockerPostgresClient(root: string, binary: 'pg_dump' | 'pg_restore'): string {
  const path = join(root, binary);
  writeFileSync(path, [
    '#!/bin/sh',
    `exec /usr/bin/docker run --rm --network host -e PGPASSWORD -v /tmp:/tmp ${DEFAULT_POSTGRES_TEST_IMAGE} ${binary} "$@"`,
    '',
  ].join('\n'), { encoding: 'utf8', mode: 0o700 });
  return path;
}

describe('PostgreSQL flagship adoption boundary', () => {
  it('dry-runs deterministically, resumes committed progress, verifies, and rolls back only target state', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-public-adoption-e2e',
      max: 2,
    });
    try {
      console.info('[postgres-tenancy-e2e] step=legacy_fixture schema=public');
      await pool.query('CREATE SEQUENCE public.flagship_contacts_id_seq');
      await pool.query(`
        CREATE TABLE public.flagship_contacts (
          id BIGINT PRIMARY KEY DEFAULT nextval('public.flagship_contacts_id_seq'::regclass),
          display_name TEXT NOT NULL,
          parent_id BIGINT REFERENCES public.flagship_contacts(id)
        )
      `);
      await pool.query(
        'ALTER SEQUENCE public.flagship_contacts_id_seq OWNED BY public.flagship_contacts.id',
      );
      await pool.query(`
        INSERT INTO public.flagship_contacts (display_name)
        VALUES ('redacted-alpha'), ('redacted-beta')
      `);
      await pool.query(`
        CREATE VIEW public.flagship_contacts_view AS
        SELECT id, display_name FROM public.flagship_contacts
      `);

      const inventoryClient = await pool.connect();
      const inventory = await inventoryLegacyPublicSchema(inventoryClient, event => {
        console.info(`[postgres-tenancy-e2e] step=inventory kind=${event.step} object=${event.objectName ?? 'none'} count=${event.objectCount ?? 'none'}`);
      }).finally(() => inventoryClient.release());
      const plan = buildPublicAdoptionPlan(inventory, 'companion_flagship');
      console.info(`[postgres-tenancy-e2e] step=dry_run objects=${plan.objects.length} checksum=${plan.planChecksum}`);
      expect(buildPublicAdoptionPlan(inventory, 'companion_flagship')).toEqual(plan);

      let committedObjects = 0;
      await expect(applyPublicAdoptionPlan(pool, plan, {
        afterCommittedObject: () => {
          committedObjects += 1;
          if (committedObjects === 1) throw new Error('injected adoption interruption');
        },
      })).rejects.toThrow('injected adoption interruption');
      console.info('[postgres-tenancy-e2e] step=interruption committed=1');

      const resumed = await applyPublicAdoptionPlan(pool, plan);
      console.info(`[postgres-tenancy-e2e] step=resume objects=${resumed.objects.length}`);
      expect(resumed.resumed).toBe(true);
      expect(resumed.sourceInventoryChecksumAfter).toBe(plan.sourceInventoryChecksum);
      expect(resumed.objects).toHaveLength(3);
      expect(resumed.objects[0]?.status).toBe('already_applied');
      expect(await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM companion_flagship.flagship_contacts',
      )).toMatchObject({ rows: [{ count: '2' }] });
      expect(await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.flagship_contacts',
      )).toMatchObject({ rows: [{ count: '2' }] });
      expect(await pool.query<{ referenced_schema: string }>(`
        SELECT referenced_namespace.nspname AS referenced_schema
        FROM pg_constraint constraint_object
        JOIN pg_class referenced_table ON referenced_table.oid = constraint_object.confrelid
        JOIN pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_table.relnamespace
        WHERE constraint_object.conname = 'flagship_contacts_parent_id_fkey'
          AND constraint_object.conrelid = 'companion_flagship.flagship_contacts'::regclass
      `)).toMatchObject({ rows: [{ referenced_schema: 'companion_flagship' }] });

      const idempotent = await applyPublicAdoptionPlan(pool, plan);
      console.info(`[postgres-tenancy-e2e] step=idempotent objects=${idempotent.objects.length}`);
      expect(idempotent.resumed).toBe(true);
      expect(idempotent.objects.every(object => object.status === 'already_applied')).toBe(true);

      const backupRoot = mkdtempSync(join(tmpdir(), 'psfn-flagship-adoption-backup-'));
      const sessionsDir = join(backupRoot, 'sessions');
      mkdirSync(sessionsDir, { recursive: true });
      try {
        const pgDumpBinary = writeDockerPostgresClient(backupRoot, 'pg_dump');
        const pgRestoreBinary = writeDockerPostgresClient(backupRoot, 'pg_restore');
        const backup = await runBackupCycle({
          postgres: {
            databaseUrl,
            schema: plan.targetSchema,
            pgDumpBinary,
            pgRestoreBinary,
          },
          sessionsDir,
          backupRootDir: join(backupRoot, 'backups'),
          maxRotatingBackups: 1,
          maxWeeklyBackups: 0,
          maxMonthlyBackups: 0,
          verifyRestore: true,
          now: () => Date.UTC(2026, 6, 16, 3, 0, 0),
        });
        const postgresDumpPath = backup.postgresDumpPath;
        if (!postgresDumpPath) {
          throw new Error('Flagship schema backup did not produce a PostgreSQL dump path');
        }
        const restoreDatabaseUrl = await freshDatabaseUrl();
        try {
          await restorePostgresSchemaSlice({
            dumpPath: postgresDumpPath,
            schema: plan.targetSchema,
            postgres: { databaseUrl: restoreDatabaseUrl, pgRestoreBinary },
          });
        } catch (error) {
          const causes = error instanceof AggregateError ? error.errors : [error];
          throw new Error(
            `Flagship schema restore failed: ${causes.map(String).join(' | ')}`,
          );
        }
        const restoredPool = createPostgresPool(restoreDatabaseUrl, {
          applicationName: 'psfn-public-adoption-restored-e2e',
          schema: plan.targetSchema,
          max: 1,
        });
        try {
          expect(await restoredPool.query<{ count: string }>(
            'SELECT COUNT(*)::text AS count FROM flagship_contacts_view',
          )).toMatchObject({ rows: [{ count: '2' }] });
          console.info('[postgres-tenancy-e2e] step=flagship_restore rows=2 content=redacted');
        } finally {
          await restoredPool.end();
        }
      } finally {
        rmSync(backupRoot, { recursive: true, force: true });
      }

      await rollbackPublicAdoptionPlan(pool, plan);
      console.info('[postgres-tenancy-e2e] step=rollback source_preserved=true');
      expect(await pool.query<{ relation: string | null }>(
        "SELECT to_regclass('companion_flagship.flagship_contacts')::text AS relation",
      )).toMatchObject({ rows: [{ relation: null }] });
      expect(await pool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM public.flagship_contacts',
      )).toMatchObject({ rows: [{ count: '2' }] });
    } finally {
      await pool.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});

describe('PostgreSQL least-privilege companion and shard roles', () => {
  it('removes one explicitly planned disposable tenant without touching its peer', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const admin = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-disposable-tenant-cleanup',
      max: 2,
    });
    const primary = planPostgresTenantAccess({ schema: 'shakedown_artie' });
    const support = planPostgresTenantAccess({ schema: 'shakedown_support_mica' });
    try {
      await provisionPostgresTenantAccess(admin, {
        plan: primary,
        runtimeLoginRole: 'postgres',
        relocateExtensions: ['vector'],
      });
      await provisionPostgresTenantAccess(admin, {
        plan: support,
        runtimeLoginRole: 'postgres',
      });
      await expect(provisionPostgresTenantAccess(admin, {
        plan: support,
        requireAbsent: true,
        runtimeLoginRole: 'postgres',
      })).rejects.toThrow(
        `PostgreSQL tenant ${support.schema} must be absent before disposable provisioning`,
      );
      await admin.query('CREATE TABLE shakedown_artie.primary_probe (id TEXT PRIMARY KEY)');
      await admin.query('CREATE TABLE shakedown_support_mica.support_probe (id TEXT PRIMARY KEY)');
      await admin.query(`
        CREATE COLLATION public.cleanup_guard_collation (
          provider = libc,
          locale = 'C'
        )
      `);
      await admin.query(`ALTER COLLATION public.cleanup_guard_collation OWNER TO "${support.role}"`);

      await expect(dropPostgresTenantAccess({
        pool: admin,
        plan: support,
        runtimeLoginRole: 'postgres',
        dropRole: true,
      })).rejects.toThrow('cannot be dropped because some objects depend on it');
      expect(await admin.query<{ relation: string | null }>(
        "SELECT to_regclass('shakedown_support_mica.support_probe')::text AS relation",
      )).toMatchObject({ rows: [{ relation: 'shakedown_support_mica.support_probe' }] });

      await admin.query('ALTER COLLATION public.cleanup_guard_collation OWNER TO postgres');
      await admin.query('DROP COLLATION public.cleanup_guard_collation');

      const evidence = await dropPostgresTenantAccess({
        pool: admin,
        plan: support,
        runtimeLoginRole: 'postgres',
        dropRole: true,
      });

      expect(evidence).toMatchObject({
        schema: support.schema,
        role: support.role,
        dropped: true,
      });
      expect(await admin.query<{ schema_exists: boolean; role_exists: boolean }>(`
        SELECT
          to_regnamespace($1) IS NOT NULL AS schema_exists,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists
      `, [support.schema, support.role])).toMatchObject({
        rows: [{ schema_exists: false, role_exists: false }],
      });
      await assertPostgresTenantAccessProvisioned(admin, primary);
      expect(await admin.query<{ relation: string | null }>(
        "SELECT to_regclass('shakedown_artie.primary_probe')::text AS relation",
      )).toMatchObject({ rows: [{ relation: 'shakedown_artie.primary_probe' }] });
    } finally {
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('isolates two companions and a derived shard while allowing only approved shared reads', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const admin = createPostgresPool(databaseUrl, {
      applicationName: 'psfn-tenancy-admin',
      max: 2,
    });
    const shardId = 'shard-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const shardSchema = derivePostgresShardSchema({
      parentCompanionId: PARENT_ID,
      parentSchema: 'companion_a',
      shardId,
    });
    const plans = [
      planPostgresTenantAccess({
        schema: 'companion_a',
        approvedSharedSchema: 'shared',
        approvedSharedAccess: 'read',
      }),
      planPostgresTenantAccess({ schema: 'companion_b' }),
      planPostgresTenantAccess({ schema: shardSchema }),
    ];
    let poolA: ReturnType<typeof createPostgresPool> | undefined;
    let poolB: ReturnType<typeof createPostgresPool> | undefined;
    let shardPool: ReturnType<typeof createPostgresPool> | undefined;
    try {
      await admin.query('CREATE SCHEMA shared');
      await admin.query('CREATE TABLE shared.approved_world (id TEXT PRIMARY KEY)');
      await admin.query("INSERT INTO shared.approved_world VALUES ('world-redacted')");
      await admin.query('CREATE TABLE public.fallback_probe (id TEXT PRIMARY KEY)');
      for (const [index, plan] of plans.entries()) {
        await provisionPostgresTenantAccess(admin, {
          plan,
          runtimeLoginRole: 'postgres',
          ...(index === 0 ? { relocateExtensions: ['vector'] } : {}),
        });
      }
      expect(await admin.query<{ schema_name: string }>(`
        SELECT namespace.nspname AS schema_name
        FROM pg_extension extension
        JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
        WHERE extension.extname = 'vector'
      `)).toMatchObject({ rows: [{ schema_name: 'extensions' }] });
      await Promise.all(plans.map(plan => assertPostgresTenantAccessProvisioned(admin, plan)));

      [poolA, poolB, shardPool] = plans.map(plan => createPostgresPool(databaseUrl, {
        applicationName: `psfn-${plan.schema}`,
        schema: plan.schema,
        role: plan.role,
        max: 1,
      }));
      await Promise.all([
        runPostgresMigrations(poolA, POSTGRES_CONTACT_MIGRATIONS, { schema: plans[0].schema }),
        runPostgresMigrations(poolB, POSTGRES_CONTACT_MIGRATIONS, { schema: plans[1].schema }),
        runPostgresMigrations(shardPool, POSTGRES_CONTACT_MIGRATIONS, { schema: plans[2].schema }),
      ]);
      const now = new Date().toISOString();
      await Promise.all([
        poolA.query(
          'INSERT INTO contacts (id, display_name, first_seen, last_seen) VALUES ($1, $2, $3, $3)',
          ['a', 'redacted-a', now],
        ),
        poolB.query(
          'INSERT INTO contacts (id, display_name, first_seen, last_seen) VALUES ($1, $2, $3, $3)',
          ['b', 'redacted-b', now],
        ),
        shardPool.query(
          'INSERT INTO contacts (id, display_name, first_seen, last_seen) VALUES ($1, $2, $3, $3)',
          ['shard', 'redacted-shard', now],
        ),
      ]);

      const searchPath = await poolA.query<{ search_path: string }>('SHOW search_path');
      expect(searchPath.rows[0]?.search_path.replaceAll(' ', ''))
        .toBe('companion_a,extensions');
      await expect(poolA.query('SELECT * FROM fallback_probe')).rejects.toThrow(/does not exist/u);
      await expect(poolA.query('SELECT * FROM companion_b.contacts')).rejects.toThrow(/permission denied/u);
      await expect(poolA.query(`SELECT * FROM ${shardSchema}.contacts`)).rejects.toThrow(/permission denied/u);
      expect(await poolA.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM shared.approved_world',
      )).toMatchObject({ rows: [{ count: '1' }] });
      await expect(poolA.query(
        "INSERT INTO shared.approved_world VALUES ('write-denied')",
      )).rejects.toThrow(/permission denied/u);
    } finally {
      await poolA?.end();
      await poolB?.end();
      await shardPool?.end();
      if (plans[2]) {
        await dropPostgresShardSchema({
          pool: admin,
          parentCompanionId: PARENT_ID,
          parentSchema: 'companion_a',
          shardId,
          schema: shardSchema,
          dropRole: true,
        });
      }
      await admin.end();
    }
  }, INTEGRATION_TIMEOUT_MS);
});

describe('PostgreSQL shard schema lifecycle', () => {
  it('uses the same lineage-bound schema for migration, backup, restore, and cleanup', async () => {
    const databaseUrl = await freshDatabaseUrl();
    const root = mkdtempSync(join(tmpdir(), 'shard-schema-lifecycle-'));
    const sessionsDir = join(root, 'sessions');
    const backupRootDir = join(root, 'backups');
    mkdirSync(sessionsDir, { recursive: true });
    const lifecycle = createPostgresShardSchemaLifecycle({
      databaseUrl,
      pgDumpBinary: writeDockerPostgresClient(root, 'pg_dump'),
      pgRestoreBinary: writeDockerPostgresClient(root, 'pg_restore'),
    });
    const binding = lifecycle.derive(
      PARENT_ID,
      'companion_a',
      'shard-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    );
    let shardPool: ReturnType<typeof createPostgresPool> | undefined;
    let shardExists = false;
    try {
      await lifecycle.prepare(binding);
      shardExists = true;
      await lifecycle.migrate(binding, POSTGRES_CONTACT_MIGRATIONS);
      shardPool = lifecycle.openPool(binding, 'shard-schema-lifecycle-e2e');
      const now = new Date().toISOString();
      await shardPool.query(
        'INSERT INTO contacts (id, display_name, first_seen, last_seen) VALUES ($1, $2, $3, $3)',
        ['backup-probe', 'redacted-backup-probe', now],
      );

      const backup = await lifecycle.backup(binding, {
        sessionsDir,
        backupRootDir,
        maxRotatingBackups: 1,
        maxWeeklyBackups: 0,
        maxMonthlyBackups: 0,
        verifyRestore: true,
        now: () => Date.UTC(2026, 6, 16, 4, 0, 0),
      });
      expect(backup.postgresDumpCaptured).toBe(true);
      expect(backup.postgresDumpVerification?.tocEntryCount).toBeGreaterThan(0);
      await shardPool.end();
      shardPool = undefined;

      const firstCleanup = await lifecycle.cleanup(binding);
      shardExists = false;
      expect(firstCleanup.droppedObjectCount).toBeGreaterThan(0);

      const postgresDumpPath = backup.postgresDumpPath;
      if (!postgresDumpPath) {
        throw new Error('Shard schema backup did not produce a PostgreSQL dump path');
      }
      await lifecycle.restore(binding, postgresDumpPath);
      shardExists = true;
      shardPool = lifecycle.openPool(binding, 'shard-schema-lifecycle-restored-e2e');
      expect(await shardPool.query<{ count: string }>(
        'SELECT COUNT(*)::text AS count FROM contacts',
      )).toMatchObject({ rows: [{ count: '1' }] });
      expect(await shardPool.query<{ search_path: string }>('SHOW search_path'))
        .toMatchObject({ rows: [{ search_path: `${binding.schema},extensions` }] });
      console.info('[postgres-tenancy-e2e] step=shard_restore rows=1 content=redacted');
    } finally {
      await shardPool?.end();
      if (shardExists) await lifecycle.cleanup(binding);
      rmSync(root, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);
});
