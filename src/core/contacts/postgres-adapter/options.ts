import type { Pool } from 'pg';

export interface PostgresContactStoreOptions {
  pool?: Pool;
  applicationName?: string;
  exportDir?: string;
  /** Optional per-companion Postgres schema; pins the pool's search_path. */
  schema?: string;
}

