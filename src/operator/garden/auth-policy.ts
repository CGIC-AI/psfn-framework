import { isLoopbackHost } from '../../shared/net/hosts.js';
import { isIP } from 'node:net';
import { validateGardenProxySources } from './browser-proxy-policy.js';

interface AdminAuthStartupLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface AdminAuthStartupPolicyConfig {
  host: string;
  port: number;
  token?: string;
  allowInsecureWithoutToken?: boolean;
  publicOrigin?: string;
  trustedProxyAddresses?: readonly string[];
  componentLabel: string;
  logger: AdminAuthStartupLogger;
}

const ADMIN_TOKEN_REQUIRED_ERROR = 'ADMIN_TOKEN is required unless ADMIN_ALLOW_INSECURE=true';
const ADMIN_INSECURE_LOOPBACK_ERROR =
  'ADMIN_ALLOW_INSECURE=true requires ADMIN_HOST to be loopback (127.0.0.1, ::1, or localhost)';

export function validateAdminAuthStartupPolicy(config: AdminAuthStartupPolicyConfig): void {
  const loopback = isLoopbackHost(config.host)
    && (isIP(config.host) !== 0 || config.host.toLowerCase() === 'localhost');
  if (!config.token && !config.allowInsecureWithoutToken) {
    config.logger.error(`Refusing to start ${config.componentLabel} without authentication`, {
      host: config.host, port: config.port, requiredEnv: 'ADMIN_TOKEN or ADMIN_ALLOW_INSECURE=true',
    });
    throw new Error(ADMIN_TOKEN_REQUIRED_ERROR);
  }
  if (!config.token && !loopback) throw new Error(ADMIN_INSECURE_LOOPBACK_ERROR);
  const proxyConfigured = config.publicOrigin !== undefined || config.trustedProxyAddresses !== undefined;
  if (proxyConfigured) {
    let origin: URL;
    try { origin = new URL(config.publicOrigin ?? ''); } catch {
      throw new Error('Garden trusted proxy requires ADMIN_PUBLIC_ORIGIN as an exact HTTPS origin');
    }
    if (origin.protocol !== 'https:' || origin.origin !== config.publicOrigin
      || !config.trustedProxyAddresses?.length) {
      throw new Error('Garden trusted proxy requires an exact HTTPS origin and explicit trusted proxy sources');
    }
    validateGardenProxySources(config.trustedProxyAddresses);
  }
  if (!loopback && !proxyConfigured) {
    throw new Error('Non-loopback standalone Garden requires an explicitly trusted TLS proxy');
  }
}
