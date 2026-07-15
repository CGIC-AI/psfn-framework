import type { Pool } from 'pg';
import {
  assertValidPostgresSchemaName,
  createPostgresPool,
  withPostgresClient,
} from '../postgres.js';
import {
  POSTGRES_SHARED_BASE_MIGRATION_VERSIONS,
  POSTGRES_SHARED_MIGRATIONS,
  POSTGRES_SHARED_WIKI_MIGRATIONS,
  SHARED_SCHEMA_NAME,
} from './migrations.js';

/**
 * Cluster-wide advisory lock key serializing shared-schema provisioning.
 *
 * `CREATE SCHEMA IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS` are *not* safe
 * under a concurrent first-creation race: two sessions can both observe the
 * object as missing and one then fails with a duplicate-key error on the
 * catalog (pg_namespace / pg_type). Multiple explicit migration or maintenance
 * callers can race, so provisioning takes a transaction-scoped advisory lock
 * and the losers simply wait and then no-op through the IF NOT EXISTS chain.
 *
 * Key split: classid 0x5053464e (a fixed project tag), objid 1 (shared-schema
 * provisioning).
 */
const SHARED_SCHEMA_ADVISORY_LOCK_CLASS = 0x5053464e;
const SHARED_SCHEMA_ADVISORY_LOCK_ID = 1;

/**
 * Provision the shared world schema and run its migration chain.
 *
 * This is the single provisioning path for the `shared` schema that holds
 * cross-companion world data (sprint 10 W2/W5a). It creates the schema if
 * missing and runs {@link POSTGRES_SHARED_MIGRATIONS} inside it, all within
 * one transaction guarded by a transaction-scoped advisory lock, so it is
 * idempotent and safe under concurrent dedicated migration callers. Ordinary
 * companion runtime credentials must never call this DDL path.
 *
 * The caller owns the pool. The transaction pins its own `SET LOCAL
 * search_path` to the shared schema, so the unqualified migration statements
 * always resolve into `shared` — regardless of whether the pool itself was
 * created with `{ schema: SHARED_SCHEMA_NAME }` — and the pool's own
 * search_path is untouched after commit.
 */
export async function ensureSharedSchema(pool: Pool): Promise<void> {
  await provisionSharedSchema(pool, [POSTGRES_SHARED_MIGRATIONS]);
}

/**
 * Provision the shared schema INCLUDING the shared-world wiki chunk projection
 * (ledger version 3, sprint 10 s10f9). The wiki statement list requires the
 * pgvector extension, so it is a separate chain layered on top of the base
 * shared chain: pgvector-free shared consumers (companion presence) keep
 * calling {@link ensureSharedSchema}, while every shared-wiki surface calls
 * this. Runs base + wiki chains in one transaction under the SAME advisory
 * lock, so wiki provisioning serializes with presence provisioning and is
 * idempotent under N concurrent callers. Fails closed (throws) when pgvector
 * is unavailable — a shared-wiki surface must never silently come up without
 * its projection table.
 */
export async function ensureSharedWikiSchema(pool: Pool): Promise<void> {
  await provisionSharedSchema(pool, [POSTGRES_SHARED_MIGRATIONS, POSTGRES_SHARED_WIKI_MIGRATIONS]);
}

async function provisionSharedSchema(
  pool: Pool,
  chains: ReadonlyArray<readonly string[]>,
): Promise<void> {
  const schema = assertValidPostgresSchemaName(SHARED_SCHEMA_NAME);
  await withPostgresClient(pool, async (client) => {
    await client.query(
      'SELECT pg_advisory_xact_lock($1, $2)',
      [SHARED_SCHEMA_ADVISORY_LOCK_CLASS, SHARED_SCHEMA_ADVISORY_LOCK_ID],
    );
    // The identifier is already restricted to a safe character set; the quotes
    // are belt-and-suspenders so reserved words would still be legal.
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    // Transaction-local pin: migration statements below are unqualified and
    // MUST land in the shared schema even on a pool without a pinned
    // search_path (`public` is retained for shared extension types).
    await client.query(`SET LOCAL search_path TO "${schema}", public`);
    for (const chain of chains) {
      for (const statement of chain) {
        await client.query(statement);
      }
    }
  });
}

/**
 * Convenience wrapper that opens a dedicated, schema-pinned pool for the shared
 * world schema, runs its migration chain, and closes the pool.
 *
 * Intended for the one-shot gateway migration authority and explicit
 * maintenance callers. Ordinary companion runtimes are DML-only.
 */
export async function bootstrapSharedSchema(databaseUrl: string): Promise<void> {
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-shared-schema',
    allowExitOnIdle: true,
    max: 1,
    schema: SHARED_SCHEMA_NAME,
  });
  try {
    await ensureSharedSchema(pool);
  } finally {
    await pool.end();
  }
}

/**
 * Read-only startup check for one ordinary companion credential. Shared DDL is
 * completed by the gateway's dedicated migration authority before agents are
 * spawned; an agent proves the resulting least-privilege boundary here before
 * opening any shared store.
 */
export async function assertSharedSchemaRuntimeAuthority(
  databaseUrl: string,
  options: {
    ownSchema: string;
    companionSchemas: readonly string[];
  },
): Promise<void> {
  const ownSchema = assertValidPostgresSchemaName(options.ownSchema);
  const companionSchemas = options.companionSchemas.map(assertValidPostgresSchemaName);
  if (!companionSchemas.includes(ownSchema)
    || new Set(companionSchemas).size !== companionSchemas.length) {
    throw new Error('Shared schema runtime authority requires one exact fleet schema identity');
  }
  const pool = createPostgresPool(databaseUrl, {
    applicationName: 'psfn-shared-schema-runtime-preflight',
    allowExitOnIdle: true,
    max: 1,
    schema: SHARED_SCHEMA_NAME,
  });
  try {
    await withPostgresClient(pool, async (client) => {
      const role = await client.query<{
        current_user: string;
        rolcanlogin: boolean;
        rolinherit: boolean;
        rolsuper: boolean;
        rolcreaterole: boolean;
        rolcreatedb: boolean;
        rolreplication: boolean;
        rolbypassrls: boolean;
      }>(`
        SELECT current_user, role.rolcanlogin, role.rolinherit, role.rolsuper,
               role.rolcreaterole, role.rolcreatedb, role.rolreplication,
               role.rolbypassrls
        FROM pg_roles AS role
        WHERE role.rolname = current_user
      `);
      const current = role.rows.at(0);
      if (!current || !current.rolcanlogin || current.rolinherit || current.rolsuper
        || current.rolcreaterole || current.rolcreatedb
        || current.rolreplication || current.rolbypassrls) {
        throw new Error('Shared schema runtime credential is not a least-privilege LOGIN role');
      }
      const memberships = await client.query<{ edge_count: number }>(`
        SELECT COUNT(*)::integer AS edge_count
        FROM pg_auth_members AS membership
        JOIN pg_roles AS granted_role ON granted_role.oid = membership.roleid
        JOIN pg_roles AS member_role ON member_role.oid = membership.member
        WHERE granted_role.rolname = current_user OR member_role.rolname = current_user
      `);
      if ((memberships.rows.at(0)?.edge_count ?? 0) > 0) {
        throw new Error('Shared schema runtime role must not participate in role memberships');
      }

      const schemaPrivileges = await client.query<{
        schema_name: string;
        owner_role: string;
        schema_usage: boolean;
        schema_create: boolean;
      }>(`
        SELECT namespace.nspname AS schema_name,
               owner.rolname AS owner_role,
               has_schema_privilege(current_user, namespace.oid, 'USAGE') AS schema_usage,
               has_schema_privilege(current_user, namespace.oid, 'CREATE') AS schema_create
        FROM pg_namespace AS namespace
        JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
        WHERE namespace.nspname = ANY($1::text[])
        ORDER BY namespace.nspname
      `, [[...companionSchemas, SHARED_SCHEMA_NAME]]);
      if (schemaPrivileges.rows.length !== companionSchemas.length + 1) {
        throw new Error('Shared schema runtime authority found an incomplete fleet schema set');
      }
      for (const schema of schemaPrivileges.rows) {
        if (schema.schema_name === ownSchema) {
          if (schema.owner_role !== current.current_user
            || !schema.schema_usage || !schema.schema_create) {
            throw new Error('Shared schema runtime credential does not own its companion schema');
          }
        } else if (schema.schema_name === SHARED_SCHEMA_NAME) {
          if (schema.owner_role === current.current_user
            || !schema.schema_usage || schema.schema_create) {
            throw new Error('Shared schema runtime credential has invalid shared-schema authority');
          }
        } else if (schema.schema_usage || schema.schema_create) {
          throw new Error('Shared schema runtime credential can access a sibling companion schema');
        }
      }

      const tableAccess = await client.query<{
        relation_name: string;
        required_dml: boolean;
        forbidden_authority: boolean;
      }>(`
        SELECT relation.relname AS relation_name,
               CASE WHEN relation.relname = 'shared_schema_migrations'
                 THEN has_table_privilege(current_user, relation.oid, 'SELECT')
                 ELSE has_table_privilege(
                   current_user,
                   relation.oid,
                   'SELECT,INSERT,UPDATE,DELETE'
                 )
               END AS required_dml,
               CASE WHEN relation.relname = 'shared_schema_migrations'
                 THEN has_table_privilege(current_user, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                 ELSE has_table_privilege(current_user, relation.oid, 'TRUNCATE,REFERENCES,TRIGGER')
               END AS forbidden_authority
        FROM pg_class AS relation
        JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
        WHERE namespace.nspname = $1 AND relation.relkind IN ('r', 'p')
        ORDER BY relation.relname
      `, [SHARED_SCHEMA_NAME]);
      if (tableAccess.rows.length === 0
        || tableAccess.rows.some(row => !row.required_dml || row.forbidden_authority)) {
        throw new Error('Shared schema runtime credential does not have exact shared DML privileges');
      }
      const ledger = await client.query<{ versions: number[] }>(`
        SELECT ARRAY_AGG(version ORDER BY version)::integer[] AS versions
        FROM shared_schema_migrations
      `);
      const versions = ledger.rows.at(0)?.versions ?? [];
      for (const required of POSTGRES_SHARED_BASE_MIGRATION_VERSIONS) {
        if (!versions.includes(required)) {
          throw new Error(`Shared schema runtime is missing required migration ${required}`);
        }
      }

      const fleetAuthAccess = await client.query<{
        schema_usage: boolean;
        relation_access: boolean;
      }>(`
        SELECT
          CASE WHEN to_regnamespace('fleet_auth') IS NULL THEN FALSE
               ELSE has_schema_privilege(current_user, 'fleet_auth', 'USAGE') END AS schema_usage,
          EXISTS (
            SELECT 1
            FROM pg_class AS relation
            JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'fleet_auth'
              AND has_table_privilege(
                current_user,
                relation.oid,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
              )
          ) AS relation_access
      `);
      if (fleetAuthAccess.rows.at(0)?.schema_usage
        || fleetAuthAccess.rows.at(0)?.relation_access) {
        throw new Error('Shared schema runtime credential has forbidden fleet_auth access');
      }
    });
  } finally {
    await pool.end();
  }
}
