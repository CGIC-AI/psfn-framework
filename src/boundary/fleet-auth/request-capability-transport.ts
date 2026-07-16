import type { IncomingHttpHeaders } from 'node:http';

/** Headers are transport metadata only when authored by a trusted process. */
export const REQUEST_CAPABILITY_ASSERTION_HEADERS = Object.freeze([
  'x-psfn-request-capability',
  'x-psfn-parent-capability',
  'x-psfn-capability-audience',
  'x-psfn-capability-request-id',
  'x-psfn-capability-decision',
  'x-psfn-capability-jti',
] as const);

/**
 * Browser-facing listeners remove assertion-shaped headers before routing so
 * no downstream code can accidentally promote caller-controlled authority.
 */
export function stripBrowserRequestCapabilityHeaders(headers: IncomingHttpHeaders): void {
  for (const name of REQUEST_CAPABILITY_ASSERTION_HEADERS) delete headers[name];
}
