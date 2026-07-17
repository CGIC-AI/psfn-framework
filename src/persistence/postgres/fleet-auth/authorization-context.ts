import type { Pool } from 'pg';
import { GatewayFleetAuthorizationContextResolver } from '../../../boundary/gateway/fleet-authorization-context.js';
import type { FleetAuthConfig } from '../../../system/config/fleet-auth-config.js';
import { PostgresFleetAuthorizationContextStore } from './authorization-context-store.js';
import type { ProviderRevocationAuthorityPort } from './provider-revocation-authority.js';

/**
 * Narrow gateway composition seam. The caller retains the Pool and authority
 * floor; the resolver exposes no raw persistence and no lifecycle mutation.
 */
export function createPostgresFleetAuthorizationContextResolver(options: {
  pool: Pool;
  sessionPepper: string;
  config: FleetAuthConfig;
  knownCompanionIds: readonly string[];
  providerRevocationAuthority: ProviderRevocationAuthorityPort;
  now?: () => Date;
}): GatewayFleetAuthorizationContextResolver {
  return new GatewayFleetAuthorizationContextResolver(
    new PostgresFleetAuthorizationContextStore({
      pool: options.pool,
      sessionPepper: options.sessionPepper,
      config: options.config,
      providerRevocationAuthority: options.providerRevocationAuthority,
      ...(options.now ? { now: options.now } : {}),
    }),
    options.knownCompanionIds,
  );
}
