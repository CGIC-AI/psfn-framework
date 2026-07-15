import type { Pool } from 'pg';
import {
  createPostgresIntentionPortsFromPool,
  type PostgresIntentionPortOptions,
  type PostgresIntentionPorts,
} from '../core/intention/postgres-adapters.js';
import { FakeIntentionPool } from './fake-postgres-intention-pool.js';

export interface TestPostgresIntentionPorts {
  pool: FakeIntentionPool;
  ports: PostgresIntentionPorts;
}

export function createTestPostgresIntentionPorts(
  options: PostgresIntentionPortOptions = {},
): TestPostgresIntentionPorts {
  const pool = new FakeIntentionPool();
  const ports = createPostgresIntentionPortsFromPool(pool as unknown as Pool, options);
  return { pool, ports };
}
