import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_POSTGRES_TEST_IMAGE,
  startPostgresTestHarness,
  type PostgresTestHarness,
} from '../../../test-support/postgres-test-harness.js';
import { createPostgresPool } from '../../postgres.js';
import { FLEET_AUTH_MIGRATIONS } from './migrations.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  migrateFleetAuthSchema,
  type FleetAuthDatabaseRoles,
} from './schema.js';

// This suite reproduces the provider-subject resurrection that a v1-v3 to v4
// fleet-auth upgrade must prevent. It seeds a database to schema version 3
// (the state that shipped before the identity registry existed), plants legacy
// identity evidence that lives only in the immutable history log, and then runs
// the real migration runner so that version 4 alone is applied as an in-place
// upgrade. The registry backfill must honor that history and fail closed on
// ambiguity before its enforcement triggers are installed.

const TIMEOUT_MS = 120_000;
const ROLES: FleetAuthDatabaseRoles = {
  runtime: 'fleet_auth_runtime',
  migration: 'fleet_auth_migration',
  backupRestore: 'fleet_auth_backup',
};
const PASSWORDS: Record<string, string> = {
  fleet_auth_runtime: 'runtime-password',
  fleet_auth_migration: 'migration-password',
  fleet_auth_backup: 'backup-password',
};

const SUBJECT_ID = '100000000000000001';
const OTHER_SUBJECT_ID = '100000000000000002';

let harness: PostgresTestHarness | null = null;

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function roleUrl(databaseUrl: string, role: keyof typeof PASSWORDS): string {
  const url = new URL(databaseUrl);
  url.username = role;
  url.password = PASSWORDS[role];
  return url.toString();
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

beforeAll(async () => {
  harness = await startPostgresTestHarness({ image: DEFAULT_POSTGRES_TEST_IMAGE });
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    for (const role of Object.values(ROLES)) {
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN NOINHERIT CONNECTION LIMIT 16 PASSWORD '${PASSWORDS[role]}'`,
      );
    }
  } finally {
    await admin.end();
  }
}, TIMEOUT_MS);

afterAll(async () => {
  await harness?.stop();
}, TIMEOUT_MS);

async function freshDatabase() {
  if (!harness) throw new Error('Postgres harness unavailable');
  const database = await harness.createDatabase();
  const admin = createPostgresPool(harness.adminDatabaseUrl, { max: 1 });
  try {
    await admin.query(
      `GRANT CREATE, CONNECT ON DATABASE ${quoteIdentifier(database.databaseName)} `
      + `TO ${quoteIdentifier(ROLES.migration)}`,
    );
  } finally {
    await admin.end();
  }
  return {
    migrationUrl: roleUrl(database.databaseUrl, ROLES.migration),
    runtimeUrl: roleUrl(database.databaseUrl, ROLES.runtime),
  };
}

// Bring a fresh database up to schema version 3 exactly the way the runner
// would, so that a later migrateFleetAuthSchema call recognizes versions 1-3 as
// already applied and installs only version 4 as an in-place upgrade.
async function seedToVersionThree(migrationUrl: string): Promise<void> {
  const pool = createPostgresPool(migrationUrl, { max: 1, allowExitOnIdle: true });
  try {
    await pool.query(`CREATE SCHEMA ${quoteIdentifier(FLEET_AUTH_SCHEMA_NAME)}`);
    await pool.query(`SET search_path TO ${quoteIdentifier(FLEET_AUTH_SCHEMA_NAME)}, public`);
    await pool.query(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY CHECK (version >= 1),
        name TEXT NOT NULL UNIQUE,
        checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
        applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      )
    `);
    for (const migration of FLEET_AUTH_MIGRATIONS) {
      if (migration.version > 3) continue;
      await pool.query(migration.sql);
      await pool.query(
        'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
        [migration.version, migration.name, migrationChecksum(migration.sql)],
      );
    }
  } finally {
    await pool.end();
  }
}

async function insertPrincipal(
  pool: import('pg').Pool,
  principalId: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.human_principals
       (principal_id, status, authority_generation)
     VALUES ($1, 'active', 1)`,
    [principalId],
  );
}

async function recordHistory(
  pool: import('pg').Pool,
  subjectId: string,
  principalId: string,
  eventType: string,
): Promise<void> {
  await pool.query(
    `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_history
       (event_id, provider, subject_id, principal_id, state, event_type, authority_generation)
     VALUES ($1, 'discord', $2, $3, 'active', $4, 1)`,
    [randomUUID(), subjectId, principalId, eventType],
  );
}

describe('fleet_auth v4 provider-subject identity backfill', () => {
  it('backfills history-only ownership so a deleted subject cannot be resurrected under another principal', async () => {
    const db = await freshDatabase();
    await seedToVersionThree(db.migrationUrl);

    const principalA = randomUUID();
    const principalB = randomUUID();

    const seed = createPostgresPool(db.migrationUrl, { max: 1, allowExitOnIdle: true });
    try {
      await insertPrincipal(seed, principalA);
      await insertPrincipal(seed, principalB);
      // Subject was once live for principal A and left an immutable history
      // trail, then was deleted before v4 without a tombstone (the pre-v4
      // schema had no delete guard). Only the history log now remembers A.
      await seed.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
           (provider, subject_id, principal_id, state, authority_generation)
         VALUES ('discord', $1, $2, 'active', 1)`,
        [SUBJECT_ID, principalA],
      );
      await recordHistory(seed, SUBJECT_ID, principalA, 'created');
      await seed.query(
        `DELETE FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
         WHERE provider = 'discord' AND subject_id = $1`,
        [SUBJECT_ID],
      );
    } finally {
      await seed.end();
    }

    // Upgrade v3 -> v4 through the real runner: only version 4 is applied.
    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });

    const inspect = createPostgresPool(db.migrationUrl, { max: 1, allowExitOnIdle: true });
    try {
      const registry = await inspect.query<{ principal_id: string; tombstoned: boolean }>(
        `SELECT principal_id, tombstoned
         FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_registry
         WHERE provider = 'discord' AND subject_id = $1`,
        [SUBJECT_ID],
      );
      expect(registry.rows).toHaveLength(1);
      expect(registry.rows[0]?.principal_id).toBe(principalA);
      expect(registry.rows[0]?.tombstoned).toBe(false);
    } finally {
      await inspect.end();
    }

    // The enforcement trigger installed by v4 must now reject an attempt to
    // insert the same subject for a different principal (account takeover).
    const runtime = createPostgresPool(db.runtimeUrl, { max: 1, allowExitOnIdle: true });
    try {
      await expect(
        runtime.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
             (provider, subject_id, principal_id, state, authority_generation)
           VALUES ('discord', $1, $2, 'active', 1)`,
          [SUBJECT_ID, principalB],
        ),
      ).rejects.toThrow(/permanently bound to another principal/);

      // Re-linking the original principal A remains allowed: the fix protects
      // against cross-principal takeover, not legitimate reattachment.
      await expect(
        runtime.query(
          `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
             (provider, subject_id, principal_id, state, authority_generation)
           VALUES ('discord', $1, $2, 'active', 1)`,
          [SUBJECT_ID, principalA],
        ),
      ).resolves.toBeDefined();
    } finally {
      await runtime.end();
    }
  }, TIMEOUT_MS);

  it('converges same-principal live, tombstone, and history evidence and keeps tombstones permanent', async () => {
    const db = await freshDatabase();
    await seedToVersionThree(db.migrationUrl);

    const principalA = randomUUID();

    const seed = createPostgresPool(db.migrationUrl, { max: 1, allowExitOnIdle: true });
    try {
      await insertPrincipal(seed, principalA);
      // A live subject with matching history for the same principal.
      await seed.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subjects
           (provider, subject_id, principal_id, state, authority_generation)
         VALUES ('discord', $1, $2, 'active', 1)`,
        [SUBJECT_ID, principalA],
      );
      await recordHistory(seed, SUBJECT_ID, principalA, 'created');
      // A tombstoned subject with matching history for the same principal.
      await recordHistory(seed, OTHER_SUBJECT_ID, principalA, 'created');
      await seed.query(
        `INSERT INTO ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_tombstones
           (provider, subject_id, prior_principal_id, authority_generation, revoked_at, reason_digest)
         VALUES ('discord', $1, $2, 1, clock_timestamp(), $3)`,
        [OTHER_SUBJECT_ID, principalA, 'a'.repeat(64)],
      );
    } finally {
      await seed.end();
    }

    await migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES });

    const inspect = createPostgresPool(db.migrationUrl, { max: 1, allowExitOnIdle: true });
    try {
      const rows = await inspect.query<{
        subject_id: string;
        principal_id: string;
        tombstoned: boolean;
      }>(
        `SELECT subject_id, principal_id, tombstoned
         FROM ${FLEET_AUTH_SCHEMA_NAME}.provider_subject_registry
         WHERE provider = 'discord'
         ORDER BY subject_id`,
      );
      expect(rows.rows).toEqual([
        { subject_id: SUBJECT_ID, principal_id: principalA, tombstoned: false },
        { subject_id: OTHER_SUBJECT_ID, principal_id: principalA, tombstoned: true },
      ]);
    } finally {
      await inspect.end();
    }
  }, TIMEOUT_MS);

  it('aborts the entire v4 upgrade when legacy history names conflicting principals', async () => {
    const db = await freshDatabase();
    await seedToVersionThree(db.migrationUrl);

    const principalA = randomUUID();
    const principalB = randomUUID();

    const seed = createPostgresPool(db.migrationUrl, { max: 1, allowExitOnIdle: true });
    try {
      await insertPrincipal(seed, principalA);
      await insertPrincipal(seed, principalB);
      // The immutable history names two different principals for one subject:
      // ambiguous legacy evidence that must not be silently resolved.
      await recordHistory(seed, SUBJECT_ID, principalA, 'created');
      await recordHistory(seed, SUBJECT_ID, principalB, 'linked');
    } finally {
      await seed.end();
    }

    await expect(
      migrateFleetAuthSchema({ databaseUrl: db.migrationUrl, roles: ROLES }),
    ).rejects.toThrow(/conflicting legacy principal identity evidence/);

    // The failed upgrade must leave no partial state: version 4 is not recorded
    // and the registry table it would have created does not exist.
    const inspect = createPostgresPool(db.migrationUrl, { max: 1, allowExitOnIdle: true });
    try {
      const ledger = await inspect.query<{ max_version: number }>(
        `SELECT max(version) AS max_version FROM ${FLEET_AUTH_SCHEMA_NAME}.schema_migrations`,
      );
      expect(Number(ledger.rows[0]?.max_version)).toBe(3);

      const registry = await inspect.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`${FLEET_AUTH_SCHEMA_NAME}.provider_subject_registry`],
      );
      expect(registry.rows[0]?.present).toBe(false);
    } finally {
      await inspect.end();
    }
  }, TIMEOUT_MS);
});
