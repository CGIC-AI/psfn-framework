import {
  createHash,
  createPublicKey,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';

export type HubDeviceAssertionKeyStatus = 'active' | 'retiring' | 'revoked';

export interface HubDeviceAssertionVerifierKey {
  kid: string;
  publicKeyPem: string;
  notBefore: string;
  notAfter: string;
  status: HubDeviceAssertionKeyStatus;
}

export interface HubDeviceAssertionVerifierConfig {
  issuer: string;
  audience: string;
  maxTtlSeconds: number;
  clockSkewSeconds: number;
  keys: HubDeviceAssertionVerifierKey[];
}

export interface HubDeviceAssertionExpectedBinding {
  deviceId: string;
  enrollmentVersion: number;
  enrollmentStatus: 'active' | 'revoked';
  companionId: string;
}

export interface HubDeviceAssertionReplayStore {
  consume(input: {
    issuer: string;
    jti: string;
    assertionDigest: string;
    deviceId: string;
    enrollmentVersion: number;
    expiresAt: Date;
  }): Promise<{ outcome: 'consumed' | 'replayed' | 'mismatch' }>;
}

export interface HubDevicePrincipal {
  kind: 'hub_device';
  issuer: string;
  keyId: string;
  deviceId: string;
  enrollmentVersion: number;
  enrollmentAssurance: 'device_credential';
  placeId?: string;
  audience: string;
  companionId: string;
  sessionId: string;
  issuedAt: Date;
  expiresAt: Date;
  jti: string;
}

const HEADER_KEYS = ['alg', 'typ', 'v', 'kid'] as const;
const REQUIRED_CLAIM_KEYS = [
  'iss',
  'device_id',
  'enrollment_version',
  'enrollment_assurance',
  'aud',
  'companion_id',
  'session_id',
  'iat',
  'exp',
  'jti',
] as const;
const CLAIM_KEYS = [...REQUIRED_CLAIM_KEYS, 'place_id'] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/u;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export async function verifyAndConsumeHubDeviceAssertion(input: {
  token: string;
  config: HubDeviceAssertionVerifierConfig;
  expected: HubDeviceAssertionExpectedBinding;
  replayStore: HubDeviceAssertionReplayStore;
  nowSeconds?: number;
}): Promise<HubDevicePrincipal> {
  const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 1) {
    throw new Error('Hub device assertion verification time is invalid');
  }
  const parsedConfig = validateVerifierConfig(input.config);
  const compact = parseCompactToken(input.token);
  const header = parseHeader(compact.encodedHeader);
  const key = parsedConfig.keys.find(candidate => candidate.kid === header.kid);
  if (!key) throw new Error('Hub device assertion key id is not allowlisted');
  if (key.status === 'revoked') throw new Error('Hub device assertion key is revoked');
  const notBefore = Date.parse(key.notBefore) / 1000;
  const notAfter = Date.parse(key.notAfter) / 1000;
  if (nowSeconds < notBefore || nowSeconds >= notAfter) {
    throw new Error('Hub device assertion key is outside its validity window');
  }
  if (!verify(
    null,
    Buffer.from(`${compact.encodedHeader}.${compact.encodedClaims}`, 'ascii'),
    key.publicKey,
    compact.signature,
  )) {
    throw new Error('Hub device assertion signature is invalid');
  }

  const claims = parseClaims(compact.encodedClaims);
  if (claims.iss !== parsedConfig.issuer) throw new Error('Hub device assertion issuer does not match');
  if (claims.aud !== parsedConfig.audience) throw new Error('Hub device assertion audience does not match');
  if (claims.companion_id !== input.expected.companionId) {
    throw new Error('Hub device assertion companion binding does not match');
  }
  if (claims.device_id !== input.expected.deviceId) {
    throw new Error('Hub device assertion device binding does not match');
  }
  if (claims.enrollment_version !== input.expected.enrollmentVersion) {
    throw new Error('Hub device assertion enrollment version is stale');
  }
  if (input.expected.enrollmentStatus !== 'active') {
    throw new Error('Hub device assertion enrollment is revoked');
  }
  if (claims.iat > nowSeconds + parsedConfig.clockSkewSeconds) {
    throw new Error('Hub device assertion issued-at is in the future');
  }
  if (claims.exp <= nowSeconds - parsedConfig.clockSkewSeconds) {
    throw new Error('Hub device assertion has expired');
  }
  if (claims.exp <= claims.iat || claims.exp - claims.iat > parsedConfig.maxTtlSeconds) {
    throw new Error('Hub device assertion lifetime is invalid');
  }

  const expiresAt = new Date(claims.exp * 1000);
  const replayFenceExpiresAt = new Date(
    (claims.exp + parsedConfig.clockSkewSeconds) * 1000,
  );
  const assertionDigest = createHash('sha256').update(input.token, 'utf8').digest('hex');
  const consumption = await input.replayStore.consume({
    issuer: claims.iss,
    jti: claims.jti,
    assertionDigest,
    deviceId: claims.device_id,
    enrollmentVersion: claims.enrollment_version,
    expiresAt: replayFenceExpiresAt,
  });
  if (consumption.outcome === 'mismatch') {
    throw new Error('Hub device assertion mutated replay was rejected');
  }

  return {
    kind: 'hub_device',
    issuer: claims.iss,
    keyId: header.kid,
    deviceId: claims.device_id,
    enrollmentVersion: claims.enrollment_version,
    enrollmentAssurance: claims.enrollment_assurance,
    ...(claims.place_id ? { placeId: claims.place_id } : {}),
    audience: claims.aud,
    companionId: claims.companion_id,
    sessionId: claims.session_id,
    issuedAt: new Date(claims.iat * 1000),
    expiresAt,
    jti: claims.jti,
  };
}

interface ParsedVerifierConfig extends Omit<HubDeviceAssertionVerifierConfig, 'keys'> {
  keys: Array<HubDeviceAssertionVerifierKey & { publicKey: KeyObject }>;
}

function validateVerifierConfig(config: HubDeviceAssertionVerifierConfig): ParsedVerifierConfig {
  const issuer = requireStableId(config.issuer, 'Hub device assertion configured issuer');
  const audience = requireExactHttpsOrigin(config.audience);
  if (!Number.isSafeInteger(config.maxTtlSeconds) || config.maxTtlSeconds < 5 || config.maxTtlSeconds > 60) {
    throw new Error('Hub device assertion max TTL must be an integer between 5 and 60 seconds');
  }
  if (!Number.isSafeInteger(config.clockSkewSeconds)
    || config.clockSkewSeconds < 0
    || config.clockSkewSeconds > 10) {
    throw new Error('Hub device assertion clock skew must be an integer between 0 and 10 seconds');
  }
  if (!Array.isArray(config.keys) || config.keys.length === 0) {
    throw new Error('Hub device assertion public key ring must not be empty');
  }
  const seen = new Set<string>();
  let activeCount = 0;
  const keys = config.keys.map((key, index) => {
    const kid = requireStableId(key.kid, `Hub device assertion keys[${index}].kid`);
    if (seen.has(kid)) throw new Error('Hub device assertion public key ids must be unique');
    seen.add(kid);
    if (!isCanonicalIsoTimestamp(key.notBefore) || !isCanonicalIsoTimestamp(key.notAfter)
      || Date.parse(key.notAfter) <= Date.parse(key.notBefore)) {
      throw new Error(`Hub device assertion keys[${index}] has an invalid validity window`);
    }
    const status: unknown = key.status;
    if (status !== 'active' && status !== 'retiring' && status !== 'revoked') {
      throw new Error(`Hub device assertion keys[${index}] has an invalid status`);
    }
    if (key.status === 'active') activeCount += 1;
    let publicKey: KeyObject;
    try {
      publicKey = createPublicKey(key.publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    } catch {
      throw new Error(`Hub device assertion keys[${index}] must contain a public Ed25519 key`);
    }
    return { ...key, kid, publicKey };
  });
  if (activeCount !== 1) {
    throw new Error('Hub device assertion public key ring must contain exactly one active key');
  }
  return { ...config, issuer, audience, keys };
}

function parseCompactToken(token: string): {
  encodedHeader: string;
  encodedClaims: string;
  signature: Buffer;
} {
  if (typeof token !== 'string' || token.length > 8192) {
    throw new Error('Hub device assertion is malformed');
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some(part => !BASE64URL_PATTERN.test(part))) {
    throw new Error('Hub device assertion compact token is malformed');
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const signature = decodeCanonicalBase64url(encodedSignature, 'signature');
  if (signature.length !== 64) throw new Error('Hub device assertion signature is malformed');
  return { encodedHeader, encodedClaims, signature };
}

function parseHeader(encoded: string): { kid: string } {
  const header = parseCanonicalJson(encoded, 'protected header');
  assertNoUnknownKeys(header, HEADER_KEYS, 'Hub device assertion protected header');
  requireKeys(header, HEADER_KEYS, 'protected header');
  if (header.alg !== 'EdDSA' || header.typ !== 'PSFN-HUB-DEVICE' || header.v !== 1) {
    throw new Error('Hub device assertion protected header is unsupported');
  }
  const kid = requireToken(header.kid, 'Hub device assertion protected header kid');
  const canonical = { alg: 'EdDSA', typ: 'PSFN-HUB-DEVICE', v: 1, kid };
  if (Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url') !== encoded) {
    throw new Error('Hub device assertion protected header is not in protocol canonical order');
  }
  return { kid };
}

interface ParsedClaims {
  iss: string;
  device_id: string;
  enrollment_version: number;
  enrollment_assurance: 'device_credential';
  place_id?: string;
  aud: string;
  companion_id: string;
  session_id: string;
  iat: number;
  exp: number;
  jti: string;
}

function parseClaims(encoded: string): ParsedClaims {
  const claims = parseCanonicalJson(encoded, 'claims');
  const unknown = Object.keys(claims).filter(key => !CLAIM_KEYS.includes(key as typeof CLAIM_KEYS[number]));
  if (unknown.length > 0) throw new Error(`Hub device assertion has unknown claim: ${unknown.join(', ')}`);
  requireKeys(claims, REQUIRED_CLAIM_KEYS, 'claims');
  const enrollmentVersion = requirePositiveInteger(claims.enrollment_version, 'enrollment_version');
  const iat = requirePositiveInteger(claims.iat, 'iat');
  const exp = requirePositiveInteger(claims.exp, 'exp');
  if (claims.enrollment_assurance !== 'device_credential') {
    throw new Error('Hub device assertion enrollment assurance is unsupported');
  }
  const companionId = requireToken(claims.companion_id, 'Hub device assertion companion_id');
  const jti = requireToken(claims.jti, 'Hub device assertion jti');
  if (!isRfc4122Uuid(companionId) || !isRfc4122Uuid(jti)) {
    throw new Error('Hub device assertion companion_id and jti must be lowercase RFC-4122 UUIDs');
  }
  const parsed: ParsedClaims = {
    iss: requireToken(claims.iss, 'Hub device assertion iss'),
    device_id: requireToken(claims.device_id, 'Hub device assertion device_id'),
    enrollment_version: enrollmentVersion,
    enrollment_assurance: claims.enrollment_assurance,
    ...(claims.place_id === undefined
      ? {}
      : { place_id: requireToken(claims.place_id, 'Hub device assertion place_id') }),
    aud: requireToken(claims.aud, 'Hub device assertion aud'),
    companion_id: companionId,
    session_id: requireToken(claims.session_id, 'Hub device assertion session_id'),
    iat,
    exp,
    jti,
  };
  if (Buffer.from(JSON.stringify(parsed), 'utf8').toString('base64url') !== encoded) {
    throw new Error('Hub device assertion claims are not in protocol canonical order');
  }
  return parsed;
}

function parseCanonicalJson(encoded: string, field: string): Record<string, unknown> {
  const decoded = decodeCanonicalBase64url(encoded, field);
  let value: unknown;
  try {
    value = JSON.parse(decoded.toString('utf8'));
  } catch {
    throw new Error(`Hub device assertion ${field} is malformed JSON`);
  }
  if (!isRecord(value) || Buffer.from(JSON.stringify(value), 'utf8').toString('base64url') !== encoded) {
    throw new Error(`Hub device assertion ${field} is not canonical`);
  }
  return value;
}

function decodeCanonicalBase64url(encoded: string, field: string): Buffer {
  try {
    const value = Buffer.from(encoded, 'base64url');
    if (value.toString('base64url') !== encoded) throw new Error('noncanonical');
    return value;
  } catch {
    throw new Error(`Hub device assertion ${field} is malformed base64url`);
  }
}

function requireKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  const missing = keys.filter(key => !Object.hasOwn(value, key));
  if (missing.length > 0) throw new Error(`Hub device assertion ${field} is missing ${missing.join(', ')}`);
}

function requireToken(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const normalized = value.trim();
  if (!TOKEN_PATTERN.test(normalized) || normalized !== value) {
    throw new Error(`${field} has an invalid format`);
  }
  return normalized;
}

function requireStableId(value: unknown, field: string): string {
  if (typeof value !== 'string' || !STABLE_ID_PATTERN.test(value)) {
    throw new Error(`${field} must use stable identifier characters`);
  }
  return value;
}

function requireExactHttpsOrigin(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Hub device assertion configured audience must be an exact normalized HTTPS origin');
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Hub device assertion configured audience must be an exact normalized HTTPS origin');
  }
  if (parsed.protocol !== 'https:'
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || value.endsWith('/')
    || value !== parsed.origin) {
    throw new Error('Hub device assertion configured audience must be an exact normalized HTTPS origin');
  }
  return parsed.origin;
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new Error(`Hub device assertion ${field} must be a positive integer`);
  }
  return Number(value);
}
