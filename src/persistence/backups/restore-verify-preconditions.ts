import { createPostgresPool } from '../postgres.js';
import { parseExactPostgresCredential } from '../../shared/utils/postgres-credential.js';

interface RestoreVerifyPreflightRow {
  database_name: string;
  role_name: string;
  can_connect: boolean;
  can_create: boolean;
}

interface RestoreVerifyPreflightClient {
  query(): Promise<{ rows: RestoreVerifyPreflightRow[] }>;
  release(): void;
}

interface RestoreVerifyPreflightPool {
  connect(): Promise<RestoreVerifyPreflightClient>;
  end(): Promise<void>;
}

export interface RestoreVerifyDatabaseCredential {
  readonly label: string;
  readonly databaseUrl: string;
  readonly expectedRole: string;
}

export interface RestoreVerifyPreconditionDependencies {
  createPool(databaseUrl: string): RestoreVerifyPreflightPool;
}

const defaultDependencies: RestoreVerifyPreconditionDependencies = {
  createPool(databaseUrl) {
    const pool = createPostgresPool(databaseUrl, {
      applicationName: 'fleet-auth-restore-verify-preflight',
      max: 1,
    });
    return {
      async connect() {
        const client = await pool.connect();
        return {
          async query() {
            return await client.query<RestoreVerifyPreflightRow>(`
              SELECT current_database() AS database_name,
                     current_user AS role_name,
                     has_database_privilege(
                       current_user,
                       current_database(),
                       'CONNECT'
                     ) AS can_connect,
                     has_database_privilege(
                       current_user,
                       current_database(),
                       'CREATE'
                     ) AS can_create
            `);
          },
          release: () => client.release(),
        };
      },
      end: async () => await pool.end(),
    };
  },
};

/**
 * Fail startup before arming the backup scheduler unless every recovery
 * authority can connect to and create schemas in the same dedicated scratch
 * database. A successful TCP login alone is insufficient: pg_restore needs
 * database CREATE authority for the schema family.
 */
export async function assertRestoreVerifyDatabasePreconditions(
  options: {
    readonly credentials: readonly RestoreVerifyDatabaseCredential[];
  },
  dependencies: RestoreVerifyPreconditionDependencies = defaultDependencies,
): Promise<void> {
  if (options.credentials.length === 0) {
    throw new Error('Restore-verify preflight requires at least one database credential');
  }
  let expectedDatabaseName: string | undefined;
  for (const credential of options.credentials) {
    const parsed = parseExactPostgresCredential(
      credential.databaseUrl,
      `Fleet auth restore-verify ${credential.label} credential`,
    );
    if (parsed.username !== credential.expectedRole) {
      throw new Error(
        `Fleet auth restore-verify ${credential.label} credential must authenticate as `
        + credential.expectedRole,
      );
    }
    const urlDatabaseName = decodeURIComponent(parsed.url.pathname.slice(1));
    if (!urlDatabaseName.endsWith('_restore_verify')) {
      throw new Error(
        `Fleet auth restore-verify ${credential.label} credential must target a dedicated `
        + '_restore_verify database',
      );
    }

    const pool = dependencies.createPool(credential.databaseUrl);
    try {
      const client = await pool.connect();
      try {
        const row = (await client.query()).rows.at(0);
        if (!row
          || row.database_name !== urlDatabaseName
          || row.role_name !== credential.expectedRole) {
          throw new Error(
            `Fleet auth restore-verify ${credential.label} credential resolved an unexpected `
            + 'database or role',
          );
        }
        if (!row.can_connect || !row.can_create) {
          throw new Error(
            `Fleet auth restore-verify ${credential.label} requires CONNECT and CREATE `
            + `on restore-verify database ${row.database_name}`,
          );
        }
        if (expectedDatabaseName !== undefined && row.database_name !== expectedDatabaseName) {
          throw new Error('Fleet auth restore-verify credentials target different scratch databases');
        }
        expectedDatabaseName = row.database_name;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  }
}
