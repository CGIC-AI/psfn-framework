import type { Pool } from 'pg';
import type { ContactStorePort } from '../core/contacts/contact-store-port.js';
import { createPostgresContactStore } from '../core/contacts/postgres-adapter.js';
import { FakePostgresPool } from './fake-postgres-contact-pool.js';

export interface TestPostgresContactStore {
  pool: FakePostgresPool;
  store: ContactStorePort;
}

export async function createTestPostgresContactStore(
  primaryUserId?: string,
): Promise<TestPostgresContactStore> {
  const pool = new FakePostgresPool();
  const store = await createPostgresContactStore('postgres://unused', primaryUserId, {
    pool: pool as unknown as Pool,
  });
  return { pool, store };
}
