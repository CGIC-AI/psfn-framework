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
import { assertPostgresRolesAreLeastPrivilege } from '../postgres/role-posture.js';
import { grantBackupReadAccessToTenantSchema } from '../postgres/backup-schema-access.js';
import { grantWelfareVerifierReadAccessToTenantSchema } from '../postgres/welfare-verifier-access.js';

export interface FleetAuthSchemaAccessContract {
  kind: 'companion' | 'shared';
  schema: string;
  ownerRole: string;
  runtimeRoles: readonly string[];
}

export interface SharedSchemaRoleBoundary {
  sharedMigration: string;
  protectedRoles?: readonly string[];
}

type SchemaAccessRoleBoundary = FleetAuthFamilyDatabaseRoles | SharedSchemaRoleBoundary;

export interface FleetAuthWelfareVerifierSchemaAccess {
  role: string;
  databaseUrl: string;
}

function protectedRolesForBoundary(boundary: SchemaAccessRoleBoundary): string[] {
  if ('runtime' in boundary) {
    return [boundary.runtime, boundary.migration, boundary.backupRestore];
  }
  return [...(boundary.protectedRoles ?? [])];
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
  fleetAuthRoles: SchemaAccessRoleBoundary,
): FleetAuthSchemaAccessContract[] {
  const expected = [...expectedSchemas].map(assertValidPostgresSchemaName).sort();
  const protectedFleetAuthRoles = new Set([
    ...protectedRolesForBoundary(fleetAuthRoles),
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
  const sharedContract = shared[0]!;
  const companionRuntimeRoles = companions.map((contract, index) => {
    const runtimeRole = contract.runtimeRoles[0];
    if (contract.runtimeRoles.length !== 1 || !runtimeRole || contract.ownerRole !== runtimeRole) {
      throw new Error(
        `Fleet auth family restore companion schema access contract ${index} must have one matching runtime owner`,
      );
    }
    return runtimeRole;
  });
  if (new Set(companionRuntimeRoles).size !== companionRuntimeRoles.length) {
    throw new Error('Fleet auth family restore refuses to map one companion role across sibling schemas');
  }
  if (companions.some(contract => contract.ownerRole === fleetAuthRoles.sharedMigration)) {
    throw new Error('Fleet auth family restore shared migration role must not own a companion schema');
  }
  if (sharedContract.ownerRole !== fleetAuthRoles.sharedMigration) {
    throw new Error(
      `Fleet auth family restore shared schema must be owned by configured migration role ${fleetAuthRoles.sharedMigration}`,
    );
  }
  const expectedSharedRoles = [...companionRuntimeRoles].sort();
  if (JSON.stringify(sharedContract.runtimeRoles) !== JSON.stringify(expectedSharedRoles)) {
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
  await assertPostgresRolesAreLeastPrivilege(
    client,
    mappedRoles,
    'Fleet auth family restore mapped authority',
  );
  const owner = await client.query<{ current_user: string }>('SELECT current_user');
  if (owner.rows.at(0)?.current_user !== expectedOwner) {
    throw new Error(`Fleet auth family restore must authenticate as PostgreSQL role ${expectedOwner}`);
  }
}

async function assertSchemaIsolation(
  client: PoolClient,
  contracts: readonly FleetAuthSchemaAccessContract[],
  welfareVerifierRole?: string,
): Promise<void> {
  const companionContracts = contracts.filter(contract => contract.kind === 'companion');
  const companionRoles = companionContracts.map((contract) => {
    const role = contract.runtimeRoles[0];
    if (!role) {
      throw new Error('Fleet auth schema access isolation companion contract is missing its runtime role');
    }
    return role;
  });
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
  if (welfareVerifierRole) {
    for (const contract of contracts) {
      await assertWelfareVerifierSchemaAccess(
        client,
        contract,
        welfareVerifierRole,
        true,
      );
    }
  }
}

interface WelfareVerifierPrivilegeRow {
  object_kind: 'schema' | 'relation' | 'column' | 'routine';
  object_name: string;
  privilege_type: string;
  is_grantable: boolean;
}

interface WelfareVerifierDefaultPrivilegeRow {
  owner_role: string;
  schema_name: string;
  object_type: string;
  grantee_role: string;
  privilege_type: string;
  is_grantable: boolean;
}

interface WelfareVerifierExecutableRoutineRow {
  routine_name: string;
  identity_arguments: string;
}

async function assertNoWelfareVerifierDefaultPrivileges(
  client: PoolClient,
  schema: string,
  welfareVerifierRole: string,
): Promise<void> {
  const defaults = await client.query<WelfareVerifierDefaultPrivilegeRow>(`
    SELECT owner.rolname AS owner_role,
           COALESCE(namespace.nspname, '*') AS schema_name,
           default_acl.defaclobjtype::text AS object_type,
           CASE WHEN acl.grantee = 0 THEN 'PUBLIC' ELSE grantee.rolname END AS grantee_role,
           acl.privilege_type,
           acl.is_grantable
    FROM pg_default_acl AS default_acl
    JOIN pg_roles AS owner ON owner.oid = default_acl.defaclrole
    LEFT JOIN pg_namespace AS namespace ON namespace.oid = default_acl.defaclnamespace
    CROSS JOIN LATERAL aclexplode(default_acl.defaclacl) AS acl
    LEFT JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE (default_acl.defaclnamespace = 0 OR namespace.nspname = $1)
      AND CASE
        WHEN acl.grantee = 0 THEN TRUE
        ELSE grantee.rolname = $2 OR pg_has_role($2, acl.grantee, 'MEMBER')
      END
    ORDER BY owner_role, schema_name, object_type, grantee_role,
             privilege_type, is_grantable
  `, [schema, welfareVerifierRole]);
  if (defaults.rows.length > 0) {
    throw new Error(
      `Fleet auth welfare verifier default privileges would widen schema access for ${schema}: `
      + JSON.stringify(defaults.rows),
    );
  }
}

async function assertWelfareVerifierSchemaAccess(
  client: PoolClient,
  contract: FleetAuthSchemaAccessContract,
  welfareVerifierRole: string,
  requireExact: boolean,
): Promise<void> {
  // A default ACL is latent authority: even if the currently restored objects
  // have the exact grants below, a later table/function/sequence creation could
  // silently widen this gateway-only reader. Reject schema-local and global
  // defaults granted directly, through PUBLIC, or through a membership target.
  // The surrounding role-posture guard separately rejects membership edges,
  // but this query keeps the ACL proof fail-closed when called independently.
  await assertNoWelfareVerifierDefaultPrivileges(
    client,
    contract.schema,
    welfareVerifierRole,
  );
  const privileges = await client.query<WelfareVerifierPrivilegeRow>(`
    SELECT 'schema'::text AS object_kind,
           namespace.nspname AS object_name,
           acl.privilege_type,
           acl.is_grantable
    FROM pg_namespace AS namespace
    CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
    JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = $1 AND grantee.rolname = $2
    UNION ALL
    SELECT 'relation'::text AS object_kind,
           relation.relname AS object_name,
           acl.privilege_type,
           acl.is_grantable
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
    JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = $1 AND grantee.rolname = $2
    UNION ALL
    SELECT 'column'::text AS object_kind,
           relation.relname || '.' || attribute.attname AS object_name,
           acl.privilege_type,
           acl.is_grantable
    FROM pg_attribute AS attribute
    JOIN pg_class AS relation ON relation.oid = attribute.attrelid
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    CROSS JOIN LATERAL aclexplode(attribute.attacl) AS acl
    JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = $1 AND grantee.rolname = $2
    UNION ALL
    SELECT 'routine'::text AS object_kind,
           routine.proname AS object_name,
           acl.privilege_type,
           acl.is_grantable
    FROM pg_proc AS routine
    JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
    CROSS JOIN LATERAL aclexplode(routine.proacl) AS acl
    JOIN pg_roles AS grantee ON grantee.oid = acl.grantee
    WHERE namespace.nspname = $1 AND grantee.rolname = $2
    ORDER BY object_kind, object_name, privilege_type, is_grantable
  `, [contract.schema, welfareVerifierRole]);
  const expected: WelfareVerifierPrivilegeRow[] = contract.kind === 'companion'
    ? [
        {
          object_kind: 'relation',
          object_name: 'agent_background_work_jobs',
          privilege_type: 'SELECT',
          is_grantable: false,
        },
        {
          object_kind: 'schema',
          object_name: contract.schema,
          privilege_type: 'USAGE',
          is_grantable: false,
        },
      ]
    : [];
  const expectedKeys = new Set(expected.map(row => JSON.stringify(row)));
  const unexpected = privileges.rows.filter(row => !expectedKeys.has(JSON.stringify(row)));
  const missing = requireExact
    ? expected.filter(row => !privileges.rows.some(actual => (
        JSON.stringify(actual) === JSON.stringify(row)
      )))
    : [];
  const executableRoutines = requireExact && contract.kind === 'companion'
    ? await client.query<WelfareVerifierExecutableRoutineRow>(`
        SELECT routine.proname AS routine_name,
               pg_get_function_identity_arguments(routine.oid) AS identity_arguments
        FROM pg_proc AS routine
        JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
        WHERE namespace.nspname = $1
          AND has_function_privilege($2, routine.oid, 'EXECUTE')
        ORDER BY routine.proname, pg_get_function_identity_arguments(routine.oid)
      `, [contract.schema, welfareVerifierRole])
    : { rows: [] };
  if (unexpected.length > 0 || missing.length > 0 || executableRoutines.rows.length > 0) {
    throw new Error(
      `Fleet auth welfare verifier schema access mismatch for ${contract.schema}: `
      + `unexpected=${JSON.stringify(unexpected)}, missing=${JSON.stringify(missing)}, `
      + `executableRoutines=${JSON.stringify(executableRoutines.rows)}`,
    );
  }
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
           CASE WHEN to_regnamespace('fleet_auth') IS NULL THEN FALSE
                ELSE has_schema_privilege(role_name, 'fleet_auth', 'USAGE') END AS schema_usage,
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
           CASE WHEN to_regnamespace(schema_name) IS NULL THEN FALSE
                ELSE has_schema_privilege($1, schema_name, 'USAGE') END AS schema_usage,
           CASE WHEN to_regnamespace(schema_name) IS NULL THEN FALSE
                ELSE has_schema_privilege($1, schema_name, 'CREATE') END AS schema_create,
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
        ...companionSchemas.map((schema, index) => {
          const ownerRole = companionRoles[index];
          if (!ownerRole) {
            throw new Error('Fleet auth schema access discovery missing companion schema owner');
          }
          return {
            kind: 'companion' as const,
            schema,
            ownerRole,
            runtimeRoles: [ownerRole],
          };
        }),
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
  welfareVerifier?: FleetAuthWelfareVerifierSchemaAccess;
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
          .map((contract) => {
            const role = contract.runtimeRoles[0];
            if (!role) {
              throw new Error('Fleet auth family restore companion contract is missing its runtime role');
            }
            return role;
          }),
      );
      const target = await client.query<{ database_name: string; system_identifier: string }>(`
        SELECT current_database() AS database_name,
               (pg_control_system()).system_identifier::text AS system_identifier
      `);
      const expectedTarget = target.rows.at(0);
      if (!expectedTarget) throw new Error('Fleet auth family restore could not identify its target database');
      if (options.welfareVerifier) {
        const credential = parseExactPostgresCredential(
          options.welfareVerifier.databaseUrl,
          'Fleet auth family restore welfare verifier credential',
        );
        const role = assertValidRoleName(options.welfareVerifier.role, 'welfare verifier role');
        if (credential.username !== role) {
          throw new Error(
            `Fleet auth family restore welfare verifier credential must authenticate as ${role}`,
          );
        }
        const mappedRoles = [...new Set(options.contracts.flatMap(contract => (
          [contract.ownerRole, ...contract.runtimeRoles]
        )))];
        if (mappedRoles.includes(role) || role === options.ownerRole) {
          throw new Error('Fleet auth family restore welfare verifier role must be a distinct authority');
        }
        const verifierPool = createPostgresPool(options.welfareVerifier.databaseUrl, {
          applicationName: 'fleet-auth-welfare-verifier-preflight',
          max: 1,
        });
        try {
          const verifierClient = await verifierPool.connect();
          try {
            await assertFleetAuthRolesAreSafe(verifierClient, [role], role);
            const actualTarget = await verifierClient.query<{
              database_name: string;
              system_identifier: string;
            }>(`
              SELECT current_database() AS database_name,
                     (pg_control_system()).system_identifier::text AS system_identifier
            `);
            if (JSON.stringify(actualTarget.rows.at(0)) !== JSON.stringify(expectedTarget)) {
              throw new Error('Fleet auth family restore welfare verifier credential targets another database');
            }
          } finally {
            verifierClient.release();
          }
        } finally {
          await verifierPool.end();
        }
      }
      for (const contract of options.contracts) {
        const ownerDatabaseUrl = options.ownerDatabaseUrls[contract.schema];
        if (!ownerDatabaseUrl) {
          throw new Error(`Fleet auth family restore owner credential missing for ${contract.schema}`);
        }
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
  backupRole?: string;
  welfareVerifierRole?: string;
}): Promise<void> {
  const backupRole = options.backupRole === undefined
    ? undefined
    : assertValidRoleName(options.backupRole, 'backupRole');
  const mappedRuntimeRoles = [...new Set(options.contracts.flatMap(
    contract => contract.runtimeRoles,
  ))].sort();
  const welfareVerifierRole = options.welfareVerifierRole === undefined
    ? undefined
    : assertValidRoleName(options.welfareVerifierRole, 'welfare verifier role');
  if (welfareVerifierRole && [
    ...mappedRuntimeRoles,
    ...options.contracts.map(contract => contract.ownerRole),
    ...(backupRole ? [backupRole] : []),
  ].includes(welfareVerifierRole)) {
    throw new Error('Fleet auth family restore welfare verifier role must be a distinct authority');
  }
  const mappedRuntimeGrantees = mappedRuntimeRoles.map(quoteIdentifier).join(', ');
  for (const contract of options.contracts) {
    const ownerDatabaseUrl = options.ownerDatabaseUrls[contract.schema];
    if (!ownerDatabaseUrl) {
      throw new Error(
        `Fleet auth family restore owner credential missing for ${contract.schema}`,
      );
    }
    const pool = createPostgresPool(ownerDatabaseUrl, {
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
      if (welfareVerifierRole) {
        await assertWelfareVerifierSchemaAccess(
          client,
          contract,
          welfareVerifierRole,
          false,
        );
      }
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
      if (welfareVerifierRole && contract.kind === 'companion') {
        // PostgreSQL implicitly grants PUBLIC EXECUTE on new routines when the
        // owning role has no explicit default ACL. A per-schema REVOKE cannot
        // subtract that global built-in default, so pin the companion owner's
        // global routine default. The family contract above proves that this
        // owner maps to exactly one companion schema and no sibling schema.
        await client.query(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${quoteIdentifier(contract.ownerRole)} `
          + 'REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC',
        );
      }
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${mappedRuntimeGrantees}`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${mappedRuntimeGrantees}`);
      await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${mappedRuntimeGrantees}`);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${mappedRuntimeGrantees}`);
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
      if (backupRole) {
        await grantBackupReadAccessToTenantSchema(client, {
          schema: contract.schema,
          ownerRole: contract.ownerRole,
          backupRole,
        });
      }
      if (welfareVerifierRole && contract.kind === 'companion') {
        const grant = await grantWelfareVerifierReadAccessToTenantSchema(client, {
          schema: contract.schema,
          verifierRole: welfareVerifierRole,
        });
        if (!grant.relationGranted) {
          throw new Error(
            `Fleet auth family restore schema ${contract.schema} is missing agent_background_work_jobs`,
          );
        }
      }
      if (welfareVerifierRole) {
        await assertWelfareVerifierSchemaAccess(
          client,
          contract,
          welfareVerifierRole,
          true,
        );
      }
      const allowedGrantees = [
        contract.ownerRole,
        ...(backupRole ? [backupRole] : []),
        ...contract.runtimeRoles,
        ...(welfareVerifierRole && contract.kind === 'companion'
          ? [welfareVerifierRole]
          : []),
      ];
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
          + unexpectedGrantees.rows.map(row => row.role_name).filter(Boolean).join(', '),
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
  welfareVerifierRole?: string;
}): Promise<void> {
  const pool = createPostgresPool(options.databaseUrl, {
    applicationName: 'fleet-auth-schema-access-verification',
    max: 1,
  });
  try {
    const client = await pool.connect();
    try {
      const welfareVerifierRole = options.welfareVerifierRole === undefined
        ? undefined
        : assertValidRoleName(options.welfareVerifierRole, 'welfare verifier role');
      await assertMappedRolesAreSafe(client, options.contracts, options.ownerRole);
      if (welfareVerifierRole) {
        await assertFleetAuthRolesAreSafe(client, [welfareVerifierRole], options.ownerRole);
      }
      await assertSchemaIsolation(client, options.contracts, welfareVerifierRole);
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
