import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ApiAuthPrincipal } from '../../backplane/http/auth.js';
import {
  isLoopbackHost,
  resolveApiRequestPrincipal,
} from '../http-policy.js';
import { sendApiError, type ApiServerLogger } from './http.js';

export interface ApiServerAuthConfig {
  host: string;
  port: number;
  apiKey?: string;
  allowInsecureWithoutAuth: boolean;
  /**
   * True when the server authenticates through a principal source other than
   * API_KEY (ADMIN_TOKEN, API_SATELLITE_KEYS, testing-harness key, fleet SSO
   * routes). Such a server is authenticated and must not be refused for a
   * missing API_KEY.
   */
  hasAlternatePrincipalSource?: boolean;
  logger: ApiServerLogger;
}

export interface ResolveApiServerPrincipalOptions {
  apiKey?: string;
  adminToken?: string;
  /** Per-satellite credentials; see `ResolveApiPrincipalOptions.satelliteApiKeys`. */
  satelliteApiKeys?: readonly string[];
  allowInsecureWithoutAuth: boolean;
  isTelemetryIngest: boolean;
}

export function validateApiServerAuthConfig(config: ApiServerAuthConfig): void {
  const authenticated = Boolean(config.apiKey) || config.hasAlternatePrincipalSource === true;
  if (!authenticated && !config.allowInsecureWithoutAuth) {
    const err = new Error('API_KEY is required unless ALLOW_INSECURE_LOCAL_API=true');
    config.logger.error('Refusing to start API server without authentication', {
      host: config.host,
      port: config.port,
      requiredEnv: 'API_KEY or ALLOW_INSECURE_LOCAL_API=true',
    });
    throw err;
  }

  if (config.allowInsecureWithoutAuth && !config.apiKey && !isLoopbackHost(config.host)) {
    const err = new Error(
      'ALLOW_INSECURE_LOCAL_API=true requires API_HOST to be loopback (127.0.0.1, ::1, or localhost)',
    );
    config.logger.error('Refusing to start insecure API server on non-loopback host', {
      host: config.host,
      port: config.port,
    });
    throw err;
  }
}

export function resolveApiServerRequestPrincipal(
  req: IncomingMessage,
  res: ServerResponse,
  options: ResolveApiServerPrincipalOptions,
): ApiAuthPrincipal | null {
  const resolution = resolveApiRequestPrincipal(req, {
    apiKey: options.apiKey,
    alternateApiToken: options.adminToken,
    alternateCookieTokenNames: options.adminToken ? ['psfn_token'] : [],
    ...(options.satelliteApiKeys ? { satelliteApiKeys: options.satelliteApiKeys } : {}),
    allowInsecureWithoutAuth: options.allowInsecureWithoutAuth,
    isTelemetryIngest: options.isTelemetryIngest,
  });

  if (resolution.ok) {
    return resolution.principal;
  }
  sendApiError(res, resolution.error.status, resolution.error.type, resolution.error.message);
  return null;
}
