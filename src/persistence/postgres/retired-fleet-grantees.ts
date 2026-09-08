import type { QueryResult, QueryResultRow } from 'pg';
import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  quotePostgresRoleName,
  quotePostgresSchemaName,
} from '../postgres.js';

/**
 * Minimal client surface for retired-grantee reconciliation. Both pg `Pool` and
 * `PoolClient` satisfy it; the role probe needs row access, so this cannot use
 * the pure DDL client shape in `backup-schema-access.ts`.
 */
export interface PostgresRetiredGranteeClient {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

/**
 * The dedicated fleet-wide welfare-verifier LOGIN role retired by
 * psfn-framework-h248l.7. Fleet welfare grants are verified through each
 * companion's own runtime authority (`welfare.grant.verify`), so nothing
 * provisions this role or its cross-schema USAGE/SELECT any more — but every
 * fleet provisioned before the retirement still carries those grants on every
 * companion schema, and the exact-grantee proof would otherwise refuse the
 * upgrade at startup.
 */
export const RETIRED_FLEET_WELFARE_VERIFIER_ROLE = 'psfn_welfare_verifier';

/**
 * Closed allowlist of retired grantee role names. Only a role named here is
 * revoked and tolerated; PUBLIC and every other unexpected grantee still fails
 * the exact-grantee proof closed. The list is code-owned and reduction-only: it
 * shrinks when a retired role is provably gone from every deployment, and a new
 * entry requires the same retirement evidence this one carries.
 */
export const RETIRED_FLEET_SCHEMA_GRANTEES: readonly string[] = Object.freeze([
  RETIRED_FLEET_WELFARE_VERIFIER_ROLE,
]);

export interface RetiredGranteePartition {
  /** Grantees on the closed retired allowlist: revoked, then tolerated. */
  retired: string[];
  /** Every other unexpected grantee, including PUBLIC: always fails closed. */
  unexpected: string[];
}

/**
 * Split an exact-grantee proof's unexpected rows into the closed retired
 * allowlist and everything else. Pure so the tolerance boundary is provable
 * without a database.
 */
export function partitionRetiredGrantees(
  granteeNames: readonly string[],
  retiredGrantees: readonly string[] = RETIRED_FLEET_SCHEMA_GRANTEES,
): RetiredGranteePartition {
  const allowed = new Set(retiredGrantees);
  const retired: string[] = [];
  const unexpected: string[] = [];
  for (const name of granteeNames) {
    if (typeof name !== 'string' || name.length === 0) continue;
    if (allowed.has(name)) retired.push(name);
    else unexpected.push(name);
  }
  return { retired, unexpected };
}

/**
 * Revoke every retired grantee's privileges on one schema, idempotently.
 *
 * Executed by the schema owner inside the shared-schema access transaction: a
 * superuser GRANT is recorded as though the owner made it, so the owner's
 * REVOKE removes it. A role that no longer exists is skipped (REVOKE against an
 * unknown role errors); a role that holds nothing is revoked to no effect
 * (PostgreSQL warns rather than failing), which is exactly why the caller must
 * still tolerate a surviving retired grantee instead of assuming the cleanup
 * landed.
 *
 * Returns the retired roles that existed and were revoked.
 */
export async function revokeRetiredFleetGranteesFromSchema(
  client: PostgresRetiredGranteeClient,
  input: {
    schema: string;
    retiredGrantees?: readonly string[];
  },
): Promise<string[]> {
  const schema = quotePostgresSchemaName(assertValidPostgresSchemaName(input.schema));
  const candidates = [...new Set(
    (input.retiredGrantees ?? RETIRED_FLEET_SCHEMA_GRANTEES).map(assertValidPostgresRoleName),
  )].sort();
  if (candidates.length === 0) return [];
  const present = await client.query<{ role_name: string }>(
    'SELECT rolname AS role_name FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
    [candidates],
  );
  const revoked: string[] = [];
  for (const row of present.rows) {
    const roleName = assertValidPostgresRoleName(row.role_name);
    if (!candidates.includes(roleName)) {
      throw new Error('Retired fleet grantee probe returned a role outside the closed allowlist');
    }
    const role = quotePostgresRoleName(roleName);
    await client.query(`REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${role}`);
    await client.query(`REVOKE ALL ON SCHEMA ${schema} FROM ${role}`);
    revoked.push(roleName);
  }
  return revoked;
}
