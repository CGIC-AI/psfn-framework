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
  const ownsPool = options.pool === undefined;
  const pool = options.pool ?? createPostgresPool(databaseUrl, {
    applicationName: options.applicationName ?? 'psfn-contacts',
    allowExitOnIdle: true,
    schema: options.schema,
  });
  try {
    await ensurePostgresContactSchema(pool);
    const store = new PostgresContactStore(
      pool,
      primaryUserId,
      options.exportDir,
      options.contactLifecycleGateway,
    );
    await store.assertContactLifecycleLedgerHealthy();
    if (options.contactLifecycleGateway) {
      await store.recoverContactLifecycleMutations();
    }
    return store;
  } catch (error) {
    if (ownsPool) {
      try {
        await pool.end();
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          'Contact store startup failed and its owned Postgres pool could not close',
        );
      }
    }
    throw error;
  }
}
