import type { Pool } from 'pg';
import type { ContactLifecycleGatewayPort } from '../contact-lifecycle-gateway-port.js';

export interface PostgresContactStoreOptions {
  pool?: Pool;
  applicationName?: string;
  exportDir?: string;
  /** Optional per-companion Postgres schema; pins the pool's search_path. */
  schema?: string;
  /** Authenticated gateway authority used by every fleet-authority mutation. */
  contactLifecycleGateway?: ContactLifecycleGatewayPort;
}
