import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import {
  POSTGRES_EXTENSION_SCHEMA_NAME,
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  quotePostgresRoleName,
  quotePostgresSchemaName,
  withPostgresClient,
} from '../postgres.js';

const TENANCY_LOCK_CLASS = 0x5053464e;
const SHARD_SCHEMA_DIGEST_LENGTH = 40;
const SHARD_SCHEMA_PARENT_PREFIX_LENGTH = 16;
const TENANT_ROLE_DIGEST_LENGTH = 24;

function digest(value: string, length: number): string {
  return createHash('sha256').update(value, 'utf8').digest('hex').slice(0, length);
}

/**
 * Derive the only accepted schema for an ephemeral shard.
 *
 * PostgreSQL identifiers are limited to 63 bytes. The readable parent prefix
 * is therefore bounded, while a 160-bit digest binds the full parent companion
 * identity, configured parent schema, and full shard identity without lossy
 * character replacement.
 */
export function derivePostgresShardSchema(input: {
  parentCompanionId: CompanionId;
  parentSchema: string;
  shardId: string;
}): string {
  const parentSchema = assertValidPostgresSchemaName(input.parentSchema);
  const shardId = input.shardId.trim();
  if (!shardId) {
    throw new Error('PostgreSQL shard schema derivation requires a non-empty shard id');
  }
  const parentPrefix = parentSchema.slice(0, SHARD_SCHEMA_PARENT_PREFIX_LENGTH);
  const binding = JSON.stringify({
    parentCompanionId: input.parentCompanionId,
    parentSchema,
    shardId,
  });
  return assertValidPostgresSchemaName(
    `${parentPrefix}_shard_${digest(binding, SHARD_SCHEMA_DIGEST_LENGTH)}`,
  );
}

/** Deterministic least-privilege role name for a tenant or shard schema. */
export function derivePostgresTenantRole(schemaName: string): string {
  const schema = assertValidPostgresSchemaName(schemaName);
  const readable = schema.slice(0, 30);
  return assertValidPostgresRoleName(
    `psfn_${readable}_${digest(schema, TENANT_ROLE_DIGEST_LENGTH)}`,
  );
}

export interface PostgresTenantAccessPlan {
  schema: string;
  role: string;
  extensionSchema: typeof POSTGRES_EXTENSION_SCHEMA_NAME;
  searchPath: string;
  approvedSharedSchema?: string;
  approvedSharedAccess?: 'read' | 'read_write';
}

/** Pure deployment plan; callers may render/audit it without opening Postgres. */
export function planPostgresTenantAccess(input: {
  schema: string;
  role?: string;
  approvedSharedSchema?: string;
  approvedSharedAccess?: 'read' | 'read_write';
}): PostgresTenantAccessPlan {
  const schema = assertValidPostgresSchemaName(input.schema);
  const role = input.role === undefined
    ? derivePostgresTenantRole(schema)
    : assertValidPostgresRoleName(input.role);
  const approvedSharedSchema = input.approvedSharedSchema === undefined
    ? undefined
    : assertValidPostgresSchemaName(input.approvedSharedSchema);
  if ((approvedSharedSchema === undefined) !== (input.approvedSharedAccess === undefined)) {
    throw new Error('Approved shared Postgres access requires both a schema and an access mode');
  }
  return {
    schema,
    role,
    extensionSchema: POSTGRES_EXTENSION_SCHEMA_NAME,
    searchPath: `${schema},${POSTGRES_EXTENSION_SCHEMA_NAME}`,
    ...(approvedSharedSchema ? { approvedSharedSchema } : {}),
    ...(input.approvedSharedAccess ? { approvedSharedAccess: input.approvedSharedAccess } : {}),
  };
}

export interface ProvisionPostgresTenantAccessOptions {
  plan: PostgresTenantAccessPlan;
  /** Refuse to adopt or repair any pre-existing role or schema. */
  requireAbsent?: boolean;
  /** Existing login role that may SET ROLE to the tenant role. */
  runtimeLoginRole?: string;
  /** Extensions explicitly relocated out of public by this operator-only step. */
  relocateExtensions?: readonly string[];
}

/** Runtime preflight only; it never creates, grants, relocates, or repairs. */
export async function assertPostgresTenantAccessProvisioned(
  pool: Pool,
  planInput: PostgresTenantAccessPlan,
): Promise<void> {
  const plan = planPostgresTenantAccess(planInput);
  const result = await pool.query<{
    schema_owner: string | null;
    role_exists: boolean;
    extension_schema_exists: boolean;
    vector_extension_schema: string | null;
    login_is_member: boolean;
  }>(`
    SELECT
      (SELECT owner.rolname
       FROM pg_namespace namespace
       JOIN pg_roles owner ON owner.oid = namespace.nspowner
       WHERE namespace.nspname = $1) AS schema_owner,
      EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists,
      to_regnamespace($3) IS NOT NULL AS extension_schema_exists,
      (SELECT namespace.nspname
       FROM pg_extension extension
       JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
       WHERE extension.extname = 'vector') AS vector_extension_schema,
      CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2)
        THEN pg_has_role(current_user, $2, 'MEMBER')
        ELSE FALSE
      END AS login_is_member
  `, [plan.schema, plan.role, plan.extensionSchema]);
  const state = result.rows.at(0);
  if (!state
    || state.schema_owner !== plan.role
    || state.role_exists !== true
    || state.extension_schema_exists !== true
    || state.vector_extension_schema !== plan.extensionSchema
    || state.login_is_member !== true) {
    throw new Error(
      `PostgreSQL tenant boundary for ${plan.schema} is not explicitly provisioned`,
    );
  }
}

/**
 * Explicit deployment-time provisioning. Runtime startup never invokes this.
 * Every mutation is one advisory-locked transaction, so a failed provision
 * either commits the complete role/schema boundary or leaves it untouched.
 */
export async function provisionPostgresTenantAccess(
  pool: Pool,
  options: ProvisionPostgresTenantAccessOptions,
): Promise<PostgresTenantAccessPlan> {
  const plan = planPostgresTenantAccess(options.plan);
  const schema = quotePostgresSchemaName(plan.schema);
  const role = quotePostgresRoleName(plan.role);
  const extensionSchema = quotePostgresSchemaName(plan.extensionSchema);
  const runtimeLoginRole = options.runtimeLoginRole === undefined
    ? undefined
    : assertValidPostgresRoleName(options.runtimeLoginRole);
  const relocateExtensions = [...new Set(options.relocateExtensions ?? [])]
    .map(name => assertValidPostgresSchemaName(name))
    .sort((left, right) => left.localeCompare(right));

  await withPostgresClient(pool, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2)::integer)',
      [TENANCY_LOCK_CLASS, 'extensions'],
    );
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2)::integer)',
      [TENANCY_LOCK_CLASS, `tenant:${plan.schema}`],
    );
    if (options.requireAbsent === true) {
      const existing = await client.query<{
        role_exists: boolean;
        schema_exists: boolean;
      }>(`
        SELECT
          to_regnamespace($1) IS NOT NULL AS schema_exists,
          EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists
      `, [plan.schema, plan.role]);
      if (existing.rows[0]?.schema_exists === true || existing.rows[0]?.role_exists === true) {
        throw new Error(
          `PostgreSQL tenant ${plan.schema} must be absent before disposable provisioning`,
        );
      }
    }
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${extensionSchema}`);

    for (const extension of relocateExtensions) {
      const installed = await client.query<{ schema_name: string }>(`
        SELECT namespace.nspname AS schema_name
        FROM pg_extension extension
        JOIN pg_namespace namespace ON namespace.oid = extension.extnamespace
        WHERE extension.extname = $1
      `, [extension]);
      const currentSchema = installed.rows[0]?.schema_name;
      if (!currentSchema) {
        await client.query(
          `CREATE EXTENSION ${quotePostgresSchemaName(extension)} WITH SCHEMA ${extensionSchema}`,
        );
      } else if (currentSchema !== plan.extensionSchema) {
        await client.query(
          `ALTER EXTENSION ${quotePostgresSchemaName(extension)} SET SCHEMA ${extensionSchema}`,
        );
      }
    }

    const roleExists = await client.query<{ exists: boolean }>(
      'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
      [plan.role],
    );
    if (roleExists.rows[0]?.exists !== true) {
      await client.query(`CREATE ROLE ${role} NOLOGIN`);
    }
    await client.query(
      `ALTER ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${schema} AUTHORIZATION ${role}`);
    await client.query(`ALTER SCHEMA ${schema} OWNER TO ${role}`);
    const ownershipStatements = await client.query<{ statement: string }>(`
      SELECT format(
        'ALTER %s %I.%I OWNER TO %I',
        CASE object.relkind
          WHEN 'r' THEN 'TABLE'
          WHEN 'p' THEN 'TABLE'
          WHEN 'v' THEN 'VIEW'
          WHEN 'm' THEN 'MATERIALIZED VIEW'
          WHEN 'S' THEN 'SEQUENCE'
          WHEN 'f' THEN 'FOREIGN TABLE'
        END,
        namespace.nspname,
        object.relname,
        $2::text
      ) AS statement
      FROM pg_class object
      JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = $1
        AND object.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
        AND (object.relkind <> 'S' OR NOT EXISTS (
          SELECT 1
          FROM pg_depend dependency
          WHERE dependency.classid = 'pg_class'::regclass
            AND dependency.objid = object.oid
            AND dependency.deptype IN ('a', 'i')
        ))
      UNION ALL
      SELECT format(
        'ALTER %s %I.%I OWNER TO %I',
        CASE type.typtype WHEN 'd' THEN 'DOMAIN' ELSE 'TYPE' END,
        namespace.nspname,
        type.typname,
        $2::text
      ) AS statement
      FROM pg_type type
      JOIN pg_namespace namespace ON namespace.oid = type.typnamespace
      WHERE namespace.nspname = $1
        AND type.typrelid = 0
        AND type.typelem = 0
      UNION ALL
      SELECT format(
        'ALTER %s %I.%I(%s) OWNER TO %I',
        CASE procedure.prokind WHEN 'p' THEN 'PROCEDURE' ELSE 'FUNCTION' END,
        namespace.nspname,
        procedure.proname,
        pg_get_function_identity_arguments(procedure.oid),
        $2::text
      ) AS statement
      FROM pg_proc procedure
      JOIN pg_namespace namespace ON namespace.oid = procedure.pronamespace
      WHERE namespace.nspname = $1
      ORDER BY statement
    `, [plan.schema, plan.role]);
    for (const { statement } of ownershipStatements.rows) {
      await client.query(statement);
    }
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
    await client.query(`GRANT USAGE, CREATE ON SCHEMA ${schema} TO ${role}`);
    await client.query(`GRANT USAGE ON SCHEMA ${extensionSchema} TO ${role}`);

    if (plan.approvedSharedSchema && plan.approvedSharedAccess) {
      const shared = quotePostgresSchemaName(plan.approvedSharedSchema);
      await client.query(`GRANT USAGE ON SCHEMA ${shared} TO ${role}`);
      await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${shared} TO ${role}`);
      await client.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA ${shared} TO ${role}`);
      if (plan.approvedSharedAccess === 'read_write') {
        await client.query(`GRANT INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${shared} TO ${role}`);
        await client.query(`GRANT UPDATE ON ALL SEQUENCES IN SCHEMA ${shared} TO ${role}`);
      }
    }

    if (runtimeLoginRole && runtimeLoginRole !== plan.role) {
      await client.query(
        `GRANT ${role} TO ${quotePostgresRoleName(runtimeLoginRole)}`,
      );
    }
  });
  return plan;
}

export interface PostgresTenantCleanupEvidence {
  schema: string;
  role: string;
  droppedObjectCount: number;
  dropped: true;
}

/**
 * Explicit cleanup for a disposable tenant boundary.
 *
 * The caller must provide the same validated access plan used to provision the
 * tenant. Cleanup refuses a schema whose owner drifted or unexpected role
 * memberships. It revokes only grants created by provisioning and relies on a
 * restrictive DROP ROLE to reject every unknown dependency class. The whole
 * operation is transactional, so a rejected role drop restores the schema and
 * known grants instead of broadening cleanup with DROP OWNED.
 */
export async function dropPostgresTenantAccess(input: {
  pool: Pool;
  plan: PostgresTenantAccessPlan;
  runtimeLoginRole?: string;
  dropRole?: boolean;
}): Promise<PostgresTenantCleanupEvidence> {
  const plan = planPostgresTenantAccess(input.plan);
  const schema = quotePostgresSchemaName(plan.schema);
  const role = quotePostgresRoleName(plan.role);
  const extensionSchema = quotePostgresSchemaName(plan.extensionSchema);
  const runtimeLoginRole = input.runtimeLoginRole === undefined
    ? undefined
    : assertValidPostgresRoleName(input.runtimeLoginRole);
  let droppedObjectCount = 0;
  await withPostgresClient(input.pool, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2)::integer)',
      [TENANCY_LOCK_CLASS, `tenant:${plan.schema}`],
    );
    const tenantState = await client.query<{
      role_exists: boolean;
      schema_owner: string | null;
    }>(`
      SELECT
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists,
        (SELECT owner.rolname
         FROM pg_namespace namespace
         JOIN pg_roles owner ON owner.oid = namespace.nspowner
         WHERE namespace.nspname = $1) AS schema_owner
    `, [plan.schema, plan.role]);
    const state = tenantState.rows.at(0);
    if (!state) {
      throw new Error(`Could not inspect PostgreSQL tenant ${plan.schema} before cleanup`);
    }
    if (state.schema_owner !== null && state.schema_owner !== plan.role) {
      throw new Error(
        `Refusing to drop PostgreSQL tenant ${plan.schema}: schema owner is not ${plan.role}`,
      );
    }
    if (state.schema_owner === plan.role && state.role_exists !== true) {
      throw new Error(
        `Refusing to drop PostgreSQL tenant ${plan.schema}: owner role ${plan.role} is missing`,
      );
    }

    const objects = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_class object
      JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = $1
    `, [plan.schema]);
    droppedObjectCount = Number(objects.rows[0]?.count ?? '0');

    if (input.dropRole === true && state.role_exists === true) {
      const memberships = await client.query<{ grantee: string }>(`
        SELECT grantee.rolname AS grantee
        FROM pg_auth_members membership
        JOIN pg_roles granted ON granted.oid = membership.roleid
        JOIN pg_roles grantee ON grantee.oid = membership.member
        WHERE granted.rolname = $1
        ORDER BY grantee.rolname
      `, [plan.role]);
      const unexpectedMemberships = memberships.rows
        .map(entry => entry.grantee)
        .filter(grantee => grantee !== runtimeLoginRole);
      if (unexpectedMemberships.length > 0) {
        throw new Error(
          `Refusing to drop PostgreSQL tenant role ${plan.role}: unexpected members `
          + unexpectedMemberships.join(', '),
        );
      }
    }

    await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    if (input.dropRole === true && state.role_exists === true) {
      if (runtimeLoginRole && runtimeLoginRole !== plan.role) {
        await client.query(
          `REVOKE ${role} FROM ${quotePostgresRoleName(runtimeLoginRole)}`,
        );
      }
      await client.query(`REVOKE USAGE ON SCHEMA ${extensionSchema} FROM ${role}`);
      if (plan.approvedSharedSchema) {
        const shared = quotePostgresSchemaName(plan.approvedSharedSchema);
        await client.query(
          `REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA ${shared} FROM ${role}`,
        );
        await client.query(
          `REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA ${shared} FROM ${role}`,
        );
        await client.query(`REVOKE USAGE ON SCHEMA ${shared} FROM ${role}`);
      }
      await client.query(`DROP ROLE ${role}`);
    }

    const remaining = await client.query<{
      role_exists: boolean;
      schema_exists: boolean;
    }>(`
      SELECT
        to_regnamespace($1) IS NOT NULL AS schema_exists,
        EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $2) AS role_exists
    `, [plan.schema, plan.role]);
    if (remaining.rows[0]?.schema_exists === true
      || (input.dropRole === true && remaining.rows[0]?.role_exists === true)) {
      throw new Error(`PostgreSQL tenant ${plan.schema} remained after cleanup`);
    }
  });
  return {
    schema: plan.schema,
    role: plan.role,
    droppedObjectCount,
    dropped: true,
  };
}

export interface PostgresShardCleanupEvidence {
  schema: string;
  role: string;
  droppedObjectCount: number;
  dropped: true;
}

/** Explicit, identity-bound cleanup for an ephemeral shard schema. */
export async function dropPostgresShardSchema(input: {
  pool: Pool;
  parentCompanionId: CompanionId;
  parentSchema: string;
  shardId: string;
  schema: string;
  dropRole?: boolean;
}): Promise<PostgresShardCleanupEvidence> {
  const expected = derivePostgresShardSchema(input);
  const schema = assertValidPostgresSchemaName(input.schema);
  if (schema !== expected) {
    throw new Error('Refusing to clean up a shard schema that does not match its lineage');
  }
  const roleName = derivePostgresTenantRole(schema);
  const quotedSchema = quotePostgresSchemaName(schema);
  const quotedRole = quotePostgresRoleName(roleName);
  let droppedObjectCount = 0;
  await withPostgresClient(input.pool, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock($1::integer, hashtext($2)::integer)',
      [TENANCY_LOCK_CLASS, `tenant:${schema}`],
    );
    const objects = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM pg_class object
      JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
      WHERE namespace.nspname = $1
    `, [schema]);
    droppedObjectCount = Number(objects.rows[0]?.count ?? '0');
    const roleExists = input.dropRole === true
      ? (await client.query<{ exists: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
          [roleName],
        )).rows[0]?.exists === true
      : false;
    if (roleExists) {
      const foreignOwnership = await client.query<{ count: string }>(`
        SELECT (
          (SELECT COUNT(*) FROM pg_namespace WHERE nspowner = role.oid AND nspname <> $2)
          + (SELECT COUNT(*)
             FROM pg_class object
             JOIN pg_namespace namespace ON namespace.oid = object.relnamespace
             WHERE object.relowner = role.oid
               AND namespace.nspname <> $2
               -- PostgreSQL owns a table's internal TOAST relations with the
               -- table owner. DROP SCHEMA removes those dependencies too;
               -- they are not independently owned cross-tenant objects.
               AND namespace.nspname NOT LIKE 'pg_toast%')
        )::text AS count
        FROM pg_roles role
        WHERE role.rolname = $1
      `, [roleName, schema]);
      if (Number(foreignOwnership.rows[0]?.count ?? '0') !== 0) {
        throw new Error('Refusing to drop a shard role that owns objects outside its shard schema');
      }
    }
    await client.query(`DROP SCHEMA IF EXISTS ${quotedSchema} CASCADE`);
    if (roleExists) {
      await client.query(`DROP OWNED BY ${quotedRole}`);
      await client.query(`DROP ROLE IF EXISTS ${quotedRole}`);
    }
  });
  return { schema, role: roleName, droppedObjectCount, dropped: true };
}
