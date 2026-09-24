import type { PostgresRetiredGranteeClient } from './retired-fleet-grantees.js';
import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  quotePostgresRoleName,
  quotePostgresSchemaName,
} from '../postgres.js';

/**
 * Where one unexpected grantee still holds privileges on a schema. An exact
 * grantee proof failure names only the role; a role that was granted access by
 * a since-removed feature (fleet auth's backup role, for example) usually holds
 * three independent kinds of residue, and default privileges can only be
 * revoked by the role that granted them. Revoking the schema ACL alone leaves
 * the others and the proof fails again with the same role name.
 */
export interface SchemaGranteeResidue {
  role: string;
  schemaAcl: boolean;
  objectGrants: number;
  /** Default-privilege entries, keyed by the granting role. */
  defaultPrivileges: { grantor: string; objectTypes: string[] }[];
}

const DEFAULT_ACL_OBJECT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  r: 'TABLES',
  S: 'SEQUENCES',
  f: 'FUNCTIONS',
  T: 'TYPES',
  n: 'SCHEMAS',
});

export async function readSchemaGranteeResidue(
  client: PostgresRetiredGranteeClient,
  schema: string,
  roles: readonly string[],
): Promise<SchemaGranteeResidue[]> {
  const namedRoles = roles.filter(role => role !== 'PUBLIC');
  if (namedRoles.length === 0) return [];
  const acl = await client.query<{ role_name: string; schema_acl: boolean; object_grants: number }>(`
    WITH object_acl AS (
      SELECT DISTINCT 'relation' AS object_kind, relation.oid AS object_id, acl.grantee
      FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      CROSS JOIN LATERAL aclexplode(relation.relacl) AS acl
      WHERE namespace.nspname = $1
      UNION
      SELECT DISTINCT 'routine' AS object_kind, routine.oid AS object_id, acl.grantee
      FROM pg_proc AS routine
      JOIN pg_namespace AS namespace ON namespace.oid = routine.pronamespace
      CROSS JOIN LATERAL aclexplode(routine.proacl) AS acl
      WHERE namespace.nspname = $1
    ),
    schema_acl AS (
      SELECT DISTINCT acl.grantee
      FROM pg_namespace AS namespace
      CROSS JOIN LATERAL aclexplode(namespace.nspacl) AS acl
      WHERE namespace.nspname = $1
    )
    SELECT role.rolname AS role_name,
      EXISTS (SELECT 1 FROM schema_acl WHERE schema_acl.grantee = role.oid) AS schema_acl,
      (SELECT COUNT(*)::integer FROM object_acl WHERE object_acl.grantee = role.oid) AS object_grants
    FROM pg_roles AS role
    WHERE role.rolname = ANY($2::text[])
    ORDER BY role.rolname
  `, [schema, namedRoles]);
  const defaults = await client.query<{ role_name: string; grantor: string; object_type: string }>(`
    SELECT DISTINCT pg_get_userbyid(acl.grantee) AS role_name,
      pg_get_userbyid(defaults.defaclrole) AS grantor,
      defaults.defaclobjtype::text AS object_type
    FROM pg_default_acl AS defaults
    JOIN pg_namespace AS namespace ON namespace.oid = defaults.defaclnamespace
    CROSS JOIN LATERAL aclexplode(defaults.defaclacl) AS acl
    WHERE namespace.nspname = $1
      AND acl.grantee <> 0
      AND pg_get_userbyid(acl.grantee) = ANY($2::text[])
    ORDER BY role_name, grantor, object_type
  `, [schema, namedRoles]);
  return acl.rows.map((row) => {
    const byGrantor = new Map<string, string[]>();
    for (const entry of defaults.rows.filter(candidate => candidate.role_name === row.role_name)) {
      const objectType = DEFAULT_ACL_OBJECT_TYPES[entry.object_type] ?? entry.object_type;
      byGrantor.set(entry.grantor, [...(byGrantor.get(entry.grantor) ?? []), objectType]);
    }
    return {
      role: row.role_name,
      schemaAcl: row.schema_acl,
      objectGrants: row.object_grants,
      defaultPrivileges: [...byGrantor.entries()].map(([grantor, objectTypes]) => ({
        grantor,
        objectTypes: [...objectTypes].sort(),
      })),
    };
  });
}

/**
 * Human-actionable description of the residue and the exact revocations, each
 * labelled with the role that must run it.
 */
export function describeSchemaGranteeResidue(
  schema: string,
  residues: readonly SchemaGranteeResidue[],
): string {
  if (residues.length === 0) return '';
  const quotedSchema = quotePostgresSchemaName(assertValidPostgresSchemaName(schema));
  const parts = residues.map((residue) => {
    const role = quotePostgresRoleName(assertValidPostgresRoleName(residue.role));
    const found = [
      ...(residue.schemaAcl ? ['schema ACL'] : []),
      ...(residue.objectGrants > 0 ? [`${residue.objectGrants} object grant(s)`] : []),
      ...residue.defaultPrivileges.map(entry => (
        `default privileges from ${entry.grantor} on ${entry.objectTypes.join('/')}`
      )),
    ];
    const ownerStatements = [
      `REVOKE ALL ON ALL TABLES IN SCHEMA ${quotedSchema} FROM ${role}`,
      `REVOKE ALL ON ALL SEQUENCES IN SCHEMA ${quotedSchema} FROM ${role}`,
      `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${quotedSchema} FROM ${role}`,
      `REVOKE ALL ON SCHEMA ${quotedSchema} FROM ${role}`,
    ];
    const defaultStatements = residue.defaultPrivileges.flatMap(entry => entry.objectTypes.map(
      objectType => `as ${entry.grantor}: ALTER DEFAULT PRIVILEGES IN SCHEMA ${quotedSchema} `
        + `REVOKE ALL ON ${objectType} FROM ${role}`,
    ));
    return `${residue.role} holds ${found.join(', ') || 'no remaining residue'}; `
      + `revoke as the schema owner: ${ownerStatements.join('; ')}`
      + (defaultStatements.length > 0 ? `; then ${defaultStatements.join('; ')}` : '');
  });
  return parts.join(' | ');
}
