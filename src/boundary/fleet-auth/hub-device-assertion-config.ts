import { createPublicKey } from 'node:crypto';
import { assertNoUnknownKeys, isCanonicalIsoTimestamp, isRecord } from '../../shared/utils/types.js';
import type {
  HubDeviceAssertionVerifierConfig,
  HubDeviceAssertionVerifierKey,
} from './hub-device-assertion.js';

/**
 * Owner-file parser for a Hub device assertion verifier ring.
 *
 * The same block shape is accepted from every authority that may carry it:
 * `fleet-auth.json` (`hubDeviceAssertions`), `satellites.json`
 * (`hubDeviceAssertions`, next to the endpoint `hubDeviceEnrollment`
 * records), and the standalone file named by `PSFN_HUB_DEVICE_ASSERTIONS_PATH`.
 * Fleet auth is an optional sign-in method; the Hub device authority must be
 * provisionable without it (psfn-framework-n66dn.2), so this parser lives in
 * the boundary module rather than inside the fleet-auth config loader.
 *
 * Error text keeps the `${field}...` addressing the fleet-auth loader always
 * used, prefixed with `errorPrefix` when the caller supplies one.
 */
export const HUB_DEVICE_ASSERTION_BLOCK_KEYS = [
  'issuer',
  'audience',
  'maxTtlSeconds',
  'clockSkewSeconds',
  'keys',
] as const;
export const HUB_DEVICE_ASSERTION_KEY_KEYS = [
  'kid',
  'publicKeyPem',
  'notBefore',
  'notAfter',
  'status',
] as const;

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface ParseHubDeviceAssertionVerifierConfigOptions {
  /** Field path used in error messages. Defaults to `hubDeviceAssertions`. */
  field?: string;
  /** Prefix prepended to every error message (`<prefix>: <message>`). */
  errorPrefix?: string;
  /** Clock used to check that the active key is inside its validity window. */
  now?: () => number;
}

export function parseHubDeviceAssertionVerifierConfig(
  value: unknown,
  options: ParseHubDeviceAssertionVerifierConfigOptions = {},
): HubDeviceAssertionVerifierConfig {
  const field = options.field ?? 'hubDeviceAssertions';
  const error = (message: string): Error => new Error(
    options.errorPrefix ? `${options.errorPrefix}: ${message}` : message,
  );
  const fail = (message: string): never => {
    throw error(message);
  };
  const requireRecord = (candidate: unknown, name: string): Record<string, unknown> => {
    if (!isRecord(candidate)) throw error(`${name} must be an object`);
    return candidate;
  };
  const requireExactKeys = (
    record: Record<string, unknown>,
    keys: readonly string[],
    name: string,
  ): void => {
    assertNoUnknownKeys(
      record,
      keys,
      name,
      options.errorPrefix ? { errorPrefix: options.errorPrefix } : {},
    );
    for (const key of keys) {
      if (!Object.hasOwn(record, key)) fail(`${name}.${key} is required`);
    }
  };
  const requireString = (candidate: unknown, name: string): string => {
    if (typeof candidate !== 'string' || candidate.trim().length === 0) {
      throw error(`${name} must be a non-empty string`);
    }
    return candidate.trim();
  };
  const requireInteger = (candidate: unknown, name: string, minimum: number, maximum: number): number => {
    if (!Number.isSafeInteger(candidate) || Number(candidate) < minimum || Number(candidate) > maximum) {
      fail(`${name} must be an integer between ${minimum} and ${maximum}`);
    }
    return Number(candidate);
  };

  const record = requireRecord(value, field);
  requireExactKeys(record, HUB_DEVICE_ASSERTION_BLOCK_KEYS, field);
  const issuer = requireString(record.issuer, `${field}.issuer`);
  if (!KEY_ID_PATTERN.test(issuer)) fail(`${field}.issuer must use stable identifier characters`);
  const audienceRaw = requireString(record.audience, `${field}.audience`);
  let audienceUrl: URL;
  try {
    audienceUrl = new URL(audienceRaw);
  } catch {
    throw error(`${field}.audience must be a valid URL`);
  }
  if (audienceUrl.protocol !== 'https:' || audienceUrl.username || audienceUrl.password
    || audienceUrl.pathname !== '/' || audienceUrl.search || audienceUrl.hash
    || audienceRaw.endsWith('/') || audienceRaw !== audienceUrl.origin) {
    fail(`${field}.audience must be an exact normalized https origin`);
  }
  const audience = audienceUrl.origin;
  const maxTtlSeconds = requireInteger(record.maxTtlSeconds, `${field}.maxTtlSeconds`, 5, 60);
  const clockSkewSeconds = requireInteger(record.clockSkewSeconds, `${field}.clockSkewSeconds`, 0, 10);
  if (!Array.isArray(record.keys) || record.keys.length === 0) {
    fail(`${field}.keys must be a non-empty array`);
  }
  const seen = new Set<string>();
  let activeCount = 0;
  const keys = (record.keys as unknown[]).map((entry, index): HubDeviceAssertionVerifierKey => {
    const keyField = `${field}.keys[${index}]`;
    const key = requireRecord(entry, keyField);
    requireExactKeys(key, HUB_DEVICE_ASSERTION_KEY_KEYS, keyField);
    const kid = requireString(key.kid, `${keyField}.kid`);
    if (!KEY_ID_PATTERN.test(kid)) fail(`${keyField}.kid must use stable identifier characters`);
    if (seen.has(kid)) fail(`duplicate Hub device assertion key ${kid}`);
    seen.add(kid);
    const publicKeyPem = requireString(key.publicKeyPem, `${keyField}.publicKeyPem`);
    if (publicKeyPem.includes('PRIVATE KEY')) fail(`${keyField}.publicKeyPem must be a public Ed25519 key`);
    let parsedType: string | undefined;
    try {
      parsedType = createPublicKey(publicKeyPem).asymmetricKeyType;
    } catch {
      parsedType = undefined;
    }
    if (parsedType !== 'ed25519') fail(`${keyField}.publicKeyPem must be a public Ed25519 key`);
    const notBefore = requireString(key.notBefore, `${keyField}.notBefore`);
    const notAfter = requireString(key.notAfter, `${keyField}.notAfter`);
    if (!isCanonicalIsoTimestamp(notBefore) || !isCanonicalIsoTimestamp(notAfter)
      || Date.parse(notBefore) >= Date.parse(notAfter)) {
      fail(`${keyField} must have an ordered ISO validity window`);
    }
    const status = key.status;
    if (status !== 'active' && status !== 'retiring' && status !== 'revoked') {
      throw error(`${keyField}.status must be active, retiring, or revoked`);
    }
    if (status === 'active') activeCount += 1;
    return { kid, publicKeyPem, notBefore, notAfter, status };
  });
  if (activeCount !== 1) fail('Hub device assertion keys must contain exactly one active key');
  const active = keys.find(key => key.status === 'active')!;
  const now = options.now?.() ?? Date.now();
  if (Date.parse(active.notBefore) > now || Date.parse(active.notAfter) <= now) {
    fail('the active Hub device assertion key must be inside its configured validity window');
  }
  return { issuer, audience, maxTtlSeconds, clockSkewSeconds, keys };
}

/**
 * Accept the three file layouts an operator may hand to tooling: a bare
 * verifier block, a `{ hubDeviceAssertions: ... }` wrapper (satellites.json,
 * the standalone env file, or fleet-auth.json), or nothing.
 */
export function extractHubDeviceAssertionBlock(document: unknown): unknown {
  if (!isRecord(document)) return undefined;
  if (Object.hasOwn(document, 'hubDeviceAssertions')) return document.hubDeviceAssertions;
  if (HUB_DEVICE_ASSERTION_BLOCK_KEYS.every(key => Object.hasOwn(document, key))) return document;
  return undefined;
}
