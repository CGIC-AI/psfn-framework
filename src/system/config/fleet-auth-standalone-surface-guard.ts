import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('FleetAuthSurfaceGuard');

/**
 * Fleet auth ADDS SSO principals; it never removes key authentication or the
 * explicit insecure-local bypass (operator rule, S13). `ALLOW_INSECURE_LOCAL_API=true`
 * therefore stays in effect under fleet auth exactly as it does without it,
 * which is almost never what a fleet deployment wants: the no-auth bypass now
 * sits next to a browser SSO surface. Emit a loud startup warning so the flag is
 * noticed and removed rather than lingering.
 *
 * Returns whether the warning fired (for callers and tests).
 */
export function warnIfInsecureLocalApiUnderFleetAuth(options: {
  fleetAuthEnabled: boolean;
  env: NodeJS.ProcessEnv;
  logger?: { warn(message: string): void };
}): boolean {
  if (!options.fleetAuthEnabled) return false;
  // Mirrors isExplicitTrue without importing the app layer into system/.
  if (options.env.ALLOW_INSECURE_LOCAL_API?.trim().toLowerCase() !== 'true') return false;
  (options.logger ?? log).warn(
    'ALLOW_INSECURE_LOCAL_API=true is set while fleet auth (PSFN_FLEET_AUTH) is active; '
    + 'the insecure no-auth bypass REMAINS IN EFFECT on the gateway API alongside SSO. '
    + 'Remove ALLOW_INSECURE_LOCAL_API from the fleet deployment unless the unauthenticated '
    + 'loopback API is intentional.',
  );
  return true;
}

/**
 * Startup consistency check for processes that expose an HTTP surface while
 * fleet auth is configured.
 *
 * Fleet auth is optional: it may only ADD the SSO router, lifecycle routes and
 * SSO principals. Key/token authentication (API_KEY, ADMIN_TOKEN,
 * API_SATELLITE_KEYS, the testing-harness key, ADMIN_ALLOW_INSECURE) is never
 * rejected, gated, or treated as "standalone material" by this guard. The only
 * remaining rule is that a gateway which exposes its API port with fleet auth
 * configured must actually have the fleet-auth bootstrap (SSO login/lifecycle)
 * routes wired — otherwise `fleet-auth.json` is present but its one purpose,
 * the SSO door, silently does not exist. Key authentication being the only
 * wired principal source is a valid deployment and never fails boot.
 *
 * `principalAuthenticationWired` is accepted for call-site compatibility and
 * reports whether the SSO principal composition is complete; it counts as
 * bootstrap routes being wired.
 */
export function assertFleetAuthStandaloneSurfacesUnavailable(options: {
  fleetAuthEnabled: boolean;
  processMode: 'gateway' | 'operator';
  env: NodeJS.ProcessEnv;
  principalAuthenticationWired?: boolean;
  fleetAuthBootstrapRoutesWired?: boolean;
}): void {
  if (!options.fleetAuthEnabled) return;
  if (options.processMode !== 'gateway') return;
  const exposesGatewayApi = Boolean(options.env.API_PORT?.trim());
  const ssoRoutesWired = options.fleetAuthBootstrapRoutesWired === true
    || options.principalAuthenticationWired === true;
  if (exposesGatewayApi && !ssoRoutesWired) {
    throw new Error(
      'Fleet auth is configured but its SSO bootstrap routes are not wired on the gateway API; '
      + 'wire the fleet-auth routes or remove fleet-auth.json (key authentication is unaffected either way)',
    );
  }
}
