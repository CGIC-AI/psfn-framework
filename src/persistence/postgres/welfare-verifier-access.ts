import type { QueryResult, QueryResultRow } from 'pg';
import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  quotePostgresRoleName,
  quotePostgresSchemaName,
} from '../postgres.js';

/**
 * Minimal client surface for welfare-verifier provisioning. Both pg `Pool` and
 * `PoolClient` satisfy it; the relation probe needs row access, unlike the pure
 * DDL grant client in `backup-schema-access.ts`.
 */
export interface PostgresWelfareVerifierClient {
  query<T extends QueryResultRow = QueryResultRow>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<QueryResult<T>>;
}

export interface PostgresWelfareVerifierLoginEvidence {
  role: string;
  /** True only when the LOGIN role did not exist before this call. */
  created: boolean;
}

export interface PostgresWelfareVerifierGrantEvidence {
  schema: string;
  verifierRole: string;
  /** False when the tenant has not run its background-work migrations yet. */
  relationGranted: boolean;
}

const WELFARE_VERIFIER_ROLE_ATTRIBUTES = [
  'LOGIN',
  'NOINHERIT',
  'NOSUPERUSER',
  'NOCREATEDB',
  'NOCREATEROLE',
  'NOREPLICATION',
  'NOBYPASSRLS',
].join(' ');

/**
 * Provision the dedicated gateway welfare-verifier LOGIN role.
 *
 * The verifier must connect through its OWN least-privilege credential, never
 * a companion runtime role: a direct USAGE/SELECT grant on a companion
 * runtime role would reach the agent pods that share that credential and
 * breach sibling isolation. This function creates the LOGIN role if absent,
 * or converges a pre-existing role to the exact least-privilege posture, and
 * (re)sets its password so the gateway's resolved credential authenticates.
 *
 * The DDL is rendered server-side through `format(%I, %L)` so neither the
 * validated role name nor the operator-supplied password can smuggle SQL; the
 * fixed attribute string is a code constant. Idempotent: every run lands the
 * same role shape and password.
 */
export async function provisionWelfareVerifierLoginRole(
  client: PostgresWelfareVerifierClient,
  input: {
    role: string;
    password: string;
    connectionLimit: number;
  },
): Promise<PostgresWelfareVerifierLoginEvidence> {
  const role = assertValidPostgresRoleName(input.role);
  if (typeof input.password !== 'string' || input.password.length === 0) {
    throw new Error('Welfare verifier login password must be a non-empty string');
  }
  if (!Number.isSafeInteger(input.connectionLimit) || input.connectionLimit < 1) {
    throw new Error('Welfare verifier connection limit must be a positive integer');
  }
  const existing = await client.query<{ exists: boolean }>(
    'SELECT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = $1) AS exists',
    [role],
  );
  const created = existing.rows.at(0)?.exists !== true;
  const verb = created ? 'CREATE ROLE' : 'ALTER ROLE';
  // The format string is a code constant (not operator input); only the role
  // name and password arrive as parameters. `format()` is polymorphic
  // (`text, VARIADIC "any"`), so the parameters are cast to `text` to let
  // the planner resolve the variadic. `%I`/`%L` then quote the identifier and
  // password server-side, so neither can smuggle SQL.
  const rendered = await client.query<{ stmt: string }>(
    `SELECT format('%s %I ${WELFARE_VERIFIER_ROLE_ATTRIBUTES} CONNECTION LIMIT %s PASSWORD %L', $1::text, $2::text, $3::text, $4::text) AS stmt`,
    [verb, role, input.connectionLimit, input.password],
  );
  const stmt = rendered.rows.at(0)?.stmt;
  if (typeof stmt !== 'string' || stmt.length === 0) {
    throw new Error('Welfare verifier login role DDL did not render');
  }
  await client.query(stmt);
  return { role, created };
}

/**
 * Apply the exact welfare-verifier read contract for one fleet tenant schema.
 *
 * The gateway welfare grant verifier (`boundary/gateway/welfare-grant-verifier.ts`)
 * connects through its dedicated LOGIN role and proves `SELECT` on
 * `agent_background_work_jobs` in every fleet schema before honoring
 * `preemptionProtected`. Tenant membership alone cannot supply that privilege:
 * every fleet login role is NOINHERIT (the Postgres tenancy contract in
 * docs/multi-companion.md), so the membership provisioning grants carries
 * `inherit_option = false` and a login role holds no privilege through it.
 * Without these direct grants the readiness probe fails closed and the
 * verifier degrades.
 *
 * This grant lands on the DEDICATED verifier role, never on a companion
 * runtime role: a companion runtime credential reaches the agent pods, so a
 * cross-schema grant on it would breach fleet sibling isolation. The verifier
 * role legitimately holds USAGE/SELECT across every fleet schema — it is a
 * fleet-wide gateway-only reader — and it is granted membership in no tenant
 * role, so the per-companion runtime isolation the tenancy primitive enforces
 * is preserved exactly.
 *
 * This is an operator-only grant, applied solely by the fleet provisioning
 * path (`scripts/provision-postgres-tenancy.ts`) after the tenant's
 * background-work migrations — never by the shared
 * `provisionPostgresTenantAccess` primitive, which shard and harness callers
 * also use and which must not escalate application-time privileges.
 *
 * Least privilege by construction: schema USAGE plus SELECT on the single
 * verifier relation, granted directly to the verifier role — no default
 * privileges, no blanket table grants, no ownership transfer, no membership.
 * Both statements are idempotent, so an operator re-run after the tenant's
 * background-work migrations is the repair path for a schema provisioned
 * before its tables existed (a newly added follower). When the relation is
 * still absent the schema grant still lands and the evidence reports
 * `relationGranted: false` so the caller can re-assert after migrations.
 */
export async function grantWelfareVerifierReadAccessToTenantSchema(
  client: PostgresWelfareVerifierClient,
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
  const probe = await client.query<{ relation: string | null }>(
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
