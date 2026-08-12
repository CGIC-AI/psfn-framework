import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresPool, runPostgresMigrations } from '../../../persistence/postgres.js';
import { POSTGRES_AUTOMATA_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { POSTGRES_VECTOR_EXTENSION_MIGRATION } from '../../../persistence/postgres/vector-extension-migration.js';
import {
  planPostgresTenantAccess,
  provisionPostgresTenantAccess,
} from '../../../persistence/postgres/tenancy.js';
import { runBackupCycle } from '../../../persistence/backups/service.js';
import { restorePostgresSchemaSlice } from '../../../persistence/backups/fleet-restore.js';
import {
  PGVECTOR_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import type { AutomataBusEvent } from './contract.js';
import {
  AUTOMATA_BUS_POSTGRES_RELATIONS,
  AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS,
  AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
} from './postgres-schema.js';
import { PostgresAutomataBusStore } from './postgres-store.js';
import { assertAutomataBusPostgresReady } from './runtime-store.js';

const INTEGRATION_TIMEOUT_MS = 120_000;

let harness: PostgresTestHarness | null = null;

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: PGVECTOR_POSTGRES_TEST_IMAGE });
}, INTEGRATION_TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, INTEGRATION_TIMEOUT_MS);

async function withStore<T>(
  operation: (store: PostgresAutomataBusStore, pool: Pool) => Promise<T>,
): Promise<T> {
  if (!harness) throw new Error('Automata Bus Postgres integration harness is unavailable');
  const database = await harness.createDatabase();
  const pool = createPostgresPool(database.databaseUrl, {
    applicationName: 'automata-bus-store-integration',
    allowExitOnIdle: true,
    max: 8,
  });
  try {
    await runPostgresMigrations(pool, [
      POSTGRES_VECTOR_EXTENSION_MIGRATION,
      ...AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
    ]);
    return await operation(new PostgresAutomataBusStore(pool), pool);
  } finally {
    await pool.end();
  }
}

async function installVectorExtension(databaseUrl: string): Promise<void> {
  const owner = createPostgresPool(databaseUrl, {
    applicationName: 'automata-bus-vector-extension-provisioning',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    await owner.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
  } finally {
    await owner.end();
  }
}

function seededRelationCount(relation: typeof AUTOMATA_BUS_POSTGRES_RELATIONS[number]): string {
  return relation === 'automata_bus_events' || relation === 'automata_bus_current_findings'
    ? '1'
    : '0';
}

function finding(overrides: Partial<AutomataBusEvent> = {}): AutomataBusEvent {
  return {
    schemaVersion: 1,
    eventId: 'finding-1',
    companionId: 'companion-a',
    sequence: 1,
    occurredAt: '2026-08-11T12:00:00.000Z',
    mustUnderstand: [],
    context: {
      automatonClass: 'memory-extraction',
      runId: 'run-1',
      taskId: 'task-1',
      sessionIds: ['session-1'],
      artifactRefs: ['artifact:report'],
    },
    type: 'finding',
    body: {
      claim: 'The report uses deterministic section ordering.',
      provenance: 'computed',
      evidence: [{
        kind: 'artifact',
        reference: 'artifact:report',
        summary: 'Rendered report snapshot',
      }],
      verification: { status: 'pending' },
    },
    ...overrides,
  } as AutomataBusEvent;
}

interface AutomataBusStateFixture {
  events: AutomataBusEvent[];
  projection: {
    effectiveFindings: Array<{ eventId: string; claim: string }>;
    dispositions: Array<{
      targetEventId: string;
      relation: 'corrects' | 'retracts' | 'supersedes';
      byEventId: string;
    }>;
  };
}

function stateFixture(name: 'correction-chain' | 'retraction'): AutomataBusStateFixture {
  return JSON.parse(readFileSync(
    new URL(`./conformance/v1/state/${name}.json`, import.meta.url),
    'utf8',
  )) as AutomataBusStateFixture;
}

describe('PostgresAutomataBusStore real Postgres', () => {
  it('makes concurrent duplicate appends atomic and idempotent', async () => {
    await withStore(async (store) => {
      const input = {
        companionId: 'companion-a',
        event: finding(),
        audiences: ['eligible-automata'] as const,
        sensitivity: 'personal' as const,
      };

      const results = await Promise.all(Array.from({ length: 8 }, async () => store.append(input)));

      expect(results.filter(result => result.inserted)).toHaveLength(1);
      await expect(store.readHistory({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toEqual([finding()]);
      await expect(store.readCurrentState({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toMatchObject({
        history: [finding()],
        effectiveFindings: [{ eventId: 'finding-1' }],
      });
    });
  });

  it('rolls back a conflicting replay and accepts the next valid append', async () => {
    await withStore(async (store) => {
      const original = finding();
      await store.append({
        companionId: 'companion-a',
        event: original,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });

      await expect(store.append({
        companionId: 'companion-a',
        event: finding({
          body: {
            claim: 'Different content under the same event ID.',
            provenance: 'computed',
            evidence: [{
              kind: 'artifact',
              reference: 'artifact:report',
              summary: 'Conflicting snapshot',
            }],
            verification: { status: 'pending' },
          },
        } as Partial<AutomataBusEvent>),
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      })).rejects.toThrow(/reused with different content/u);

      const recovery = finding({
        eventId: 'finding-2',
        sequence: 2,
        occurredAt: '2026-08-11T12:01:00.000Z',
      });
      await expect(store.append({
        companionId: 'companion-a',
        event: recovery,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      })).resolves.toMatchObject({ inserted: true });
      await expect(store.readHistory({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toEqual([original, recovery]);
    });
  });

  it('rolls back ledger insertion when current-state materialization fails', async () => {
    await withStore(async (store, pool) => {
      const original = finding();
      await store.append({
        companionId: 'companion-a',
        event: original,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });
      await pool.query(`
        CREATE FUNCTION reject_automata_projection() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.event_id = 'projection-failure' THEN
            RAISE EXCEPTION 'injected projection failure';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await pool.query(`
        CREATE TRIGGER reject_automata_projection_trigger
        BEFORE INSERT ON automata_bus_current_findings
        FOR EACH ROW EXECUTE FUNCTION reject_automata_projection()
      `);
      const blocked = finding({
        eventId: 'projection-failure',
        sequence: 2,
        occurredAt: '2026-08-11T12:01:00.000Z',
      });

      await expect(store.append({
        companionId: 'companion-a',
        event: blocked,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      })).rejects.toThrow(/injected projection failure/u);
      await expect(store.readHistory({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toEqual([original]);

      await pool.query('DROP TRIGGER reject_automata_projection_trigger ON automata_bus_current_findings');
      await pool.query('DROP FUNCTION reject_automata_projection()');
      await expect(store.append({
        companionId: 'companion-a',
        event: blocked,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      })).resolves.toMatchObject({ inserted: true });
    });
  });

  it.each(['correction-chain', 'retraction'] as const)(
    'matches the pinned %s current-state fixture',
    async (fixtureName) => {
      await withStore(async (store) => {
        const fixture = stateFixture(fixtureName);
        for (const event of fixture.events) {
          await store.append({
            companionId: event.companionId,
            event,
            audiences: ['eligible-automata'],
            sensitivity: 'personal',
          });
        }

        const state = await store.readCurrentState({
          companionId: 'companion-a',
          audience: 'eligible-automata',
          maxSensitivity: 'personal',
        });

        expect(state.effectiveFindings.map(entry => ({
          eventId: entry.eventId,
          claim: entry.body.claim,
        }))).toEqual(fixture.projection.effectiveFindings);
        expect(state.dispositions).toEqual(fixture.projection.dispositions);
      });
    },
  );

  it('reconstructs after restart and fails closed on projection drift', async () => {
    await withStore(async (store, pool) => {
      const event = finding();
      await store.append({
        companionId: 'companion-a',
        event,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });
      const restarted = new PostgresAutomataBusStore(pool);

      await expect(restarted.readCurrentState({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toMatchObject({
        history: [event],
        effectiveFindings: [{ eventId: 'finding-1' }],
      });

      await pool.query(
        'DELETE FROM automata_bus_current_findings WHERE companion_id = $1 AND event_id = $2',
        ['companion-a', 'finding-1'],
      );
      await expect(restarted.readCurrentState({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).rejects.toThrow(/projection does not match immutable history/u);
    });
  });

  it('isolates companion, audience, and sensitivity scopes in SQL-backed reads', async () => {
    await withStore(async (store) => {
      await store.append({
        companionId: 'companion-a',
        event: finding({ eventId: 'automata-public' }),
        audiences: ['eligible-automata'],
        sensitivity: 'public',
      });
      await store.append({
        companionId: 'companion-a',
        event: finding({
          eventId: 'operator-personal',
          sequence: 2,
          occurredAt: '2026-08-11T12:01:00.000Z',
        }),
        audiences: ['operator'],
        sensitivity: 'personal',
      });
      await store.append({
        companionId: 'companion-a',
        event: finding({
          eventId: 'automata-confidential',
          sequence: 3,
          occurredAt: '2026-08-11T12:02:00.000Z',
        }),
        audiences: ['eligible-automata'],
        sensitivity: 'confidential',
      });
      await store.append({
        companionId: 'companion-b',
        event: finding({ companionId: 'companion-b', eventId: 'other-companion' }),
        audiences: ['eligible-automata'],
        sensitivity: 'public',
      });

      await expect(store.readHistory({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toEqual([finding({ eventId: 'automata-public' })]);
      await expect(store.readHistory({
        companionId: 'companion-a',
        audience: 'operator',
        maxSensitivity: 'personal',
      })).resolves.toEqual([finding({
        eventId: 'operator-personal',
        sequence: 2,
        occurredAt: '2026-08-11T12:01:00.000Z',
      })]);
      await expect(store.readCurrentFindingsByEventIds({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
        eventIds: [
          'automata-public',
          'operator-personal',
          'automata-confidential',
          'other-companion',
        ],
      })).resolves.toEqual([{
        effectiveFinding: expect.objectContaining({ eventId: 'automata-public' }),
        audiences: ['eligible-automata'],
        sensitivity: 'public',
      }]);
    });
  });

  it('keeps identical event identities isolated across tenant schemas', async () => {
    if (!harness) throw new Error('Automata Bus Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const owner = createPostgresPool(database.databaseUrl, { max: 1 });
    let tenantA: Pool | undefined;
    let tenantB: Pool | undefined;
    try {
      await owner.query('CREATE SCHEMA automata_tenant_a');
      await owner.query('CREATE SCHEMA automata_tenant_b');
      tenantA = createPostgresPool(database.databaseUrl, {
        applicationName: 'automata-bus-tenant-a',
        schema: 'automata_tenant_a',
        max: 2,
      });
      tenantB = createPostgresPool(database.databaseUrl, {
        applicationName: 'automata-bus-tenant-b',
        schema: 'automata_tenant_b',
        max: 2,
      });
      const migrations = [
        POSTGRES_VECTOR_EXTENSION_MIGRATION,
        ...AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
      ];
      await runPostgresMigrations(tenantA, migrations);
      await runPostgresMigrations(tenantB, migrations);
      const storeA = new PostgresAutomataBusStore(tenantA);
      const storeB = new PostgresAutomataBusStore(tenantB);
      const eventA = finding();
      const eventB = finding({
        body: {
          claim: 'Tenant B has an independent finding under the same event ID.',
          provenance: 'computed',
          evidence: [{
            kind: 'artifact',
            reference: 'artifact:report',
            summary: 'Tenant B report snapshot',
          }],
          verification: { status: 'pending' },
        },
      } as Partial<AutomataBusEvent>);
      await storeA.append({
        companionId: 'companion-a',
        event: eventA,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });
      await storeB.append({
        companionId: 'companion-a',
        event: eventB,
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });

      await expect(storeA.readHistory({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toEqual([eventA]);
      await expect(storeB.readHistory({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toEqual([eventB]);
    } finally {
      await tenantA?.end();
      await tenantB?.end();
      await owner.end();
    }
  });

  it('proves exported readiness and rollback requirements against Postgres', async () => {
    await withStore(async (_store, pool) => {
      await expect(assertAutomataBusPostgresReady(pool)).resolves.toBeUndefined();
      for (const relation of AUTOMATA_BUS_POSTGRES_RELATIONS) {
        await expect(pool.query<{ relation: string | null }>(
          'SELECT to_regclass($1)::text AS relation',
          [relation],
        )).resolves.toMatchObject({ rows: [{ relation }] });
      }

      for (const statement of AUTOMATA_BUS_POSTGRES_ROLLBACK_STATEMENTS) {
        await pool.query(statement);
      }
      for (const relation of AUTOMATA_BUS_POSTGRES_RELATIONS) {
        await expect(pool.query<{ relation: string | null }>(
          'SELECT to_regclass($1)::text AS relation',
          [relation],
        )).resolves.toMatchObject({ rows: [{ relation: null }] });
      }
      await expect(assertAutomataBusPostgresReady(pool)).rejects.toThrow(/required access/u);
    });
  });

  it('denies update, delete, and truncate against immutable event history', async () => {
    await withStore(async (store, pool) => {
      await store.append({
        companionId: 'companion-a',
        event: finding(),
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });

      await expect(pool.query(
        "UPDATE automata_bus_events SET task_id = 'mutated' WHERE event_id = 'finding-1'",
      )).rejects.toThrow(/append-only/u);
      await expect(pool.query(
        "DELETE FROM automata_bus_events WHERE event_id = 'finding-1'",
      )).rejects.toThrow(/append-only/u);
      await expect(pool.query('TRUNCATE automata_bus_events CASCADE'))
        .rejects.toThrow(/append-only/u);
      await expect(store.readHistory({
        companionId: 'companion-a',
        audience: 'eligible-automata',
        maxSensitivity: 'personal',
      })).resolves.toEqual([finding()]);
    });
  });

  it('certifies Automata Bus history, projection, and immutable guards after backup restore', async () => {
    if (!harness) throw new Error('Automata Bus Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const schema = 'automata_restore_scope';
    const owner = createPostgresPool(database.databaseUrl, { max: 1 });
    await owner.query(`CREATE SCHEMA ${schema}`);
    await owner.end();
    const source = createPostgresPool(database.databaseUrl, {
      applicationName: 'automata-bus-backup-source',
      schema,
      max: 2,
    });
    const root = mkdtempSync(join(tmpdir(), 'psfn-automata-bus-backup-'));
    const sessionsDir = join(root, 'sessions');
    mkdirSync(sessionsDir, { recursive: true });
    try {
      await runPostgresMigrations(source, [
        POSTGRES_VECTOR_EXTENSION_MIGRATION,
        ...AUTOMATA_BUS_POSTGRES_SCHEMA_STATEMENTS,
      ]);
      const store = new PostgresAutomataBusStore(source);
      await store.append({
        companionId: 'companion-a',
        event: finding(),
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });
      const backup = await runBackupCycle({
        postgres: {
          databaseUrl: database.databaseUrl,
          schema,
          pgDumpBinary: harness.clientBinaries.pgDumpBinary,
          pgRestoreBinary: harness.clientBinaries.pgRestoreBinary,
        },
        sessionsDir,
        backupRootDir: join(root, 'backups'),
        maxRotatingBackups: 1,
        maxWeeklyBackups: 0,
        maxMonthlyBackups: 0,
        now: () => Date.UTC(2026, 7, 11, 12, 0, 0),
      });
      if (!backup.postgresDumpPath) throw new Error('Automata Bus backup did not create a dump');
      const restored = await harness.createDatabase();
      // Schema-slice dumps reference the provisioned extension but intentionally
      // do not own it. Restore into the same production prerequisite shape.
      await installVectorExtension(restored.databaseUrl);
      await restorePostgresSchemaSlice({
        dumpPath: backup.postgresDumpPath,
        schema,
        postgres: {
          databaseUrl: restored.databaseUrl,
          psqlBinary: harness.clientBinaries.psqlBinary,
          pgRestoreBinary: harness.clientBinaries.pgRestoreBinary,
        },
      });
      const restoredPool = createPostgresPool(restored.databaseUrl, {
        applicationName: 'automata-bus-backup-restored',
        schema,
        max: 1,
      });
      try {
        await expect(assertAutomataBusPostgresReady(restoredPool)).resolves.toBeUndefined();
        for (const relation of AUTOMATA_BUS_POSTGRES_RELATIONS) {
          await expect(restoredPool.query(`SELECT COUNT(*)::text AS count FROM ${relation}`))
            .resolves.toMatchObject({ rows: [{ count: seededRelationCount(relation) }] });
        }
        await expect(restoredPool.query('DELETE FROM automata_bus_events'))
          .rejects.toThrow(/append-only/u);
      } finally {
        await restoredPool.end();
      }
    } finally {
      await source.end();
      rmSync(root, { recursive: true, force: true });
    }
  }, INTEGRATION_TIMEOUT_MS);

  it('grants the backup role read-only access to every Automata Bus relation', async () => {
    if (!harness) throw new Error('Automata Bus Postgres integration harness is unavailable');
    const database = await harness.createDatabase();
    const schema = 'automata_backup_scope';
    const backupRole = 'automata_bus_backup';
    const backupPassword = 'automata-backup-test-password';
    const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
    const owner = createPostgresPool(database.databaseUrl, { max: 1 });
    const tenant = planPostgresTenantAccess({ schema });
    let runtime: Pool | undefined;
    let backup: Pool | undefined;
    try {
      await admin.query(
        `CREATE ROLE ${backupRole} LOGIN NOINHERIT PASSWORD '${backupPassword}'`,
      );
      await provisionPostgresTenantAccess(owner, {
        plan: tenant,
        runtimeLoginRole: 'postgres',
        backupRole,
      });
      // Deployment provisioning owns extension installation; the restricted
      // runtime migration validates it and must never need CREATE EXTENSION.
      await owner.query('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions');
      runtime = createPostgresPool(database.databaseUrl, {
        applicationName: 'automata-bus-runtime-role',
        schema,
        role: tenant.role,
        max: 1,
      });
      await runPostgresMigrations(runtime, POSTGRES_AUTOMATA_MIGRATIONS, { schema });
      const runtimeStore = new PostgresAutomataBusStore(runtime);
      await runtimeStore.append({
        companionId: 'companion-a',
        event: finding(),
        audiences: ['eligible-automata'],
        sensitivity: 'personal',
      });
      await expect(assertAutomataBusPostgresReady(runtime)).resolves.toBeUndefined();
      await expect(runtime.query(
        "UPDATE automata_bus_events SET task_id = 'mutated' WHERE event_id = 'finding-1'",
      )).rejects.toThrow(/append-only/u);
      await expect(runtime.query('DELETE FROM automata_bus_events'))
        .rejects.toThrow(/append-only/u);
      await expect(runtime.query('TRUNCATE automata_bus_events CASCADE'))
        .rejects.toThrow(/append-only/u);
      const backupUrl = new URL(database.databaseUrl);
      backupUrl.username = backupRole;
      backupUrl.password = backupPassword;
      backup = createPostgresPool(backupUrl.toString(), {
        applicationName: 'automata-bus-backup-reader',
        schema,
        max: 1,
      });

      for (const relation of AUTOMATA_BUS_POSTGRES_RELATIONS) {
        await expect(backup.query(`SELECT COUNT(*)::text AS count FROM ${relation}`))
          .resolves.toMatchObject({ rows: [{ count: seededRelationCount(relation) }] });
      }
      await expect(backup.query('INSERT INTO automata_bus_events DEFAULT VALUES'))
        .rejects.toThrow(/permission denied/u);
    } finally {
      await backup?.end();
      await runtime?.end();
      await owner.end();
      await admin.end();
    }
  });
});
