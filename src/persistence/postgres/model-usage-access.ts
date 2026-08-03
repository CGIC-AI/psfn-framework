import type { Pool, PoolClient } from 'pg';
import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  createPostgresPool,
  quotePostgresRoleName,
  quotePostgresSchemaName,
  withPostgresClient,
} from '../postgres.js';
import { assertPostgresRolesAreLeastPrivilege } from './role-posture.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';

export const MODEL_USAGE_LEDGER_TABLE = 'model_usage_events';

/**
 * Read-only startup proof for a pool pinned to the canonical fleet ledger.
 * It never creates or repairs anything: the gateway owner must finish the
 * migration and grants before a follower can become ready.
 */
export async function assertModelUsageLedgerReadable(pool: Pool): Promise<void> {
  const result = await pool.query<{
    ledger_table: string | null;
    can_select: boolean;
  }>(`
    SELECT to_regclass($1)::text AS ledger_table,
           CASE WHEN to_regclass($1) IS NULL THEN FALSE
                ELSE has_table_privilege(current_user, to_regclass($1), 'SELECT') END AS can_select
  `, [MODEL_USAGE_LEDGER_TABLE]);
  const row = result.rows.at(0);
  if (!row?.ledger_table || row.can_select !== true) {
    throw new Error(
      'Canonical model usage ledger is unavailable to this read-only runtime; '
      + 'the gateway model-usage authority has not completed provisioning',
    );
  }
}

async function assertOwnerAuthority(
  client: PoolClient,
  primarySchema: string,
  primaryRole: string,
): Promise<void> {
  const result = await client.query<{
    current_user: string;
    schema_owner: string | null;
    ledger_owner: string | null;
  }>(`
    SELECT current_user,
           (
             SELECT owner.rolname
             FROM pg_namespace AS namespace
             JOIN pg_roles AS owner ON owner.oid = namespace.nspowner
             WHERE namespace.nspname = $1
           ) AS schema_owner,
           (
             SELECT owner.rolname
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             JOIN pg_roles AS owner ON owner.oid = relation.relowner
             WHERE namespace.nspname = $1 AND relation.relname = $2
           ) AS ledger_owner
  `, [primarySchema, MODEL_USAGE_LEDGER_TABLE]);
  const row = result.rows.at(0);
  if (row?.current_user !== primaryRole
    || row.schema_owner !== primaryRole
    || row.ledger_owner !== primaryRole) {
    throw new Error(
      'Fleet model usage grants require the canonical schema and ledger owner credential',
    );
  }
}

export async function assertExactModelUsageFollowerAccess(
  client: PoolClient,
  primarySchema: string,
  followerRoles: readonly string[],
): Promise<void> {
  const result = await client.query<{
    role_name: string;
    schema_usage: boolean;
    schema_create: boolean;
    ledger_select: boolean;
    ledger_write: boolean;
    other_relation_access: boolean;
    sequence_access: boolean;
    routine_access: boolean;
  }>(`
    SELECT role_name,
           has_schema_privilege(role_name, $2, 'USAGE') AS schema_usage,
           has_schema_privilege(role_name, $2, 'CREATE') AS schema_create,
           has_table_privilege(
             role_name,
             to_regclass(format('%I.%I', $2::text, $3::text)),
             'SELECT'
           ) AS ledger_select,
           has_table_privilege(
             role_name,
             to_regclass(format('%I.%I', $2::text, $3::text)),
             'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
           ) AS ledger_write,
           EXISTS (
             SELECT 1
             FROM pg_class AS relation
             JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname = $2
               AND relation.relname <> $3
               AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND has_table_privilege(
                 role_name,
                 relation.oid,
                 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER'
               )
           ) AS other_relation_access,
           EXISTS (
             SELECT 1
             FROM pg_class AS sequence
             JOIN pg_namespace AS namespace ON namespace.oid = sequence.relnamespace
             WHERE namespace.nspname = $2
               AND sequence.relkind = 'S'
               AND has_sequence_privilege(role_name, sequence.oid, 'USAGE,SELECT,UPDATE')
           ) AS sequence_access,
           EXISTS (
             SELECT 1
             FROM pg_proc AS routine
             JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
             WHERE namespace.nspname = $2
               AND has_function_privilege(role_name, routine.oid, 'EXECUTE')
           ) AS routine_access
    FROM unnest($1::text[]) AS role_name
    ORDER BY role_name
  `, [followerRoles, primarySchema, MODEL_USAGE_LEDGER_TABLE]);
  if (result.rows.length !== followerRoles.length
    || result.rows.some(row => (
      !row.schema_usage
      || row.schema_create
      || !row.ledger_select
      || row.ledger_write
      || row.other_relation_access
      || row.sequence_access
      || row.routine_access
    ))) {
    throw new Error(
      'Fleet model usage follower access must be exact schema USAGE plus ledger SELECT',
    );
  }
}

/**
 * Gateway-only DCL step. The canonical companion's owner credential retains
 * all DDL/write authority; followers receive only USAGE on that schema and
 * SELECT on model_usage_events. The operation is idempotent and repairs overly
 * broad grants by revoking before applying the exact contract.
 */
export async function grantFleetModelUsageReadAccess(input: {
  ownerDatabaseUrl: string;
  primarySchema: string;
  primaryRole: string;
  followerRoles: readonly string[];
}): Promise<void> {
  const primarySchema = assertValidPostgresSchemaName(input.primarySchema);
  const primaryRole = assertValidPostgresRoleName(input.primaryRole);
  const followerRoles = [...new Set(input.followerRoles.map(assertValidPostgresRoleName))]
    .sort();
  if (followerRoles.length !== input.followerRoles.length
    || followerRoles.includes(primaryRole)) {
    throw new Error('Fleet model usage follower roles must be distinct from the canonical owner');
  }
  if (followerRoles.length === 0) return;
  const credential = parseExactPostgresCredential(
    input.ownerDatabaseUrl,
    'Fleet model usage owner database credential',
  );
  if (credential.username !== primaryRole) { // ubs:ignore — compares public role identifiers, not secret material
    throw new Error(
      `Fleet model usage owner credential must authenticate as configured role ${primaryRole}`,
    );
  }
  const pool = createPostgresPool(input.ownerDatabaseUrl, {
    applicationName: 'fleet-model-usage-access',
    allowExitOnIdle: true,
    max: 1,
    schema: primarySchema,
    role: primaryRole,
  });
  const schema = quotePostgresSchemaName(primarySchema);
  const ledger = quotePostgresSchemaName(MODEL_USAGE_LEDGER_TABLE);
  try {
    await withPostgresClient(pool, async (client) => {
      await assertPostgresRolesAreLeastPrivilege(
        client,
        [primaryRole, ...followerRoles],
        'Fleet model usage mapped authority',
      );
      await assertOwnerAuthority(client, primarySchema, primaryRole);
      await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM PUBLIC`);
      await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC`);
      for (const followerRole of followerRoles) {
        const role = quotePostgresRoleName(followerRole);
        await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${role}`);
        await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
        await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
        await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${role}`);
        await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
        await client.query(`GRANT SELECT ON ${schema}.${ledger} TO ${role}`);
      }
      await assertExactModelUsageFollowerAccess(client, primarySchema, followerRoles);
    });
  } finally {
    await pool.end();
  }
}
