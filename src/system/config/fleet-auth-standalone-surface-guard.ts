import { createComponentLogger } from '../../shared/logger.js';

const log = createComponentLogger('FleetAuthSurfaceGuard');

/**
 * Fleet auth forces the insecure no-auth local API bypass off — the gateway API
 * surface computes `allowInsecureWithoutAuth = !fleetAuthBootstrapOnly && ...`,
 * so `ALLOW_INSECURE_LOCAL_API=true` has no effect once fleet auth is active.
 * When an operator still leaves that flag set in a fleet deployment it is
 * silently ineffective and dangerously misleading. Emit a loud startup warning
 * so the flag is noticed and removed rather than lingering where a later config
 * change could re-enable the bypass.
 *
 * Returns whether the warning fired (for callers and tests).
 */
export function warnIfInsecureLocalApiIgnoredUnderFleetAuth(options: {
  fleetAuthEnabled: boolean;
  env: NodeJS.ProcessEnv;
  logger?: { warn(message: string): void };
}): boolean {
  if (!options.fleetAuthEnabled) return false;
  // Mirrors isExplicitTrue without importing the app layer into system/.
  if (options.env.ALLOW_INSECURE_LOCAL_API?.trim().toLowerCase() !== 'true') return false;
  (options.logger ?? log).warn(
    'ALLOW_INSECURE_LOCAL_API=true is set but IGNORED because fleet auth (PSFN_FLEET_AUTH) is active; '
    + 'the gateway API stays authenticated. Remove ALLOW_INSECURE_LOCAL_API from the fleet deployment so '
    + 'the insecure no-auth bypass cannot be re-enabled by a later config change.',
  );
  return true;
}

export function assertFleetAuthStandaloneSurfacesUnavailable(options: {
  fleetAuthEnabled: boolean;
  processMode: 'gateway' | 'operator';
  env: NodeJS.ProcessEnv;
  principalAuthenticationWired?: boolean;
  fleetAuthBootstrapRoutesWired?: boolean;
}): void {
  if (!options.fleetAuthEnabled) return;
  const exposesGatewayApi = options.processMode === 'gateway'
    && Boolean(options.env.API_PORT?.trim());
  const exposesStandaloneGardenCredentials = options.principalAuthenticationWired !== true
    && (Boolean(options.env.ADMIN_TOKEN?.trim())
      || options.env.ADMIN_ALLOW_INSECURE === 'true');
  const exposesUnprotectedOperator = options.processMode === 'operator'
    && options.principalAuthenticationWired !== true;
  const gatewayApiProtected = options.principalAuthenticationWired === true
    || options.fleetAuthBootstrapRoutesWired === true;
  if (exposesStandaloneGardenCredentials || exposesUnprotectedOperator
    || (exposesGatewayApi && !gatewayApiProtected)) {
    throw new Error(
      'Fleet auth enabled mode rejects standalone Garden/API token, cookie, HTTP, and WebSocket '
      + 'surfaces before listen until bootstrap-only routes or principal authentication are wired',
    );
  }
}
