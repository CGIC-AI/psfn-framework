import type { Pool, PoolClient } from 'pg';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
} from '../postgres.js';
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';
import { bootstrapSharedWikiSchema } from '../postgres/shared-schema.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';
import {
  applyFleetAuthSchemaAccessContracts,
  assertFleetAuthRolesAreSafe,
  assertFleetAuthSchemaAccessIsolation,
  assertSharedMigrationAuthorityIsolation,
  validateFleetAuthSchemaAccessContracts,
  type FleetAuthSchemaAccessContract,
  type FleetAuthWelfareVerifierSchemaAccess,
} from './fleet-auth-schema-access.js';

interface DatabaseTargetIdentity {
  database_name: string;
  system_identifier: string;
}

export interface CompanionSharedSchemaDatabase {
  databaseUrl: string;
  role: string;
  schema: string;
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

async function connectPreflightPool(databaseUrl: string, applicationName: string): Promise<{
  pool: Pool;
  client: PoolClient;
}> {
  const pool = createPostgresPool(databaseUrl, { applicationName, max: 1 });
  try {
    return { pool, client: await pool.connect() };
  } catch (error) {
    await pool.end();
    throw error;
  }
}

/**
 * Production shared-schema startup authority chain. Topology-owned credentials
 * are resolved by the gateway before this function is called. Every credential,
 * role posture, database target, schema owner, and isolation invariant is proved
 * before the dedicated owner executes the base + pgvector wiki DDL chains.
 */
export async function prepareFleetSharedSchemaRuntime(options: {
  sharedMigrationDatabaseUrl: string;
  sharedMigrationRole: string;
  companionDatabases: readonly CompanionSharedSchemaDatabase[];
  sharedSchema: string;
  fleetAuth?: {
    backupRestoreDatabaseUrl: string;
    roles: FleetAuthDatabaseRoles;
    welfareVerifier?: FleetAuthWelfareVerifierSchemaAccess;
  };
}): Promise<FleetAuthSchemaAccessContract[]> {
  const migrationCredential = parseExactPostgresCredential(
    options.sharedMigrationDatabaseUrl,
    'Fleet shared schema migration credential',
  );
  if (migrationCredential.username !== options.sharedMigrationRole) {
    throw new Error(
      `Fleet shared schema migration credential must authenticate as PostgreSQL role ${options.sharedMigrationRole}`,
    );
  }
  const companionDatabases = options.companionDatabases.map((entry, index) => {
    const schema = assertValidPostgresSchemaName(entry.schema);
    const credential = parseExactPostgresCredential(
      entry.databaseUrl,
      `Fleet shared schema companion credential ${index}`,
    );
    if (credential.username !== entry.role) {
      throw new Error(
        `Fleet shared schema companion credential ${index} must authenticate as PostgreSQL role ${entry.role}`,
      );
    }
    return { ...entry, schema };
  });
  const sharedSchema = assertValidPostgresSchemaName(options.sharedSchema);
  const companionSchemas = companionDatabases.map(entry => entry.schema);
  const companionRoles = companionDatabases.map(entry => entry.role);
  if (companionDatabases.length === 0
    || new Set([...companionSchemas, sharedSchema]).size !== companionSchemas.length + 1
    || new Set(companionRoles).size !== companionRoles.length
    || companionRoles.includes(options.sharedMigrationRole)) {
    throw new Error('Fleet shared schema startup requires distinct companion/shared schema authorities');
  }

  const welfareVerifierRole = options.fleetAuth?.welfareVerifier?.role;
  const welfareVerifierCredential = options.fleetAuth?.welfareVerifier
    ? parseExactPostgresCredential(
        options.fleetAuth.welfareVerifier.databaseUrl,
        'Fleet shared schema welfare verifier credential',
      )
    : undefined;
  if (welfareVerifierCredential && welfareVerifierCredential.username !== welfareVerifierRole) {
    throw new Error(
      `Fleet shared schema welfare verifier credential must authenticate as PostgreSQL role ${welfareVerifierRole}`,
    );
  }
  const protectedRoles = options.fleetAuth ? Object.values(options.fleetAuth.roles) : [];
  const mappedRoles = [...new Set([
    ...protectedRoles,
    ...(welfareVerifierRole ? [welfareVerifierRole] : []),
    options.sharedMigrationRole,
    ...companionRoles,
  ])].sort();
  if (mappedRoles.length !== protectedRoles.length + companionRoles.length + 1
    + (welfareVerifierRole ? 1 : 0)) {
    throw new Error('Fleet shared schema startup requires every authority role to be distinct');
  }
  const credentialValues = [
    options.sharedMigrationDatabaseUrl,
    ...companionDatabases.map(entry => entry.databaseUrl),
    ...(options.fleetAuth ? [options.fleetAuth.backupRestoreDatabaseUrl] : []),
    ...(options.fleetAuth?.welfareVerifier
      ? [options.fleetAuth.welfareVerifier.databaseUrl]
      : []),
  ];
  if (new Set(credentialValues).size !== credentialValues.length) {
    throw new Error('Fleet shared schema startup requires every database credential to be distinct');
  }

  const connections: Array<{ pool: Pool; client: PoolClient }> = [];
  try {
    const migration = await connectPreflightPool(
      options.sharedMigrationDatabaseUrl,
      'fleet-shared-schema-migration-preflight',
    );
    connections.push(migration);
    const companionConnections = [];
    for (let index = 0; index < companionDatabases.length; index += 1) {
      const connection = await connectPreflightPool(
        companionDatabases[index]!.databaseUrl,
        `fleet-shared-schema-companion-${index}-preflight`,
      );
      connections.push(connection);
      companionConnections.push(connection);
    }
    const backup = options.fleetAuth
      ? await connectPreflightPool(
          options.fleetAuth.backupRestoreDatabaseUrl,
          'fleet-shared-schema-backup-preflight',
        )
      : undefined;
    if (backup) connections.push(backup);
    const welfareVerifier = options.fleetAuth?.welfareVerifier
      ? await connectPreflightPool(
          options.fleetAuth.welfareVerifier.databaseUrl,
          'fleet-shared-schema-welfare-verifier-preflight',
        )
      : undefined;
    if (welfareVerifier) connections.push(welfareVerifier);

    await assertFleetAuthRolesAreSafe(
      migration.client,
      mappedRoles,
      options.sharedMigrationRole,
    );
    const expectedTarget = await readDatabaseTargetIdentity(migration.client);
    const createPrivilege = await migration.client.query<{ allowed: boolean }>(`
      SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed
    `);
    if (createPrivilege.rows.at(0)?.allowed !== true) {
      throw new Error('Fleet shared schema migration role requires CREATE on the target database');
    }
    const vectorExtension = await migration.client.query<{ installed: boolean }>(`
      SELECT EXISTS (
        SELECT 1
        FROM pg_extension AS extension
        JOIN pg_namespace AS namespace ON namespace.oid = extension.extnamespace
        WHERE extension.extname = 'vector' AND namespace.nspname = 'extensions'
      ) AS installed
    `);
    if (vectorExtension.rows.at(0)?.installed !== true) {
      throw new Error(
        'Fleet shared schema startup requires the operator-provisioned vector extension in extensions',
      );
    }

    for (let index = 0; index < companionConnections.length; index += 1) {
      const entry = companionDatabases[index]!;
      const connection = companionConnections[index]!;
      await assertFleetAuthRolesAreSafe(connection.client, mappedRoles, entry.role);
      const target = await readDatabaseTargetIdentity(connection.client);
      if (JSON.stringify(target) !== JSON.stringify(expectedTarget)) {
        throw new Error(`Fleet shared schema companion credential ${index} targets another database`);
      }
    }
    if (backup && options.fleetAuth) {
      await assertFleetAuthRolesAreSafe(
        backup.client,
        mappedRoles,
        options.fleetAuth.roles.backupRestore,
      );
      const target = await readDatabaseTargetIdentity(backup.client);
      if (JSON.stringify(target) !== JSON.stringify(expectedTarget)) {
        throw new Error('Fleet shared schema backup credential targets another database');
      }
    }
    if (welfareVerifier && welfareVerifierRole) {
      await assertFleetAuthRolesAreSafe(
        welfareVerifier.client,
        mappedRoles,
        welfareVerifierRole,
      );
      const target = await readDatabaseTargetIdentity(welfareVerifier.client);
      if (JSON.stringify(target) !== JSON.stringify(expectedTarget)) {
        throw new Error('Fleet shared schema welfare verifier credential targets another database');
      }
    }

    const owners = await migration.client.query<{ schema_name: string; owner_role: string }>(`
      SELECT namespace.nspname AS schema_name, owner.rolname AS owner_role
      FROM pg_namespace AS namespace
      JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
      WHERE namespace.nspname = ANY($1::text[])
      ORDER BY namespace.nspname
    `, [companionSchemas]);
    const expectedOwners = new Map(companionDatabases.map(entry => [entry.schema, entry.role]));
    if (owners.rows.length !== companionSchemas.length
      || owners.rows.some(row => expectedOwners.get(row.schema_name) !== row.owner_role)) {
      throw new Error('Fleet shared schema startup found a missing or incorrectly owned companion schema');
    }
    await assertSharedMigrationAuthorityIsolation(
      migration.client,
      companionSchemas,
      sharedSchema,
      options.sharedMigrationRole,
    );
  } finally {
    for (const connection of connections) {
      connection.client.release();
    }
    await Promise.all(connections.map(connection => connection.pool.end()));
  }

  await bootstrapSharedWikiSchema(options.sharedMigrationDatabaseUrl);
  const contracts = validateFleetAuthSchemaAccessContracts([
    ...companionDatabases.map(entry => ({
      kind: 'companion' as const,
      schema: entry.schema,
      ownerRole: entry.role,
      runtimeRoles: [entry.role],
    })),
    {
      kind: 'shared' as const,
      schema: sharedSchema,
      ownerRole: options.sharedMigrationRole,
      runtimeRoles: companionRoles,
    },
  ], [...companionSchemas, sharedSchema], {
    sharedMigration: options.sharedMigrationRole,
    protectedRoles,
  });
  await applyFleetAuthSchemaAccessContracts({
    contracts,
    ownerDatabaseUrls: Object.fromEntries([
      ...companionDatabases.map(entry => [entry.schema, entry.databaseUrl] as const),
      [sharedSchema, options.sharedMigrationDatabaseUrl],
    ]),
    ...(options.fleetAuth ? { backupRole: options.fleetAuth.roles.backupRestore } : {}),
    ...(welfareVerifierRole ? { welfareVerifierRole } : {}),
  });
  await assertFleetAuthSchemaAccessIsolation({
    databaseUrl: options.sharedMigrationDatabaseUrl,
    contracts,
    ownerRole: options.sharedMigrationRole,
    ...(welfareVerifierRole ? { welfareVerifierRole } : {}),
  });
  return contracts;
}
