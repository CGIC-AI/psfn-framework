import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  quotePostgresRoleName,
  quotePostgresSchemaName,
} from '../postgres.js';

/**
 * Minimal client surface for the welfare-verifier grant. Both pg `Pool` and
 * `Client` satisfy it; the relation probe needs row access, unlike the pure
 * DDL grant client in `backup-schema-access.ts`.
 */
export interface PostgresWelfareGrantClient {
  query(sql: string): Promise<{ rows: Array<{ relation: string | null }> }>;
}

export interface PostgresWelfareVerifierGrantEvidence {
  schema: string;
  verifierRole: string;
  /** False when the tenant has not run its background-work migrations yet. */
  relationGranted: boolean;
}

/**
 * Apply the exact welfare-verifier read contract for one fleet tenant schema.
 *
 * The gateway welfare grant verifier (`boundary/gateway/welfare-grant-verifier.ts`)
 * connects unpinned as the runtime login role and proves `SELECT` on
 * `agent_background_work_jobs` in every fleet schema before honoring
 * `preemptionProtected`. Tenant membership alone cannot supply that privilege:
 * the runtime login role is NOINHERIT (docs/helm-upgrades.md tenancy cutover
 * gate 6), so the membership provisioning grants carries
 * `inherit_option = false` and the login role holds no privilege through it.
 * Without these direct grants the readiness probe fails closed and the
 * verifier degrades (psfn-framework-m8zdu, Helm revision 15 rollout).
 *
 * This is an operator-only grant, applied solely by the fleet provisioning
 * path (`scripts/provision-postgres-tenancy.ts`) after the tenant's
 * background-work migrations — never by the shared
 * `provisionPostgresTenantAccess` primitive, which shard and harness callers
 * also use and which must not escalate application-time privileges.
 *
 * Least privilege by construction: schema USAGE plus SELECT on the single
 * verifier relation, granted directly to the runtime login role — no default
 * privileges, no blanket table grants, no ownership transfer. Both statements
 * are idempotent, so an operator re-run after the tenant's background-work
 * migrations is the repair path for a schema provisioned before its tables
 * existed (a newly added follower). When the relation is still absent the
 * schema grant still lands and the evidence reports `relationGranted: false`
 * so the caller can re-assert after migrations.
 */
export async function grantWelfareVerifierReadAccessToTenantSchema(
  client: PostgresWelfareGrantClient,
  input: {
    schema: string;
    verifierRole: string;
  },
): Promise<PostgresWelfareVerifierGrantEvidence> {
  const schemaName = assertValidPostgresSchemaName(input.schema);
  const schema = quotePostgresSchemaName(schemaName);
  const verifierRole = quotePostgresRoleName(assertValidPostgresRoleName(input.verifierRole));

  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${verifierRole}`);
  // Both identifiers are strictly validated lowercase names, so literal
  // interpolation into the regclass probe cannot smuggle SQL.
  const probe = await client.query(
    `SELECT to_regclass('${schemaName}.agent_background_work_jobs')::text AS relation`,
  );
  const relationGranted = probe.rows.at(0)?.relation != null;
  if (relationGranted) {
    await client.query(
      `GRANT SELECT ON ${schema}.agent_background_work_jobs TO ${verifierRole}`,
    );
  }
  return { schema: schemaName, verifierRole: input.verifierRole, relationGranted };
}
