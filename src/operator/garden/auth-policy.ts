import { isLoopbackHost } from '../../shared/net/hosts.js';

interface AdminAuthStartupLogger {
  error(message: string, metadata?: Record<string, unknown>): void;
}

export interface AdminAuthStartupPolicyConfig {
  host: string;
  port: number;
  token?: string;
  allowInsecureWithoutToken?: boolean;
  componentLabel: string;
  logger: AdminAuthStartupLogger;
}

const ADMIN_TOKEN_REQUIRED_ERROR = 'ADMIN_TOKEN is required unless ADMIN_ALLOW_INSECURE=true';
const ADMIN_INSECURE_LOOPBACK_ERROR =
  'ADMIN_ALLOW_INSECURE=true requires ADMIN_HOST to be loopback (127.0.0.1, ::1, or localhost)';

export function validateAdminAuthStartupPolicy(config: AdminAuthStartupPolicyConfig): void {
  if (!config.token && !config.allowInsecureWithoutToken) {
    const error = new Error(ADMIN_TOKEN_REQUIRED_ERROR);
    config.logger.error(`Refusing to start ${config.componentLabel} without authentication`, {
      host: config.host,
      port: config.port,
      requiredEnv: 'ADMIN_TOKEN or ADMIN_ALLOW_INSECURE=true',
    });
    throw error;
  }

  if (!config.token && !isLoopbackHost(config.host)) {
    const error = new Error(ADMIN_INSECURE_LOOPBACK_ERROR);
    config.logger.error(`Refusing to start insecure ${config.componentLabel} on non-loopback host`, {
      host: config.host,
      port: config.port,
    });
    throw error;
  }
}
