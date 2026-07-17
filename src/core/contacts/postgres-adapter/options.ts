import type { Pool } from 'pg';
import type { ContactLifecycleGatewayPort } from '../contact-lifecycle-gateway-port.js';
import type { ContactAuthorityLifecycleRequest } from '../../../shared/contracts/contact-authority-lifecycle.js';

export type ContactLifecycleFaultStage =
  | 'after_local_prepare'
  | 'after_gateway_fence'
  | 'after_gateway_result'
  | 'after_contact_commit'
  | 'after_gateway_finalize'
  | 'after_local_final_record';

export interface PostgresContactStoreOptions {
  pool?: Pool;
  applicationName?: string;
  exportDir?: string;
  /** Optional per-companion Postgres schema; pins the pool's search_path. */
  schema?: string;
  role?: string;
  /** Authenticated gateway authority used by every fleet-authority mutation. */
  contactLifecycleGateway?: ContactLifecycleGatewayPort;
  /** Deterministic certification seam; never configured by runtime/env input. */
  contactLifecycleFaultInjection?: (
    stage: ContactLifecycleFaultStage,
    request: ContactAuthorityLifecycleRequest,
  ) => Promise<void> | void;
}
