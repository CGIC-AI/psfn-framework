import type { ContactAuthorityLifecycleResult } from '../../shared/contracts/contact-authority-lifecycle.js';

/**
 * The authenticated companion id is supplied by gateway routing, outside the
 * wire contract.  This prevents an agent/contact request from selecting the
 * authority domain in which its lifecycle operation executes.
 */
export interface GatewayContactLifecycleAuthorityPort {
  executeForCompanion(
    authenticatedCompanionId: string,
    request: unknown,
  ): Promise<ContactAuthorityLifecycleResult>;
}

export class ContactLifecycleAuthorityDeniedError extends Error {
  constructor(readonly reasonCode: string, options?: ErrorOptions) {
    super('Contact lifecycle authority operation was denied', options);
    this.name = 'ContactLifecycleAuthorityDeniedError';
  }
}
