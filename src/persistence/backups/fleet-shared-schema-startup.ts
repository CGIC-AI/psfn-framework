import type { PoolClient } from 'pg';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
} from '../postgres.js';
import type { FleetAuthFamilyDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import { bootstrapSharedSchema } from '../postgres/shared-schema.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';
import {
  applyFleetAuthSchemaAccessContracts,
  assertFleetAuthRolesAreSafe,
  assertFleetAuthSchemaAccessIsolation,
  assertSharedMigrationAuthorityIsolation,
  resolveFleetAuthSchemaAccessContracts,
  type FleetAuthSchemaAccessContract,
} from './fleet-auth-schema-access.js';

interface DatabaseTargetIdentity {
  database_name: string;
  system_identifier: string;
}

async function readDatabaseTargetIdentity(client: PoolClient): Promise<DatabaseTargetIdentity> {
  const result = await client.query<DatabaseTargetIdentity>(`
    SELECT current_database() AS database_name,
           (pg_control_system()).system_identifier::text AS system_identifier
  `);
  const identity = result.rows.at(0);
  if (!identity) throw new Error('Fleet shared schema startup could not identify its target database');
  return identity;
}

/**
 * Production shared-schema startup authority chain. All identity, role-posture,
 * target-database, ownership, and isolation checks complete before the first
 * shared DDL statement. The dedicated owner then runs migrations and refreshes
 * the exact least-privilege runtime grants used by every companion.
 */
export async function prepareFleetSharedSchemaRuntime(options: {
  backupRestoreDatabaseUrl: string;
  sharedMigrationDatabaseUrl: string;
  companionSchemas: readonly string[];
  sharedSchema: string;
  roles: FleetAuthFamilyDatabaseRoles;
}): Promise<FleetAuthSchemaAccessContract[]> {
  const backupCredential = parseExactPostgresCredential(
    options.backupRestoreDatabaseUrl,
    'Fleet shared schema backup/restore credential',
  );
  const migrationCredential = parseExactPostgresCredential(
    options.sharedMigrationDatabaseUrl,
    'Fleet shared schema migration credential',
  );
  if (backupCredential.username !== options.roles.backupRestore) {
    throw new Error(
      `Fleet shared schema backup/restore credential must authenticate as PostgreSQL role ${options.roles.backupRestore}`,
    );
  }
  if (migrationCredential.username !== options.roles.sharedMigration) {
    throw new Error(
      `Fleet shared schema migration credential must authenticate as PostgreSQL role ${options.roles.sharedMigration}`,
    );
  }
  if (options.backupRestoreDatabaseUrl === options.sharedMigrationDatabaseUrl) {
    throw new Error('Fleet shared schema migration credential must be distinct from backup/restore');
  }

  const companionSchemas = options.companionSchemas.map(assertValidPostgresSchemaName);
  const sharedSchema = assertValidPostgresSchemaName(options.sharedSchema);
  if (companionSchemas.length === 0
    || new Set([...companionSchemas, sharedSchema]).size !== companionSchemas.length + 1) {
    throw new Error('Fleet shared schema startup requires distinct companion/shared schemas');
  }

  const backupPool = createPostgresPool(options.backupRestoreDatabaseUrl, {
    applicationName: 'fleet-shared-schema-preflight',
    max: 1,
  });
  const migrationPool = createPostgresPool(options.sharedMigrationDatabaseUrl, {
    applicationName: 'fleet-shared-schema-migration-preflight',
    max: 1,
  });
  let backupClient: PoolClient | undefined;
  let migrationClient: PoolClient | undefined;
  try {
    backupClient = await backupPool.connect();
    migrationClient = await migrationPool.connect();
    const companionOwners = await backupClient.query<{ owner_role: string }>(`
      SELECT owner.rolname AS owner_role
      FROM pg_namespace AS namespace
      JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname
    `, [companionSchemas]);
    if (companionOwners.rows.length !== companionSchemas.length) {
      throw new Error('Fleet shared schema startup found a missing companion schema');
    }
    const mappedRoles = [...new Set([
      options.roles.runtime,
      options.roles.migration,
      options.roles.backupRestore,
      options.roles.sharedMigration,
      ...companionOwners.rows.map(row => row.owner_role),
    ])].sort();
    await assertFleetAuthRolesAreSafe(
      backupClient,
      mappedRoles,
      options.roles.backupRestore,
    );
    await assertFleetAuthRolesAreSafe(
      migrationClient,
      mappedRoles,
      options.roles.sharedMigration,
    );
    const createPrivilege = await migrationClient.query<{ allowed: boolean }>(`
      SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed
    `);
    if (createPrivilege.rows.at(0)?.allowed !== true) {
      throw new Error('Fleet shared schema migration role requires CREATE on the target database');
    }
    const [expectedTarget, actualTarget] = await Promise.all([
      readDatabaseTargetIdentity(backupClient),
      readDatabaseTargetIdentity(migrationClient),
    ]);
    if (JSON.stringify(actualTarget) !== JSON.stringify(expectedTarget)) {
      throw new Error('Fleet shared schema migration credential targets another database');
    }
    await assertSharedMigrationAuthorityIsolation(
      migrationClient,
      companionSchemas,
      sharedSchema,
      options.roles.sharedMigration,
    );
  } finally {
    migrationClient?.release();
    backupClient?.release();
    await Promise.all([backupPool.end(), migrationPool.end()]);
  }

  await bootstrapSharedSchema(options.sharedMigrationDatabaseUrl);
  const contracts = await resolveFleetAuthSchemaAccessContracts({
    databaseUrl: options.backupRestoreDatabaseUrl,
    companionSchemas,
    sharedSchema,
    roles: options.roles,
    verifyIsolation: false,
  });
  const sharedContract = contracts.find(contract => contract.kind === 'shared');
  if (!sharedContract) throw new Error('Fleet shared schema startup resolved no shared contract');
  await applyFleetAuthSchemaAccessContracts({
    contracts: [sharedContract],
    ownerDatabaseUrls: { [sharedSchema]: options.sharedMigrationDatabaseUrl },
    backupRole: options.roles.backupRestore,
  });
  await assertFleetAuthSchemaAccessIsolation({
    databaseUrl: options.backupRestoreDatabaseUrl,
    contracts,
    ownerRole: options.roles.backupRestore,
  });
  return contracts;
}
