import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SessionHmacKeyring } from '../../persistence/journals/journal-utils.js';

export const GATEWAY_COMPANION_AUTH_TOKEN_ENV = 'GATEWAY_COMPANION_AUTH_TOKEN';
export const GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN_ENV = 'GATEWAY_SESSION_INTEGRITY_AUTH_TOKEN';
const COMPANION_AUTH_CONTEXT = 'substrate-gateway-companion-auth-v1';
const TOKEN_PATTERN = /^([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/u;
export type AuthenticatedGatewayRole = 'agent' | 'internal_session_integrity';

function computeCompanionAuthDigest(
  companionId: string,
  role: AuthenticatedGatewayRole,
  key: string,
): string {
  return createHmac('sha256', key)
    .update(`${COMPANION_AUTH_CONTEXT}\0${role}\0${companionId}`, 'utf8')
    .digest('hex');
}

export function deriveCompanionAuthToken(
  companionId: string,
  role: AuthenticatedGatewayRole,
  keyring: SessionHmacKeyring,
): string {
  const normalizedId = companionId.trim();
  if (!normalizedId) {
    throw new Error('Companion authentication requires a non-empty companionId');
  }
  const key = keyring.keys[keyring.activeVersion];
  if (!key) {
    throw new Error(`Missing companion authentication key version ${JSON.stringify(keyring.activeVersion)}`);
  }
  return `${keyring.activeVersion}.${computeCompanionAuthDigest(normalizedId, role, key)}`;
}

export function verifyCompanionAuthToken(
  companionId: string,
  role: AuthenticatedGatewayRole,
  token: string | undefined,
  keyring: SessionHmacKeyring,
): boolean {
  const match = token?.trim().match(TOKEN_PATTERN);
  if (!match) return false;
  const [, keyVersion, observedDigest] = match;
  const key = keyring.keys[keyVersion];
  if (!key) return false;
  const expectedDigest = computeCompanionAuthDigest(companionId.trim(), role, key);
  const observed = Buffer.from(observedDigest, 'hex');
  const expected = Buffer.from(expectedDigest, 'hex');
  return observed.length === expected.length && timingSafeEqual(observed, expected);
}
