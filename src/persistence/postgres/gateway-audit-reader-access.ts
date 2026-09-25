import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  createPostgresPool,
  quotePostgresRoleName,
  quotePostgresSchemaName,
  withPostgresClient,
} from '../postgres.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';
import type { Pool, PoolClient } from 'pg';
import { assertPostgresRolesAreLeastPrivilege } from './role-posture.js';

type PostgresQueryable = Pick<Pool | PoolClient, 'query'>;

/**
 * Least-privilege read-only access to the gateway-owned audit tables
 * (psfn-framework-jqg13). In a companion fleet the gateway audit and the fleet
 * spend ledger live in the gateway's (primary companion's) schema; audit and
 * test tooling (the shakedown harness on a follower run) needs to read them
 * without the primary tenant's read-write runtime credential.
 *
 * The role is declared in companions.json (`postgres.gatewayAuditReaderRole`)
 * and provisioned by the operator as a NOINHERIT LOGIN role with a finite
 * connection limit. Gateway startup proves that posture, resets the role's
 * access on the gateway schema to exactly USAGE plus SELECT on these tables,
 * and the exact-grantee proof then admits it on that schema only. Any grant it
 * holds on another schema still fails startup closed.
 */
const GATEWAY_AUDIT_READER_TABLES = ['gateway_audit', 'model_usage_events'] as const;

export interface GatewayAuditReaderGrant {
  /** The gateway (primary companion) schema that owns the audit tables. */
  schema: string;
  role: string;
}

function quoteKnownTable(schema: string, table: typeof GATEWAY_AUDIT_READER_TABLES[number]): string {
  return `${schema}."${table}"`;
}

/**
 * Reset the reader to exactly its read contract on the gateway schema. Tables
 * not created yet are skipped (no grant, so reads fail closed) and reported.
 * Returns the tables granted.
 */
export async function applyGatewayAuditReaderAccess(
  client: PostgresQueryable,
  grant: GatewayAuditReaderGrant,
): Promise<readonly string[]> {
  const schemaName = assertValidPostgresSchemaName(grant.schema);
  const roleName = assertValidPostgresRoleName(grant.role);
  await assertPostgresRolesAreLeastPrivilege(client, [roleName], 'Gateway audit reader');
  const schema = quotePostgresSchemaName(schemaName);
  const role = quotePostgresRoleName(roleName);
  await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
  await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
  await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${role}`);
  await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${role}`);
  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
  const present = await client.query<{ relname: string }>(`
    SELECT relation.relname
    FROM pg_class AS relation
    JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = $1
      AND relation.relname = ANY($2::text[])
      AND relation.relkind IN ('r', 'p')
    ORDER BY relation.relname
  `, [schemaName, [...GATEWAY_AUDIT_READER_TABLES]]);
  const granted: string[] = [];
  for (const table of GATEWAY_AUDIT_READER_TABLES) {
    if (!present.rows.some(row => row.relname === table)) continue;
    await client.query(`GRANT SELECT ON ${quoteKnownTable(schema, table)} TO ${role}`);
    granted.push(table);
  }
  return granted;
}

async function assertExactGatewayAuditReaderAccess(
  client: PostgresQueryable,
  schemaName: string,
  roleName: string,
): Promise<void> {
  const result = await client.query<{
    schema_usage: boolean;
    schema_create: boolean;
    readable: string[];
    writable: string[];
    other_access: string[];
  }>(`
    SELECT has_schema_privilege($2, $1, 'USAGE') AS schema_usage,
           has_schema_privilege($2, $1, 'CREATE') AS schema_create,
           ARRAY(
             SELECT relation.relname::text FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = $1 AND relation.relname = ANY($3::text[])
               AND has_table_privilege($2, relation.oid, 'SELECT')
             ORDER BY relation.relname
           ) AS readable,
           ARRAY(
             SELECT relation.relname::text FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = $1 AND relation.relname = ANY($3::text[])
               AND has_table_privilege($2, relation.oid, 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
             ORDER BY relation.relname
           ) AS writable,
           ARRAY(
             SELECT relation.relname::text FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = $1 AND relation.relname <> ALL($3::text[])
               AND (
                 (relation.relkind IN ('r', 'p', 'v', 'm', 'f')
                   AND has_table_privilege($2, relation.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'))
                 OR (relation.relkind = 'S'
                   AND has_sequence_privilege($2, relation.oid, 'USAGE,SELECT,UPDATE'))
               )
             ORDER BY relation.relname
           ) AS other_access
  `, [schemaName, roleName, [...GATEWAY_AUDIT_READER_TABLES]]);
  const row = result.rows.at(0);
  const expected = [...GATEWAY_AUDIT_READER_TABLES].sort();
  if (!row
    || !row.schema_usage
    || row.schema_create
    || row.readable.join(',') !== expected.join(',')
    || row.writable.length > 0
    || row.other_access.length > 0) {
    throw new Error(
      'Gateway audit reader access must be exact schema USAGE plus SELECT on '
      + `${expected.join(', ')}: ${JSON.stringify(row ?? null)}`,
    );
  }
}

/**
 * Post-readiness DCL step, run by the gateway once its audit and model-usage
 * stores have migrated. Unlike the startup ACL reset (which runs before those
 * tables may exist on a fresh fleet), this requires every audit table to exist
 * and proves the reader's access is exact; anything else fails startup closed.
 */
export async function grantGatewayAuditReaderAccess(input: {
  ownerDatabaseUrl: string;
  ownerRole: string;
  schema: string;
  role: string;
}): Promise<void> {
  const ownerRole = assertValidPostgresRoleName(input.ownerRole);
  const credential = parseExactPostgresCredential(
    input.ownerDatabaseUrl,
    'Gateway audit reader owner database credential',
  );
  if (credential.username !== ownerRole) { // ubs:ignore — compares public role identifiers, not secret material
    throw new Error(`Gateway audit reader grants must authenticate as schema owner ${ownerRole}`);
  }
  if (assertValidPostgresRoleName(input.role) === ownerRole) {
    throw new Error('Gateway audit reader role must be distinct from the schema owner');
  }
  const schemaName = assertValidPostgresSchemaName(input.schema);
  const pool = createPostgresPool(input.ownerDatabaseUrl, {
    applicationName: 'gateway-audit-reader-access',
    allowExitOnIdle: true,
    max: 1,
    schema: schemaName,
    role: ownerRole,
  });
  try {
    await withPostgresClient(pool, async (client) => {
      const granted = await applyGatewayAuditReaderAccess(client, { schema: schemaName, role: input.role });
      if (granted.length !== GATEWAY_AUDIT_READER_TABLES.length) {
        throw new Error(
          'Gateway audit reader grants require every gateway audit table to exist; granted '
          + `${granted.join(', ') || 'none'}`,
        );
      }
      await assertExactGatewayAuditReaderAccess(client, schemaName, input.role);
    });
  } finally {
    await pool.end();
  }
}
