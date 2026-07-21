import type { Pool, PoolClient } from 'pg';
import { assertValidPostgresRoleName } from '../postgres.js';

type PostgresQueryable = Pick<Pool | PoolClient, 'query'>;

interface PostgresRolePostureRow {
  rolname: string;
  rolcanlogin: boolean;
  rolinherit: boolean;
  credential_not_expired: boolean;
  rolconnlimit: number;
  owns_target_database: boolean;
  rolsuper: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

const FORBIDDEN_ROLE_ATTRIBUTES = [
  { column: 'rolsuper', label: 'SUPERUSER' },
  { column: 'rolcreaterole', label: 'CREATEROLE' },
  { column: 'rolcreatedb', label: 'CREATEDB' },
  { column: 'rolreplication', label: 'REPLICATION' },
  { column: 'rolbypassrls', label: 'BYPASSRLS' },
] as const satisfies ReadonlyArray<{
  column: keyof PostgresRolePostureRow;
  label: string;
}>;

/**
 * One fail-closed posture guard for every database credential with application
 * authority. In addition to PostgreSQL's cluster-wide privilege attributes, a
 * mapped role must not own the target database: database ownership implicitly
 * carries destructive authority that schema ACLs cannot revoke.
 */
export async function assertPostgresRolesAreLeastPrivilege(
  client: PostgresQueryable,
  roles: readonly string[],
  authority: string,
): Promise<void> {
  const expectedRoles = [...new Set(roles.map(assertValidPostgresRoleName))].sort();
  if (expectedRoles.length === 0) {
    throw new Error(`${authority} must name at least one PostgreSQL role`);
  }
  const result = await client.query<PostgresRolePostureRow>(`
    SELECT role.rolname,
           role.rolcanlogin,
           role.rolinherit,
           (role.rolvaliduntil IS NULL OR role.rolvaliduntil > clock_timestamp())
             AS credential_not_expired,
           role.rolconnlimit,
           database.datdba = role.oid AS owns_target_database,
           role.rolsuper,
           role.rolcreaterole,
           role.rolcreatedb,
           role.rolreplication,
           role.rolbypassrls
    FROM pg_roles AS role
    CROSS JOIN pg_database AS database
    WHERE role.rolname = ANY($1::text[])
      AND database.datname = current_database()
    ORDER BY role.rolname
  `, [expectedRoles]);
  if (JSON.stringify(result.rows.map(row => row.rolname)) !== JSON.stringify(expectedRoles)) {
    throw new Error(`${authority} names an unknown PostgreSQL role`);
  }
  for (const row of result.rows) {
    if (!row.rolcanlogin) {
      throw new Error(`${authority} PostgreSQL role ${row.rolname} must be a LOGIN role`);
    }
    if (row.rolinherit || !row.credential_not_expired || row.rolconnlimit < 1
      || row.owns_target_database) {
      throw new Error(
        `${authority} PostgreSQL role ${row.rolname} must be NOINHERIT, credential-valid, `
        + 'finite CONNECTION LIMIT >= 1, and must not own the target database',
      );
    }
    const forbiddenAttributes = FORBIDDEN_ROLE_ATTRIBUTES
      .filter(attribute => row[attribute.column])
      .map(attribute => attribute.label);
    if (forbiddenAttributes.length > 0) {
      throw new Error(
        `${authority} PostgreSQL role ${row.rolname} must not hold cluster authority attributes: `
        + forbiddenAttributes.join(', '),
      );
    }
  }
  const memberships = await client.query<{
    authority_role: string;
    related_role: string;
  }>(`
    SELECT authority_role.rolname AS authority_role,
           related_role.rolname AS related_role
    FROM pg_roles AS authority_role
    CROSS JOIN pg_roles AS related_role
    WHERE authority_role.rolname = ANY($1::text[])
      AND related_role.oid <> authority_role.oid
      AND (
        pg_has_role(authority_role.oid, related_role.oid, 'MEMBER')
        OR (
          NOT related_role.rolsuper
          AND pg_has_role(related_role.oid, authority_role.oid, 'MEMBER')
        )
      )
    ORDER BY authority_role.rolname, related_role.rolname
  `, [expectedRoles]);
  if (memberships.rows.length > 0) {
    const edges = memberships.rows.map(row => `${row.authority_role}<->${row.related_role}`);
    throw new Error(
      `${authority} PostgreSQL roles must have no role memberships or SET ROLE targets: `
      + edges.join(', '),
    );
  }
}
