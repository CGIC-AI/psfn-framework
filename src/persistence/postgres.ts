import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

export interface PostgresConnectionOptions {
  applicationName?: string;
  allowExitOnIdle?: boolean;
  max?: number;
}

export function createPostgresPool(
  connectionString: string,
  options: PostgresConnectionOptions = {},
): Pool {
  const config: PoolConfig = {
    connectionString,
    application_name: options.applicationName ?? 'psfn-framework',
    allowExitOnIdle: options.allowExitOnIdle ?? true,
    ...(options.max !== undefined ? { max: options.max } : {}),
  };
  return new Pool(config);
}

export async function withPostgresClient<T>(
  pool: Pool,
  handler: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await handler(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Best effort rollback only.
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function ensurePostgresSchema(pool: Pool, statements: readonly string[]): Promise<void> {
  await withPostgresClient(pool, async (client) => {
    for (const statement of statements) {
      await client.query(statement);
    }
  });
}

export async function queryRows<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<T[]> {
  const result = await pool.query<T>(text, [...values]);
  return result.rows;
}

export async function queryOne<T extends QueryResultRow>(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<T | undefined> {
  const result = await pool.query<T>(text, [...values]);
  return result.rows[0];
}

export async function executeQuery(
  pool: Pool,
  text: string,
  values: readonly unknown[] = [],
): Promise<QueryResult> {
  return await pool.query(text, [...values]);
}
