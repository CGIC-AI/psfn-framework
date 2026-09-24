import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  quotePostgresRoleName,
  quotePostgresSchemaName,
} from '../../postgres.js';
import type { PostgresRetiredGranteeClient } from '../retired-fleet-grantees.js';
import {
  readSchemaGranteeResidue,
  type SchemaGranteeResidue,
} from '../schema-grantee-residue.js';
import { FLEET_AUTH_SCHEMA_NAME } from './schema.js';

/**
 * Supported disable path for fleet auth (bead psfn-framework-bi3w6).
 *
 * Fleet auth grants its runtime/migration/backup roles access to every
 * companion schema and the shared schema, as each schema's OWNER, including
 * default privileges that only the granting owner can revoke. Removing
 * `fleet-auth.json` leaves all of that behind, and the shared-runtime
 * readiness proof then refuses to boot on the unexpected grantees. That proof
 * stays fail-closed: with the owner file gone the former role names are
 * unknowable to the runtime, so the operator names them here and this module
 * revokes exactly those roles' residue, connected as the schema owner.
 *
 * Only the schema owner's own grants and default privileges are revoked. A
 * default-privilege entry granted by any other role is reported, not touched,
 * because it cannot be revoked from this connection.
 */

export interface FormerFleetAuthGrantTeardownReport {
  schema: string;
  owner: string;
  /** Named roles that do not exist in the cluster (nothing to revoke). */
  absentRoles: string[];
  /** Residue found before any revocation. */
  before: SchemaGranteeResidue[];
  /** Residue left afterwards; equal to `before` on a dry run. */
  after: SchemaGranteeResidue[];
  /** Statements run (apply) or that would run (dry run), in order. */
  statements: string[];
  applied: boolean;
}

const OWNER_DEFAULT_PRIVILEGE_OBJECT_TYPES = ['TABLES', 'SEQUENCES', 'FUNCTIONS', 'TYPES'] as const;

function hasResidue(residue: SchemaGranteeResidue): boolean {
  return residue.schemaAcl || residue.objectGrants > 0 || residue.defaultPrivileges.length > 0;
}

/**
 * Revoke the named former fleet-auth roles' grants on one schema. The client
 * must be connected as the schema owner; anything else fails closed before a
 * statement runs.
 */
export async function teardownFormerFleetAuthGrants(
  client: PostgresRetiredGranteeClient,
  input: { schema: string; roles: readonly string[]; apply: boolean },
): Promise<FormerFleetAuthGrantTeardownReport> {
  const schemaName = assertValidPostgresSchemaName(input.schema);
  const roles = [...new Set(input.roles.map(assertValidPostgresRoleName))].sort();
  if (roles.length === 0) {
    throw new Error('Fleet auth grant teardown requires at least one former fleet-auth role');
  }
  const ownerRow = await client.query<{ owner: string; current_role: string }>(`
    SELECT pg_get_userbyid(namespace.nspowner) AS owner, current_user AS current_role
    FROM pg_namespace AS namespace
    WHERE namespace.nspname = $1
  `, [schemaName]);
  const ownership = ownerRow.rows.at(0);
  if (!ownership) {
    throw new Error(`Fleet auth grant teardown found no schema ${schemaName}`);
  }
  if (ownership.owner !== ownership.current_role) {
    throw new Error(
      `Fleet auth grant teardown for schema ${schemaName} must run as its owner ${ownership.owner}`,
    );
  }
  if (roles.includes(ownership.owner)) {
    throw new Error(`Fleet auth grant teardown refuses to revoke the owner of schema ${schemaName}`);
  }
  const present = await client.query<{ role_name: string }>(
    'SELECT rolname AS role_name FROM pg_roles WHERE rolname = ANY($1::text[]) ORDER BY rolname',
    [roles],
  );
  const presentRoles = present.rows.map(row => row.role_name);
  const absentRoles = roles.filter(role => !presentRoles.includes(role));
  const before = await readSchemaGranteeResidue(client, schemaName, presentRoles);

  const schema = quotePostgresSchemaName(schemaName);
  const ownerRole = quotePostgresRoleName(assertValidPostgresRoleName(ownership.owner));
  const statements: string[] = [];
  for (const residue of before.filter(hasResidue)) {
    const role = quotePostgresRoleName(assertValidPostgresRoleName(residue.role));
    statements.push(
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM ${role}`,
      `REVOKE ALL ON SCHEMA ${schema} FROM ${role}`,
    );
    if (residue.defaultPrivileges.some(entry => entry.grantor === ownership.owner)) {
      for (const objectType of OWNER_DEFAULT_PRIVILEGE_OBJECT_TYPES) {
        statements.push(
          `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA ${schema} `
          + `REVOKE ALL ON ${objectType} FROM ${role}`,
        );
      }
    }
  }
  if (input.apply) {
    for (const statement of statements) await client.query(statement);
  }
  const after = input.apply
    ? await readSchemaGranteeResidue(client, schemaName, presentRoles)
    : before;
  return {
    schema: schemaName,
    owner: ownership.owner,
    absentRoles,
    before: before.filter(hasResidue),
    after: after.filter(hasResidue),
    statements,
    applied: input.apply,
  };
}

/**
 * The cluster-level cleanup only a superuser can do, printed for the operator
 * after the schema residue is gone. Nothing here is executed by the runtime.
 */
export function formerFleetAuthSuperuserSteps(roles: readonly string[]): string[] {
  const quoted = [...new Set(roles.map(assertValidPostgresRoleName))].sort().map(quotePostgresRoleName);
  return [
    `DROP SCHEMA IF EXISTS ${quotePostgresSchemaName(FLEET_AUTH_SCHEMA_NAME)} CASCADE;`,
    '-- drop the fleet-auth restore verification database (<database>_restore_verify) if one exists',
    ...quoted.map(role => `DROP OWNED BY ${role} CASCADE;`),
    ...quoted.map(role => `DROP ROLE IF EXISTS ${role};`),
  ];
}
