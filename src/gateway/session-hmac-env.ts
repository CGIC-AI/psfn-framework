import type { SessionHmacKeyring } from '../session/journal-utils.js';
import {
  createSessionHmacBoundaryService,
  GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV,
  GATEWAY_SESSION_HMAC_KEYS_ENV,
  GATEWAY_SESSION_HMAC_KEY_ENV,
} from '../session/hmac-boundary.js';

export function resolveGatewaySessionHmacKeyring(
  env: NodeJS.ProcessEnv = process.env,
): SessionHmacKeyring | null {
  return createSessionHmacBoundaryService({ env }).resolveKeyring();
}

export function requireGatewaySessionHmacKeyring(
  env: NodeJS.ProcessEnv = process.env,
): SessionHmacKeyring {
  return createSessionHmacBoundaryService({ env }).requireKeyring(
    `Session HMAC keyring is required for gateway mode. Set ${GATEWAY_SESSION_HMAC_KEYS_ENV} `
      + `or ${GATEWAY_SESSION_HMAC_KEY_ENV} (optionally ${GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV}).`,
  );
}
