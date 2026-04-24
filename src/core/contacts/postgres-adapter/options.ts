import type { Pool } from 'pg';

export interface PostgresContactStoreOptions {
  pool?: Pool;
  applicationName?: string;
  exportDir?: string;
}

