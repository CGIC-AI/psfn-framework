import type { Pool, QueryResultRow } from 'pg';

import { assertValidPostgresSchemaName } from '../postgres.js';

interface PostgresRelationContractRow extends QueryResultRow {
  schema_name: string | null;
  relation_exists: boolean;
  missing_columns: string[] | null;
  missing_privileges: string[] | null;
}

export type PostgresRelationRuntimePrivilege = 'SELECT' | 'UPDATE';

export interface PostgresRelationColumnContract {
  /** Omit to resolve the pool's pinned current_schema(). */
  schema?: string;
  relation: string;
  columns: readonly string[];
  /** Operational ACLs this specific runtime path must hold. */
  privileges?: readonly PostgresRelationRuntimePrivilege[];
}

/**
 * Prove a runtime relation's table/column migration shape without selecting the
 * relation itself. PostgreSQL exposes namespace, relation, and attribute shape
 * through pg_catalog independently of DML grants on the target relation, so a
 * least-privilege role can certify schema readiness without widening its ACL.
 */
export async function assertPostgresRelationColumns(
  pool: Pool,
  contract: PostgresRelationColumnContract,
): Promise<void> {
  const schema = contract.schema === undefined
    ? null
    : assertValidPostgresSchemaName(contract.schema);
  const relation = assertValidPostgresSchemaName(contract.relation);
  const columns = contract.columns.map(assertValidPostgresSchemaName);
  const privileges = [...(contract.privileges ?? [])];
  if (columns.length === 0 || new Set(columns).size !== columns.length) {
    throw new Error('PostgreSQL relation contract requires distinct columns');
  }
  if (new Set(privileges).size !== privileges.length) {
    throw new Error('PostgreSQL relation contract requires distinct privileges');
  }

  const result = await pool.query<PostgresRelationContractRow>(`
    WITH target_schema AS (
      SELECT COALESCE($1::text, pg_catalog.current_schema()) AS schema_name
    ), target_relation AS (
      SELECT target_schema.schema_name, relation.oid AS relation_oid
      FROM target_schema
      LEFT JOIN pg_catalog.pg_namespace AS namespace
        ON namespace.nspname = target_schema.schema_name
      LEFT JOIN pg_catalog.pg_class AS relation
        ON relation.relnamespace = namespace.oid
       AND relation.relname = $2
       AND relation.relkind IN ('r', 'p')
    )
    SELECT target_relation.schema_name,
           target_relation.relation_oid IS NOT NULL AS relation_exists,
           COALESCE(
             ARRAY(
               SELECT expected.column_name
               FROM pg_catalog.unnest($3::text[])
                 WITH ORDINALITY AS expected(column_name, position)
               WHERE NOT EXISTS (
                 SELECT 1
                 FROM pg_catalog.pg_attribute AS attribute
                 WHERE attribute.attrelid = target_relation.relation_oid
                   AND attribute.attname = expected.column_name
                   AND attribute.attnum > 0
                   AND NOT attribute.attisdropped
               )
               ORDER BY expected.position
             ),
             ARRAY[]::text[]
           ) AS missing_columns,
           COALESCE(
             ARRAY(
               SELECT expected.privilege_name
               FROM pg_catalog.unnest($4::text[])
                 WITH ORDINALITY AS expected(privilege_name, position)
               WHERE target_relation.relation_oid IS NULL
                  OR NOT pg_catalog.has_table_privilege(
                    CURRENT_USER,
                    target_relation.relation_oid,
                    expected.privilege_name
                  )
               ORDER BY expected.position
             ),
             ARRAY[]::text[]
           ) AS missing_privileges
    FROM target_relation
  `, [schema, relation, columns, privileges]);
  const row = result.rows.at(0);
  const schemaName = row?.schema_name ?? schema ?? 'current_schema()';
  const qualified = `${schemaName}.${relation}`;
  if (!row?.relation_exists) {
    throw new Error(`PostgreSQL relation ${qualified} is missing`);
  }
  const missingColumns = row.missing_columns ?? columns;
  if (missingColumns.length > 0) {
    throw new Error(
      `PostgreSQL relation ${qualified} is missing required columns: ${missingColumns.join(', ')}`,
    );
  }
  const missingPrivileges = row.missing_privileges ?? privileges;
  if (missingPrivileges.length > 0) {
    throw new Error(
      `PostgreSQL relation ${qualified} is missing required role privileges: `
      + missingPrivileges.join(', '),
    );
  }
}
