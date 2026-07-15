import type { PoolClient } from 'pg';
import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  createPostgresPool,
} from '../postgres.js';
import type { FleetAuthDatabaseRoles } from '../postgres/fleet-auth/schema.js';

export interface FleetAuthSchemaAccessContract {
  schema: string;
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
  fleetAuthRoles: FleetAuthDatabaseRoles,
): FleetAuthSchemaAccessContract[] {
  const expected = [...expectedSchemas].map(assertValidPostgresSchemaName).sort();
  const protectedRoles = new Set(Object.values(fleetAuthRoles));
  const validated = contracts.map((contract, index) => {
    const schema = assertValidPostgresSchemaName(contract.schema);
    if (!Array.isArray(contract.runtimeRoles) || contract.runtimeRoles.length === 0) {
      throw new Error(`Fleet auth family restore schema access contract ${index} has no runtime roles`);
    }
    const runtimeRoles = contract.runtimeRoles.map((role, roleIndex) => (
      assertValidRoleName(role, `schema access contract ${index} runtimeRoles[${roleIndex}]`)
    ));
    if (new Set(runtimeRoles).size !== runtimeRoles.length) {
      throw new Error(`Fleet auth family restore schema access contract ${index} repeats a runtime role`);
    }
    const protectedRole = runtimeRoles.find(role => protectedRoles.has(role));
    if (protectedRole) {
      throw new Error(
        `Fleet auth family restore refuses to map protected fleet_auth role ${protectedRole} to a tenant schema`,
      );
    }
    return { schema, runtimeRoles: [...runtimeRoles].sort() };
  });
  const actual = validated.map(contract => contract.schema).sort();
  if (new Set(actual).size !== actual.length || JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('Fleet auth family restore schema access mapping does not exactly match the dump family');
  }
  return validated.sort((left, right) => left.schema.localeCompare(right.schema));
}

async function assertMappedRolesAreSafe(
  client: PoolClient,
  contracts: readonly FleetAuthSchemaAccessContract[],
  expectedOwner: string,
): Promise<void> {
  const runtimeRoles = [...new Set(contracts.flatMap(contract => contract.runtimeRoles))].sort();
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
  `, [runtimeRoles]);
  if (JSON.stringify(result.rows.map(row => row.rolname)) !== JSON.stringify(runtimeRoles)) {
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
  `, [runtimeRoles]);
  if ((memberships.rows.at(0)?.edge_count ?? 0) > 0) {
    throw new Error('Fleet auth family restore runtime roles must not participate in role memberships');
  }
  const owner = await client.query<{ current_user: string }>('SELECT current_user');
  if (owner.rows.at(0)?.current_user !== expectedOwner) {
    throw new Error(`Fleet auth family restore must authenticate as PostgreSQL role ${expectedOwner}`);
  }
}

export async function assertFleetAuthSchemaAccessTargets(options: {
  databaseUrl: string;
  contracts: readonly FleetAuthSchemaAccessContract[];
  ownerRole: string;
}): Promise<void> {
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-schema-access-preflight',
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      await assertMappedRolesAreSafe(client, options.contracts, options.ownerRole);
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

export async function applyFleetAuthSchemaAccessContracts(options: {
  databaseUrl: string;
  contracts: readonly FleetAuthSchemaAccessContract[];
  ownerRole: string;
}): Promise<void> {
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-schema-access-restore',
    max: 1,
  });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await assertMappedRolesAreSafe(client, options.contracts, options.ownerRole);
    for (const contract of options.contracts) {
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
      `, [contract.schema, options.ownerRole]);
      const ownership = owners.rows.at(0);
      if (!ownership || ownership.schema_owner !== options.ownerRole
        || ownership.foreign_relation_owner_count > 0
        || ownership.foreign_routine_owner_count > 0) {
        throw new Error(
          `Fleet auth family restore schema ${contract.schema} is not owned exactly by ${options.ownerRole}: `
          + `schema=${ownership?.schema_owner ?? 'missing'}, `
          + `foreignRelations=${ownership?.foreign_relation_owner_count ?? 0}, `
          + `foreignRoutines=${ownership?.foreign_routine_owner_count ?? 0}`,
        );
      }
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${grantees}`);
      await client.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${schema} TO ${grantees}`);
      await client.query(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${schema} TO ${grantees}`);
      await client.query(`GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA ${schema} TO ${grantees}`);
      const allowedGrantees = [options.ownerRole, ...contract.runtimeRoles];
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
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
