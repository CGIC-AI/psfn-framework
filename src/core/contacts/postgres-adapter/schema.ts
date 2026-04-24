import type { Pool } from 'pg';
import { POSTGRES_CONTACT_MIGRATIONS } from '../../../persistence/postgres/migrations.js';
import { withPostgresClient } from './connection.js';

export async function ensurePostgresContactSchema(pool: Pool): Promise<void> {
  await withPostgresClient(pool, async (client) => {
    for (const statement of POSTGRES_CONTACT_MIGRATIONS) {
      await client.query(statement);
    }
  });
}

