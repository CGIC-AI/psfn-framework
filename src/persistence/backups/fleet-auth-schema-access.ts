import type { PoolClient } from 'pg';
import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  createPostgresPool,
} from '../postgres.js';
import {
  FLEET_AUTH_SCHEMA_NAME,
  type FleetAuthFamilyDatabaseRoles,
} from '../postgres/fleet-auth/schema.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';

export interface FleetAuthSchemaAccessContract {
  kind: 'companion' | 'shared';
  schema: string;
  ownerRole: string;
  runtimeRoles: readonly string[];
}

function assertValidRoleName(role: string, field: string): string {
  try {
    return assertValidPostgresRoleName(role);
  } catch {
    throw new Error(`Fleet auth family restore ${field} is not a safe PostgreSQL role name`);
  }
}

function quoteIdentifier(value: string): string {
  return `"${value}"`;
}

export function validateFleetAuthSchemaAccessContracts(
  contracts: readonly FleetAuthSchemaAccessContract[],
  expectedSchemas: readonly string[],
  fleetAuthRoles: FleetAuthFamilyDatabaseRoles,
): FleetAuthSchemaAccessContract[] {
  const expected = [...expectedSchemas].map(assertValidPostgresSchemaName).sort();
  const protectedFleetAuthRoles = new Set([
    fleetAuthRoles.runtime,
    fleetAuthRoles.migration,
    fleetAuthRoles.backupRestore,
  ]);
  const validated = contracts.map((contract, index) => {
    const schema = assertValidPostgresSchemaName(contract.schema);
    const ownerRole = assertValidRoleName(
      contract.ownerRole,
      `schema access contract ${index} ownerRole`,
    );
    if (!Array.isArray(contract.runtimeRoles) || contract.runtimeRoles.length === 0) {
      throw new Error(`Fleet auth family restore schema access contract ${index} has no runtime roles`);
    }
    const runtimeRoles = contract.runtimeRoles.map((role, roleIndex) => (
      assertValidRoleName(role, `schema access contract ${index} runtimeRoles[${roleIndex}]`)
    ));
    if (new Set(runtimeRoles).size !== runtimeRoles.length) {
      throw new Error(`Fleet auth family restore schema access contract ${index} repeats a runtime role`);
    }
    const protectedRole = runtimeRoles.find(role => protectedFleetAuthRoles.has(role));
    if (protectedRole || protectedFleetAuthRoles.has(ownerRole)) {
      throw new Error(
        `Fleet auth family restore refuses to map protected fleet_auth role ${protectedRole ?? ownerRole} to a tenant schema`,
      );
    }
    return {
      kind: contract.kind,
      schema,
      ownerRole,
      runtimeRoles: [...runtimeRoles].sort(),
    };
  });
  const actual = validated.map(contract => contract.schema).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Fleet auth family restore schema access mapping does not exactly match the dump family');
  }
  const shared = validated.filter(contract => contract.kind === 'shared');
  const companions = validated.filter(contract => contract.kind === 'companion');
  if (shared.length !== 1 || companions.length === 0) {
    throw new Error('Fleet auth family restore requires companion mappings and exactly one shared mapping');
  }
  const companionRuntimeRoles = companions.map((contract, index) => {
    if (contract.runtimeRoles.length !== 1 || contract.ownerRole !== contract.runtimeRoles[0]) {
      throw new Error(
        `Fleet auth family restore companion schema access contract ${index} must have one matching runtime owner`,
      );
    }
    return contract.runtimeRoles[0];
  });
  if (new Set(companionRuntimeRoles).size !== companionRuntimeRoles.length) {
    throw new Error('Fleet auth family restore refuses to map one companion role across sibling schemas');
  }
  if (companions.some(contract => contract.ownerRole === fleetAuthRoles.sharedMigration)) {
    throw new Error('Fleet auth family restore shared migration role must not own a companion schema');
  }
  if (shared[0].ownerRole !== fleetAuthRoles.sharedMigration) {
    throw new Error(
      `Fleet auth family restore shared schema must be owned by configured migration role ${fleetAuthRoles.sharedMigration}`,
    );
  }
  const expectedSharedRoles = [...companionRuntimeRoles].sort();
  if (JSON.stringify(shared[0].runtimeRoles) !== JSON.stringify(expectedSharedRoles)) {
    throw new Error('Fleet auth family restore shared access must name every companion runtime role exactly');
  }
  return validated.sort((left, right) => left.schema.localeCompare(right.schema));
}

async function assertMappedRolesAreSafe(
  client: PoolClient,
  contracts: readonly FleetAuthSchemaAccessContract[],
  expectedOwner: string,
): Promise<void> {
  const mappedRoles = [...new Set(contracts.flatMap(contract => (
    [contract.ownerRole, ...contract.runtimeRoles]
  )))].sort();
  await assertFleetAuthRolesAreSafe(client, mappedRoles, expectedOwner);
}

export async function assertFleetAuthRolesAreSafe(
  client: PoolClient,
  mappedRoles: readonly string[],
  expectedOwner: string,
): Promise<void> {
  const result = await client.query<{
    rolname: string;
    rolcanlogin: boolean;
    rolinherit: boolean;
    rolsuper: boolean;
    rolcreaterole: boolean;
    rolcreatedb: boolean;
    rolreplication: boolean;
    rolbypassrls: boolean;
  }>(`
    SELECT rolname, rolcanlogin, rolinherit, rolsuper, rolcreaterole, rolcreatedb,
           rolreplication, rolbypassrls
    FROM pg_roles
    WHERE rolname = ANY($1::text[])
    ORDER BY rolname
  `, [mappedRoles]);
  if (JSON.stringify(result.rows.map(row => row.rolname)) !== JSON.stringify(mappedRoles)) {
    throw new Error('Fleet auth family restore schema access mapping names an unknown PostgreSQL role');
  }
  const unsafe = result.rows.find(row => !row.rolcanlogin || row.rolinherit
    || row.rolsuper || row.rolcreaterole
    || row.rolcreatedb || row.rolreplication || row.rolbypassrls);
  if (unsafe) {
    throw new Error(
      `Fleet auth family restore runtime role ${unsafe.rolname} is not a least-privilege LOGIN role`,
    );
  }
  const memberships = await client.query<{ edge_count: number }>(`
    SELECT COUNT(*)::integer AS edge_count
    FROM pg_auth_members AS membership
    JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
    JOIN pg_roles AS member_role ON member_role.oid = membership.member
    WHERE granted_role.rolname = ANY($1::text[])
       OR member_role.rolname = ANY($1::text[])
  `, [mappedRoles]);
  if ((memberships.rows.at(0)?.edge_count ?? 0) > 0) {
    throw new Error('Fleet auth family restore mapped roles must not participate in role memberships');
  }
  const owner = await client.query<{ current_user: string }>('SELECT current_user');
  if (owner.rows.at(0)?.current_user !== expectedOwner) {
    throw new Error(`Fleet auth family restore must authenticate as PostgreSQL role ${expectedOwner}`);
  }
}

async function assertSchemaIsolation(
  client: PoolClient,
  contracts: readonly FleetAuthSchemaAccessContract[],
): Promise<void> {
  const companionContracts = contracts.filter(contract => contract.kind === 'companion');
  const companionRoles = companionContracts.map(contract => contract.runtimeRoles[0]);
  const schemas = contracts.map(contract => contract.schema);
  const privileges = await client.query<{
    role_name: string;
    schema_name: string;
    schema_usage: boolean;
    schema_create: boolean;
  }>(`
    SELECT role_name, schema_name,
           has_schema_privilege(role_name, schema_name, 'USAGE') AS schema_usage,
           has_schema_privilege(role_name, schema_name, 'CREATE') AS schema_create
    FROM unnest($1::text[]) AS role_name
    CROSS JOIN unnest($2::text[]) AS schema_name
    ORDER BY role_name, schema_name
  `, [companionRoles, schemas]);
  const sharedContract = contracts.find(contract => contract.kind === 'shared');
  if (!sharedContract) {
    throw new Error('Fleet auth schema access isolation requires one shared schema contract');
  }
  for (const row of privileges.rows) {
    const ownContract = companionContracts.find(
      contract => contract.runtimeRoles[0] === row.role_name,
    );
    if (!ownContract) {
      throw new Error(`Fleet auth schema access isolation found unknown role ${row.role_name}`);
    }
    const expectedUsage = row.schema_name === ownContract.schema
      || row.schema_name === sharedContract.schema;
    const expectedCreate = row.schema_name === ownContract.schema;
    if (row.schema_usage !== expectedUsage || row.schema_create !== expectedCreate) {
      throw new Error(
        `Fleet auth schema access isolation mismatch for role ${row.role_name} and schema ${row.schema_name}`,
      );
    }
  }
  await assertNoFleetAuthAccess(client, companionRoles);
}

async function assertNoFleetAuthAccess(
  client: PoolClient,
  companionRoles: readonly string[],
): Promise<void> {
  const fleetAccess = await client.query<{
    role_name: string;
    schema_usage: boolean;
    table_access: boolean;
  }>(`
    SELECT role_name,
           has_schema_privilege(role_name, 'fleet_auth', 'USAGE') AS schema_usage,
           EXISTS (
             SELECT 1
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = 'fleet_auth'
               AND has_table_privilege(
                 role_name,
                 relation.oid,
                 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
               )
           ) AS table_access
    FROM unnest($1::text[]) AS role_name
    ORDER BY role_name
  `, [companionRoles]);
  if (fleetAccess.rows.some(row => row.schema_usage || row.table_access)) {
    throw new Error('Fleet auth companion runtime role has forbidden fleet_auth access');
  }
}

export async function assertSharedMigrationAuthorityIsolation(
  client: PoolClient,
  companionSchemas: readonly string[],
  sharedSchema: string,
  sharedMigrationRole: string,
): Promise<void> {
  const forbiddenSchemas = [...companionSchemas, FLEET_AUTH_SCHEMA_NAME];
  const access = await client.query<{
    schema_name: string;
    schema_usage: boolean;
    schema_create: boolean;
    relation_access: boolean;
  }>(`
    SELECT schema_name,
           has_schema_privilege($1, schema_name, 'USAGE') AS schema_usage,
           has_schema_privilege($1, schema_name, 'CREATE') AS schema_create,
           EXISTS (
             SELECT 1
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = schema_name
               AND has_table_privilege(
                 $1,
                 relation.oid,
                 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
               )
           ) AS relation_access
    FROM unnest($2::text[]) AS schema_name
    ORDER BY schema_name
  `, [sharedMigrationRole, forbiddenSchemas]);
  if (access.rows.some(row => row.schema_usage || row.schema_create || row.relation_access)) {
    throw new Error(
      'Shared schema migration role must not access companion schemas or fleet_auth',
    );
  }

  const sharedOwnership = await client.query<{
    schema_owner: string | null;
    foreign_relation_owner_count: number;
    foreign_routine_owner_count: number;
  }>(`
    SELECT
      (
        SELECT owner.rolname
        FROM pg_namespace AS namespace
        JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = $1
      ) AS schema_owner,
      (
        SELECT COUNT(*)::integer
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1
          AND pg_get_userbyid(relation.relowner) <> $2
      ) AS foreign_relation_owner_count,
      (
        SELECT COUNT(*)::integer
        FROM pg_proc AS routine
        JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = $1
          AND pg_get_userbyid(routine.proowner) <> $2
      ) AS foreign_routine_owner_count
  `, [sharedSchema, sharedMigrationRole]);
  const ownership = sharedOwnership.rows.at(0);
  if (!ownership) throw new Error('Shared schema migration ownership preflight returned no result');
  if (ownership.schema_owner !== null && ownership.schema_owner !== sharedMigrationRole) {
    throw new Error(
      `Shared schema must be owned by configured migration role ${sharedMigrationRole}`,
    );
  }
  if (ownership.foreign_relation_owner_count > 0 || ownership.foreign_routine_owner_count > 0) {
    throw new Error(
      `Shared schema objects must be owned only by configured migration role ${sharedMigrationRole}`,
    );
  }
}

export async function resolveFleetAuthSchemaAccessContracts(options: {
  databaseUrl: string;
  companionSchemas: readonly string[];
  sharedSchema: string;
  roles: FleetAuthFamilyDatabaseRoles;
  /** Startup-only seam: grants are applied immediately after discovery. */
  verifyIsolation?: boolean;
}): Promise<FleetAuthSchemaAccessContract[]> {
  parseExactPostgresCredential(options.databaseUrl, 'Fleet auth schema access discovery credential');
  const companionSchemas = options.companionSchemas.map(assertValidPostgresSchemaName);
  const sharedSchema = assertValidPostgresSchemaName(options.sharedSchema);
  const expectedSchemas = [...companionSchemas, sharedSchema];
  if (new Set(expectedSchemas).size !== expectedSchemas.length || companionSchemas.length === 0) {
    throw new Error('Fleet auth schema access discovery requires distinct companion/shared schemas');
  }
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-schema-access-discovery',
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      const owners = await client.query<{ schema_name: string; owner_role: string }>(`
        SELECT namespace.nspname AS schema_name, owner.rolname AS owner_role
        FROM pg_namespace AS namespace
        JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = ANY($1::text[])
        ORDER BY namespace.nspname
      `, [expectedSchemas]);
      const ownerBySchema = new Map(
        owners.rows.map(row => [row.schema_name, row.owner_role] as const),
      );
      if (ownerBySchema.size !== expectedSchemas.length) {
        throw new Error('Fleet auth schema access discovery found a missing target schema');
      }
      const companionRoles = companionSchemas.map(schema => ownerBySchema.get(schema)!);
      const contracts = validateFleetAuthSchemaAccessContracts([
        ...companionSchemas.map((schema, index) => ({
          kind: 'companion' as const,
          schema,
          ownerRole: companionRoles[index],
          runtimeRoles: [companionRoles[index]],
        })),
        {
          kind: 'shared' as const,
          schema: sharedSchema,
          ownerRole: ownerBySchema.get(sharedSchema)!,
          runtimeRoles: companionRoles,
        },
      ], expectedSchemas, options.roles);
      await assertMappedRolesAreSafe(client, contracts, options.roles.backupRestore);
      if (options.verifyIsolation !== false) {
        await assertSchemaIsolation(client, contracts);
      }
      return contracts;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function assertFleetAuthSchemaAccessTargets(options: {
  databaseUrl: string;
  contracts: readonly FleetAuthSchemaAccessContract[];
  ownerRole: string;
  ownerDatabaseUrls: Readonly<Record<string, string>>;
}): Promise<void> {
  const credentialSchemas = Object.keys(options.ownerDatabaseUrls).sort();
  const expectedSchemas = options.contracts.map(contract => contract.schema).sort();
  if (JSON.stringify(credentialSchemas) !== JSON.stringify(expectedSchemas)) {
    throw new Error('Fleet auth family restore owner credentials do not exactly match the schema family');
  }
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-schema-access-preflight',
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await assertMappedRolesAreSafe(client, options.contracts, options.ownerRole);
      await assertNoFleetAuthAccess(
        client,
        options.contracts
          .filter(contract => contract.kind === 'companion')
          .map(contract => contract.runtimeRoles[0]),
      );
      const target = await client.query<{ database_name: string; system_identifier: string }>(`
        SELECT current_database() AS database_name,
               (pg_control_system()).system_identifier::text AS system_identifier
      `);
      const expectedTarget = target.rows.at(0);
      if (!expectedTarget) throw new Error('Fleet auth family restore could not identify its target database');
      for (const contract of options.contracts) {
        const ownerDatabaseUrl = options.ownerDatabaseUrls[contract.schema];
        parseExactPostgresCredential(
          ownerDatabaseUrl,
          `Fleet auth family restore owner credential for ${contract.schema}`,
        );
        const ownerPool = createPostgresPool(ownerDatabaseUrl, {
          applicationName: 'fleet-auth-schema-owner-preflight',
          max: 1,
        });
        try {
          const ownerClient = await ownerPool.connect();
          try {
            await assertMappedRolesAreSafe(ownerClient, options.contracts, contract.ownerRole);
            const createPrivilege = await ownerClient.query<{ allowed: boolean }>(`
              SELECT has_database_privilege(current_user, current_database(), 'CREATE') AS allowed
            `);
            if (createPrivilege.rows.at(0)?.allowed !== true) {
              throw new Error(
                `Fleet auth family restore owner credential for ${contract.schema} cannot create its schema`,
              );
            }
            const actualTarget = await ownerClient.query<{
              database_name: string;
              system_identifier: string;
            }>(`
              SELECT current_database() AS database_name,
                     (pg_control_system()).system_identifier::text AS system_identifier
            `);
            if (JSON.stringify(actualTarget.rows.at(0)) !== JSON.stringify(expectedTarget)) {
              throw new Error(
                `Fleet auth family restore owner credential for ${contract.schema} targets another database`,
              );
            }
          } finally {
            ownerClient.release();
          }
        } finally {
          await ownerPool.end();
        }
      }
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function applyFleetAuthSchemaAccessContracts(options: {
  contracts: readonly FleetAuthSchemaAccessContract[];
  ownerDatabaseUrls: Readonly<Record<string, string>>;
  backupRole: string;
}): Promise<void> {
  const backupRole = assertValidRoleName(options.backupRole, 'backupRole');
  for (const contract of options.contracts) {
    const pool = createPostgresPool(options.ownerDatabaseUrls[contract.schema], {
      applicationName: 'fleet-auth-schema-access-restore',
      max: 1,
    });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await assertMappedRolesAreSafe(client, options.contracts, contract.ownerRole);
      const schema = quoteIdentifier(contract.schema);
      const grantees = contract.runtimeRoles.map(quoteIdentifier).join(', ');
      const owners = await client.query<{
        schema_owner: string;
        foreign_relation_owner_count: number;
        foreign_routine_owner_count: number;
      }>(`
        SELECT owner.rolname AS schema_owner,
          (
            SELECT COUNT(*)::integer
            FROM pg_class AS relation
            WHERE relation.relnamespace = namespace.oid
              AND pg_get_userbyid(relation.relowner) <> $2
          ) AS foreign_relation_owner_count,
          (
            SELECT COUNT(*)::integer
            FROM pg_proc AS routine
            WHERE routine.pronamespace = namespace.oid
              AND pg_get_userbyid(routine.proowner) <> $2
          ) AS foreign_routine_owner_count
        FROM pg_namespace AS namespace
        JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = $1
      `, [contract.schema, contract.ownerRole]);
      const ownership = owners.rows.at(0);
      if (!ownership || ownership.schema_owner !== contract.ownerRole
        || ownership.foreign_relation_owner_count > 0
        || ownership.foreign_routine_owner_count > 0) {
        throw new Error(
          `Fleet auth family restore schema ${contract.schema} is not owned exactly by ${contract.ownerRole}: `
          + `schema=${ownership?.schema_owner ?? 'missing'}, `
          + `foreignRelations=${ownership?.foreign_relation_owner_count ?? 0}, `
          + `foreignRoutines=${ownership?.foreign_routine_owner_count ?? 0}`,
        );
      }
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${grantees}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${grantees}`);
      await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${grantees}`);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${grantees}`);
      if (contract.kind === 'shared') {
        await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${grantees}`);
        await client.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${grantees}`,
        );
        await client.query(
          `REVOKE INSERT, UPDATE, DELETE ON ${schema}.shared_schema_migrations FROM ${grantees}`,
        );
        await client.query(
          `GRANT SELECT, USAGE, UPDATE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${grantees}`,
        );
      } else {
        await client.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${grantees}`);
        await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${grantees}`);
        await client.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${grantees}`);
      }
      await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${grantees}`);
      await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${quoteIdentifier(backupRole)}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${quoteIdentifier(backupRole)}`);
      await client.query(`GRANT SELECT, USAGE ON ALL SEQUENCES IN SCHEMA ${schema} TO ${quoteIdentifier(backupRole)}`);
      const allowedGrantees = [contract.ownerRole, backupRole, ...contract.runtimeRoles];
      const unexpectedGrantees = await client.query<{ role_name: string }>(`
        WITH acl_grantees AS (
          SELECT acl.grantee
          FROM pg_namespace AS namespace
          CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
          WHERE namespace.nspname = $1
          UNION
          SELECT acl.grantee
          FROM pg_class AS relation
          JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
          CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
          WHERE namespace.nspname = $1
          UNION
          SELECT acl.grantee
          FROM pg_proc AS routine
          JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
          CROSS JOIN LATERAL aclexplode(routine.proacl) AS acl
          WHERE namespace.nspname = $1
        )
        SELECT DISTINCT CASE
          WHEN grantee = 0 THEN 'PUBLIC'
          ELSE pg_get_userbyid(grantee)
        END AS role_name
        FROM acl_grantees
        WHERE grantee = 0 OR pg_get_userbyid(grantee) <> ALL($2::text[])
        ORDER BY role_name
      `, [contract.schema, allowedGrantees]);
      if (unexpectedGrantees.rows.length > 0) {
        throw new Error(
          `Fleet auth family restore schema ${contract.schema} has unexpected PostgreSQL grantees: `
          + unexpectedGrantees.rows.map(row => row.role_name).join(', '),
        );
      }
      await client.query('COMMIT');
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          `Fleet auth schema access application and rollback failed for ${contract.schema}`,
        );
      }
      throw error;
    } finally {
      client.release();
      await pool.end();
    }
  }
}

export async function assertFleetAuthSchemaAccessIsolation(options: {
  databaseUrl: string;
  contracts: readonly FleetAuthSchemaAccessContract[];
  ownerRole: string;
}): Promise<void> {
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-schema-access-verification',
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await assertMappedRolesAreSafe(client, options.contracts, options.ownerRole);
      await assertSchemaIsolation(client, options.contracts);
      const shared = options.contracts.find(contract => contract.kind === 'shared');
      if (!shared) throw new Error('Fleet auth schema access isolation requires a shared contract');
      await assertSharedMigrationAuthorityIsolation(
        client,
        options.contracts
          .filter(contract => contract.kind === 'companion')
          .map(contract => contract.schema),
        shared.schema,
        shared.ownerRole,
      );
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}
