import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { createPostgresPool } from '../../postgres.js';
import { FLEET_AUTH_MIGRATIONS } from './migrations.js';

export const FLEET_AUTH_SCHEMA_NAME = 'fleet_auth';
const MIGRATION_LOCK_CLASS = 0x5053464e;
const MIGRATION_LOCK_ID = 0x46415554;
const ROLE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;

export interface FleetAuthDatabaseRoles {
  runtime: string;
  migration: string;
  backupRestore: string;
}

export const FLEET_AUTH_DURABLE_TABLES = [
  'authority_state',
  'human_principals',
  'provider_subjects',
  'provider_subject_history',
  'provider_subject_tombstones',
  'principal_contact_bindings',
  'principal_role_grants',
  'passkey_credentials',
  'authorization_audit_events',
] as const;

export const FLEET_AUTH_EPHEMERAL_TABLES = [
  'discord_evidence_snapshots',
  'oauth_transactions',
  'provider_token_custody',
  'browser_sessions',
  'step_up_challenges',
  'jit_authorization_grants',
  'trusted_host_ceremonies',
] as const;

const FLEET_AUTH_MUTABLE_TABLES = [
  'authority_state',
  'human_principals',
  'provider_subjects',
  'principal_contact_bindings',
  'principal_role_grants',
  'passkey_credentials',
  ...FLEET_AUTH_EPHEMERAL_TABLES,
] as const;

const FLEET_AUTH_IMMUTABLE_TABLES = [
  'provider_subject_history',
  'provider_subject_tombstones',
  'authorization_audit_events',
] as const;

function quoteIdentifier(identifier: string): string {
  if (!ROLE_PATTERN.test(identifier)) {
    throw new Error(`Invalid fleet auth PostgreSQL role name ${JSON.stringify(identifier)}`);
  }
  return `"${identifier}"`;
}

function qualifiedTable(table: string): string {
  return `"${FLEET_AUTH_SCHEMA_NAME}"."${table}"`;
}

function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

function assertDistinctRoles(roles: FleetAuthDatabaseRoles): void {
  const values = Object.values(roles);
  values.forEach(quoteIdentifier);
  if (new Set(values).size !== values.length) {
    throw new Error('Fleet auth PostgreSQL runtime, migration, and backup/restore roles must be distinct');
  }
}

async function assertCurrentRole(
  pool: Pool,
  expectedRole: string,
  authority: string,
  forbiddenMemberships: readonly string[],
): Promise<void> {
  const result = await pool.query<{ current_user: string; rolsuper: boolean; rolbypassrls: boolean }>(`
    SELECT current_user, rol.rolsuper, rol.rolbypassrls
    FROM pg_roles AS rol
    WHERE rol.rolname = current_user
  `);
  const row = result.rows.at(0);
  if (!row || row.current_user !== expectedRole) {
    throw new Error(`${authority} credential must authenticate as PostgreSQL role ${expectedRole}`);
  }
  if (row.rolsuper || row.rolbypassrls) {
    throw new Error(`${authority} PostgreSQL role must not be superuser or BYPASSRLS`);
  }
  const memberships = await pool.query<{ role_name: string }>(`
    SELECT role_name
    FROM unnest($1::text[]) AS role_name
    WHERE pg_has_role(current_user, role_name, 'MEMBER')
  `, [forbiddenMemberships]);
  if (memberships.rows.length > 0) {
    throw new Error(`${authority} PostgreSQL role must not inherit or SET ROLE into another fleet auth authority`);
  }
}

async function applyRoleGrants(
  client: import('pg').PoolClient,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  const runtime = quoteIdentifier(roles.runtime);
  const backup = quoteIdentifier(roles.backupRestore);
  const schema = `"${FLEET_AUTH_SCHEMA_NAME}"`;
  await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC, ${runtime}, ${backup}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtime}, ${backup}`);
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${FLEET_AUTH_MUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${runtime}`,
  );
  await client.query(
    `GRANT SELECT, INSERT ON ${FLEET_AUTH_IMMUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${runtime}`,
  );
  // The repo-owned coordinator alone restores durable rows and invalidates
  // ephemeral rows. It receives DML but never schema/migration authority.
  await client.query(
    `GRANT SELECT, INSERT, UPDATE, DELETE ON ${FLEET_AUTH_MUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${backup}`,
  );
  await client.query(
    `GRANT SELECT, INSERT ON ${FLEET_AUTH_IMMUTABLE_TABLES.map(qualifiedTable).join(', ')} TO ${backup}`,
  );
  await client.query(`REVOKE ALL ON ${qualifiedTable('schema_migrations')} FROM ${runtime}, ${backup}`);
}

export async function migrateFleetAuthSchema(options: {
  databaseUrl: string;
  roles: FleetAuthDatabaseRoles;
}): Promise<void> {
  assertDistinctRoles(options.roles);
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'psfn-fleet-auth-migration',
    allowExitOnIdle: true,
    max: 1,
  });
  try {
    await assertCurrentRole(
      pool,
      options.roles.migration,
      'Fleet auth migration',
      [options.roles.runtime, options.roles.backupRestore],
    );
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'SELECT pg_advisory_xact_lock($1::integer, $2::integer)',
        [MIGRATION_LOCK_CLASS, MIGRATION_LOCK_ID],
      );
      await client.query(`CREATE SCHEMA IF NOT EXISTS "${FLEET_AUTH_SCHEMA_NAME}"`);
      const schemaOwner = await client.query<{ owner_name: string }>(`
        SELECT owner_role.rolname AS owner_name
        FROM pg_namespace AS namespace
        JOIN pg_roles AS owner_role ON owner_role.oid = namespace.nspowner
        WHERE namespace.nspname = $1
      `, [FLEET_AUTH_SCHEMA_NAME]);
      if (schemaOwner.rows.at(0)?.owner_name !== options.roles.migration) {
        throw new Error('fleet_auth schema must be owned by the configured migration role');
      }
      await client.query(`REVOKE ALL ON SCHEMA "${FLEET_AUTH_SCHEMA_NAME}" FROM PUBLIC`);
      await client.query(`SET LOCAL search_path TO "${FLEET_AUTH_SCHEMA_NAME}", public`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY CHECK (version >= 1),
          name TEXT NOT NULL UNIQUE,
          checksum TEXT NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
          applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
        )
      `);
      for (const migration of FLEET_AUTH_MIGRATIONS) {
        const checksum = migrationChecksum(migration.sql);
        const existing = await client.query<{ name: string; checksum: string }>(
          'SELECT name, checksum FROM schema_migrations WHERE version = $1',
          [migration.version],
        );
        const row = existing.rows.at(0);
        if (row) {
          if (row.name !== migration.name || row.checksum !== checksum) {
            throw new Error(`Fleet auth migration ${migration.version} checksum/name mismatch`);
          }
          continue;
        }
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name, checksum) VALUES ($1, $2, $3)',
          [migration.version, migration.name, checksum],
        );
      }
      await applyRoleGrants(client, options.roles);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

async function assertNoDdlOrLedger(
  pool: Pool,
  expectedRole: string,
  authority: string,
  forbiddenMemberships: readonly string[],
): Promise<void> {
  await assertCurrentRole(pool, expectedRole, authority, forbiddenMemberships);
  const result = await pool.query<{
    schema_usage: boolean;
    schema_create: boolean;
    ledger_select: boolean;
  }>(`
    SELECT
      has_schema_privilege(current_user, $1, 'USAGE') AS schema_usage,
      has_schema_privilege(current_user, $1, 'CREATE') AS schema_create,
      has_table_privilege(current_user, $2, 'SELECT') AS ledger_select
  `, [FLEET_AUTH_SCHEMA_NAME, `${FLEET_AUTH_SCHEMA_NAME}.schema_migrations`]);
  const row = result.rows.at(0);
  if (!row?.schema_usage || row.schema_create || row.ledger_select) {
    throw new Error(`${authority} PostgreSQL privileges violate the fleet_auth least-privilege boundary`);
  }
}

async function assertNoUnexpectedFleetAuthGrantees(
  pool: Pool,
  roles: FleetAuthDatabaseRoles,
  authority: string,
): Promise<void> {
  const allowed = [roles.runtime, roles.migration, roles.backupRestore];
  const result = await pool.query<{ role_name: string }>(`
    WITH acl_grantees AS (
      SELECT acl.grantee
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(namespace.nspacl, acldefault('n', namespace.nspowner))
      ) AS acl
      WHERE namespace.nspname = $1
      UNION
      SELECT acl.grantee
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(relation.relacl, acldefault('r', relation.relowner))
      ) AS acl
      WHERE namespace.nspname = $1
      UNION
      SELECT acl.grantee
      FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      CROSS JOIN LATERAL aclexplode(
        COALESCE(routine.proacl, acldefault('f', routine.proowner))
      ) AS acl
      WHERE namespace.nspname = $1
    )
    SELECT DISTINCT CASE WHEN grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(grantee) END AS role_name
    FROM acl_grantees
    WHERE grantee = 0 OR NOT (pg_get_userbyid(grantee) = ANY($2::text[]))
    ORDER BY role_name
  `, [FLEET_AUTH_SCHEMA_NAME, allowed]);
  if (result.rows.length > 0) {
    throw new Error(
      `${authority} found unexpected fleet_auth grantees: ${result.rows.map(row => row.role_name).join(', ')}`,
    );
  }
}

async function assertRepresentativeDml(pool: Pool, authority: string): Promise<void> {
  const result = await pool.query<{
    principal_select: boolean;
    principal_insert: boolean;
    principal_update: boolean;
    principal_delete: boolean;
    audit_insert: boolean;
    audit_update: boolean;
  }>(`
    SELECT
      has_table_privilege(current_user, $1, 'SELECT') AS principal_select,
      has_table_privilege(current_user, $1, 'INSERT') AS principal_insert,
      has_table_privilege(current_user, $1, 'UPDATE') AS principal_update,
      has_table_privilege(current_user, $1, 'DELETE') AS principal_delete,
      has_table_privilege(current_user, $2, 'INSERT') AS audit_insert,
      has_table_privilege(current_user, $2, 'UPDATE') AS audit_update
  `, [
    `${FLEET_AUTH_SCHEMA_NAME}.human_principals`,
    `${FLEET_AUTH_SCHEMA_NAME}.authorization_audit_events`,
  ]);
  const row = result.rows.at(0);
  if (!row?.principal_select || !row.principal_insert || !row.principal_update
    || !row.principal_delete || !row.audit_insert || row.audit_update) {
    throw new Error(`${authority} PostgreSQL DML privileges violate the fleet_auth contract`);
  }
}

export async function assertFleetAuthRuntimePrivileges(
  databaseUrl: string,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  assertDistinctRoles(roles);
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-fleet-auth-runtime-preflight',
    max: 1,
  });
  try {
    await assertNoDdlOrLedger(
      pool,
      roles.runtime,
      'Fleet auth runtime',
      [roles.migration, roles.backupRestore],
    );
    await assertNoUnexpectedFleetAuthGrantees(pool, roles, 'Fleet auth runtime');
    await assertRepresentativeDml(pool, 'Fleet auth runtime');
  } finally {
    await pool.end();
  }
}

export async function assertFleetAuthBackupRestorePrivileges(
  databaseUrl: string,
  roles: FleetAuthDatabaseRoles,
): Promise<void> {
  assertDistinctRoles(roles);
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-fleet-auth-backup-preflight',
    max: 1,
  });
  try {
    await assertNoDdlOrLedger(
      pool,
      roles.backupRestore,
      'Fleet auth backup/restore',
      [roles.runtime, roles.migration],
    );
    await assertNoUnexpectedFleetAuthGrantees(pool, roles, 'Fleet auth backup/restore');
    await assertRepresentativeDml(pool, 'Fleet auth backup/restore');
  } finally {
    await pool.end();
  }
}

export async function hasDurableFleetAuthAuthority(pool: Pool): Promise<boolean> {
  const result = await pool.query<{ present: boolean }>(`
    SELECT (
      EXISTS (SELECT 1 FROM ${qualifiedTable('human_principals')} LIMIT 1)
      OR EXISTS (SELECT 1 FROM ${qualifiedTable('provider_subject_tombstones')} LIMIT 1)
      OR EXISTS (SELECT 1 FROM ${qualifiedTable('passkey_credentials')} LIMIT 1)
      OR EXISTS (
        SELECT 1 FROM ${qualifiedTable('authority_state')}
        WHERE authority_generation > 1 OR restore_checkpoint > 0 OR global_auth_epoch > 1
      )
    ) AS present
  `);
  return result.rows[0]?.present === true;
}
