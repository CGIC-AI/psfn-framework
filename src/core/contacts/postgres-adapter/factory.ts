import type { ContactStorePort } from '../contact-store-port.js';
import { createPostgresPool } from '../../../persistence/postgres.js';
import type { PostgresContactStoreOptions } from './options.js';
import { ensurePostgresContactSchema } from './schema.js';
import { PostgresContactStore } from './store.js';

export async function createPostgresContactStore(
  databaseUrl: string,
  primaryUserId?: string,
  options: PostgresContactStoreOptions = {},
): Promise<ContactStorePort> {
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-contacts',
    allowExitOnIdle: true,
    schema: options.schema,
  });
  await ensurePostgresContactSchema(pool);
  return new PostgresContactStore(pool, primaryUserId, options.exportDir);
}
