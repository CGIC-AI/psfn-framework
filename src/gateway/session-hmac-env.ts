// ── Session HMAC Keyring environment resolution ──
// Extracts keyring configuration from environment variables for gateway use.

import {
  buildSessionHmacKeyring,
  type SessionHmacKeyring,
} from '../session/journal-utils.js';

const GATEWAY_SESSION_HMAC_KEYS_ENV = 'GATEWAY_SESSION_HMAC_KEYS';
const GATEWAY_SESSION_HMAC_KEY_ENV = 'GATEWAY_SESSION_HMAC_KEY';
const GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV = 'GATEWAY_SESSION_HMAC_ACTIVE_VERSION';

export function resolveGatewaySessionHmacKeyring(
  env: NodeJS.ProcessEnv = process.env,
): SessionHmacKeyring | null {
  return buildSessionHmacKeyring({
    serializedKeys: env[GATEWAY_SESSION_HMAC_KEYS_ENV],
    singleKey: env[GATEWAY_SESSION_HMAC_KEY_ENV],
    activeVersion: env[GATEWAY_SESSION_HMAC_ACTIVE_VERSION_ENV],
  });
}
