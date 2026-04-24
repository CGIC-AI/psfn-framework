import { Pool, type PoolClient } from 'pg';

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
      // best effort rollback
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function queryRows<T>(pool: Pool, text: string, values: readonly unknown[] = []): Promise<T[]> {
  const result = await pool.query(text, values);
  return result.rows as T[];
}

export async function queryOne<T>(pool: Pool, text: string, values: readonly unknown[] = []): Promise<T | undefined> {
  const rows = await queryRows<T>(pool, text, values);
  return rows[0];
}

