import type { Pool } from 'pg';
import { createPostgresPool, ensurePostgresSchema, queryOne, queryRows } from '../../../persistence/postgres.js';
import { POSTGRES_INTENTION_MIGRATIONS } from './schema.js';

export { queryOne, queryRows };

export function createIntentionPostgresPool(
  databaseUrl: string,
  options: { applicationName?: string; schema?: string; role?: string } = {},
): Pool {
  return createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-intention',
    allowExitOnIdle: true,
    schema: options.schema,
    role: options.role,
  });
}

export async function ensureIntentionPostgresSchema(pool: Pool): Promise<void> {
  await ensurePostgresSchema(pool, POSTGRES_INTENTION_MIGRATIONS);
}
