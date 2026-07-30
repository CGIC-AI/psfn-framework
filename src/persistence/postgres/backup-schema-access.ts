import {
  assertValidPostgresRoleName,
  assertValidPostgresSchemaName,
  quotePostgresRoleName,
  quotePostgresSchemaName,
} from '../postgres.js';

export interface PostgresGrantClient {
  query(sql: string): Promise<unknown>;
}

/**
 * Apply the complete read-only backup contract for one tenant schema.
 *
 * Present objects need direct grants. Future objects need owner-scoped default
 * privileges because tenant migrations authenticate as the schema owner.
 */
export async function grantBackupReadAccessToTenantSchema(
  client: PostgresGrantClient,
  input: {
    schema: string;
    ownerRole: string;
    backupRole: string;
  },
): Promise<void> {
  const schema = quotePostgresSchemaName(assertValidPostgresSchemaName(input.schema));
  const ownerRole = quotePostgresRoleName(assertValidPostgresRoleName(input.ownerRole));
  const backupRole = quotePostgresRoleName(assertValidPostgresRoleName(input.backupRole));

  await client.query(`GRANT USAGE ON SCHEMA ${schema} TO ${backupRole}`);
  await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${backupRole}`);
  await client.query(`GRANT SELECT ON ALL SEQUENCES IN SCHEMA ${schema} TO ${backupRole}`);
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA ${schema} `
    + `GRANT SELECT ON TABLES TO ${backupRole}`,
  );
  await client.query(
    `ALTER DEFAULT PRIVILEGES FOR ROLE ${ownerRole} IN SCHEMA ${schema} `
    + `GRANT SELECT ON SEQUENCES TO ${backupRole}`,
  );
}
