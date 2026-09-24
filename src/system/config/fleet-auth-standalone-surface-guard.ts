import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('FleetAuthSurfaceGuard');

/** Second, explicit acknowledgement required to keep the no-key bypass under fleet auth. */
const INSECURE_LOCAL_API_UNDER_FLEET_AUTH_ACK_ENV = 'ALLOW_INSECURE_LOCAL_API_UNDER_FLEET_AUTH';

function isExplicitTrueEnv(value: string | undefined): boolean {
  // Mirrors isExplicitTrue without importing the app layer into system/.
  return value?.trim().toLowerCase() === 'true';
}

/**
 * Fleet auth ADDS SSO principals; it never removes key authentication (operator
 * rule, S13). It does not have to keep the unauthenticated no-key path, though:
 * a fleet deployment carrying a stale `ALLOW_INSECURE_LOCAL_API=true` would turn
 * on the insecure local principal next to the browser SSO surface at upgrade
 * time. Refuse that at startup unless the operator also sets
 * `ALLOW_INSECURE_LOCAL_API_UNDER_FLEET_AUTH=true`; an acknowledged bypass still
 * logs a loud warning.
 *
 * Returns whether the acknowledged bypass stays in effect under fleet auth.
 */
export function assertInsecureLocalApiAcknowledgedUnderFleetAuth(options: {
  fleetAuthEnabled: boolean;
  env: NodeJS.ProcessEnv;
  logger?: { warn(message: string): void };
}): boolean {
  if (!options.fleetAuthEnabled) return false;
  if (!isExplicitTrueEnv(options.env.ALLOW_INSECURE_LOCAL_API)) return false;
  if (!isExplicitTrueEnv(options.env[INSECURE_LOCAL_API_UNDER_FLEET_AUTH_ACK_ENV])) {
    throw new Error(
      'ALLOW_INSECURE_LOCAL_API=true is set while fleet auth (fleet-auth.json) is active; '
      + 'refusing to start with an unauthenticated API bypass beside SSO. Remove '
      + 'ALLOW_INSECURE_LOCAL_API from the fleet deployment, or set '
      + `${INSECURE_LOCAL_API_UNDER_FLEET_AUTH_ACK_ENV}=true if the loopback no-key API is intentional. `
      + 'Key authentication is unaffected either way.',
    );
  }
  (options.logger ?? log).warn(
    'ALLOW_INSECURE_LOCAL_API=true is acknowledged under fleet auth '
    + `(${INSECURE_LOCAL_API_UNDER_FLEET_AUTH_ACK_ENV}=true); `
    + 'the insecure no-auth bypass REMAINS IN EFFECT on the gateway API alongside SSO.',
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
