import { dirname, join } from 'node:path';
import { DEFAULT_GATEWAY_SOCKET_PATH } from '../../system/security/policy-constants.js';
import { parseOptionalStringEnv } from '../../shared/utils/env.js';

export const DEFAULT_ADMIN_TRANSPORT_SOCKET_BASENAME = 'garden-admin.sock';

export function resolveAdminTransportSocketPath(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const explicitSocketPath = parseOptionalStringEnv(env.ADMIN_TRANSPORT_SOCKET);
  if (explicitSocketPath) {
    return explicitSocketPath;
  }

  const gatewaySocketPath = parseOptionalStringEnv(env.GATEWAY_SOCKET)
    ?? DEFAULT_GATEWAY_SOCKET_PATH;
  return join(dirname(gatewaySocketPath), DEFAULT_ADMIN_TRANSPORT_SOCKET_BASENAME);
}
