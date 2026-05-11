import { Pool } from 'pg';
import type { ContactStorePort } from '../contact-store-port.js';
import type { PostgresContactStoreOptions } from './options.js';
import { ensurePostgresContactSchema } from './schema.js';
import { PostgresContactStore } from './store.js';

export async function createPostgresContactStore(
  databaseUrl: string,
  primaryUserId?: string,
  options: PostgresContactStoreOptions = {},
): Promise<ContactStorePort> {
  const pool = options.pool ?? new Pool({
    connectionString: databaseUrl,
    application_name: options.applicationName ?? 'psfn-contacts',
    allowExitOnIdle: true,
  });
  await ensurePostgresContactSchema(pool);
  return new PostgresContactStore(pool, primaryUserId, options.exportDir);
}
