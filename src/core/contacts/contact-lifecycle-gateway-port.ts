import type {
  ContactAuthorityLifecycleRequest,
  ContactAuthorityLifecycleResult,
} from '../../shared/contracts/contact-authority-lifecycle.js';

/**
 * Agent-side authority boundary. The companion id is deliberately absent: it
 * is derived from the authenticated gateway connection, never from contact
 * data or a mutation caller.
 */
export interface ContactLifecycleGatewayPort {
  executeContactLifecycle(
    request: ContactAuthorityLifecycleRequest,
  ): Promise<ContactAuthorityLifecycleResult>;
}
