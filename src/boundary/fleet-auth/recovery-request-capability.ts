import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';

const HEADER_KEYS = ['alg', 'typ', 'v', 'kid'] as const;
const CLAIM_KEYS = [
  'kind',
  'iss',
  'aud',
  'companion_id',
  'action',
  'resource',
  'resource_digest',
  'reason_digest',
  'credential_id',
  'authority_floor',
  'authority_floor_digest',
  'request_id',
  'decision_id',
  'jti',
  'iat',
  'nbf',
  'exp',
  'target_digest',
] as const;
const RESOURCE_KEYS = [
  'schema_version',
  'kind',
  'route_id',
  'scope',
  'area',
  'companion_id',
] as const;
const TARGET_RESOURCE_KEYS = [
  'schemaVersion',
  'kind',
  'routeId',
  'scope',
  'area',
  'companionId',
] as const;
const FLOOR_KEYS = [
  'lineage_id',
  'authority_generation',
  'activation_generation',
  'restore_checkpoint',
  'revocation_checkpoint',
] as const;
const TARGET_FLOOR_KEYS = [
  'lineageId',
  'authorityGeneration',
  'activationGeneration',
  'restoreCheckpoint',
  'revocationCheckpoint',
] as const;
const TARGET_KEYS = [
  'schemaVersion',
  'audience',
  'companionId',
  'action',
  'resource',
  'resourceDigest',
  'reasonDigest',
  'credentialId',
  'authorityFloor',
  'authorityFloorDigest',
  'targetDigest',
] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export const TRUSTED_HOST_RECOVERY_ACTION = 'recovery.begin' as const;
export const TRUSTED_HOST_RECOVERY_CONSUME_ROUTE =
  'POST /v1/fleet-auth/garden-recovery/capabilities/consume' as const;

export interface TrustedHostRecoveryAuthorityFloor {
  readonly lineageId: string;
  readonly authorityGeneration: number;
  readonly activationGeneration: number;
  readonly restoreCheckpoint: number;
  readonly revocationCheckpoint: number;
}

export interface TrustedHostRecoveryResource {
  readonly schemaVersion: 1;
  readonly kind: 'garden_recovery';
  readonly routeId: typeof TRUSTED_HOST_RECOVERY_CONSUME_ROUTE;
  readonly scope: 'companion';
  readonly area: 'sessions';
  readonly companionId: string;
}

export interface TrustedHostRecoveryTarget {
  readonly schemaVersion: 1;
  readonly audience: `recovery:${string}`;
  readonly companionId: string;
  readonly action: typeof TRUSTED_HOST_RECOVERY_ACTION;
  readonly resource: TrustedHostRecoveryResource;
  readonly resourceDigest: string;
  readonly reasonDigest: string;
  readonly credentialId: string;
  readonly authorityFloor: TrustedHostRecoveryAuthorityFloor;
  readonly authorityFloorDigest: string;
  readonly targetDigest: string;
}

export interface TrustedHostRecoveryCapabilitySignInput {
  readonly target: TrustedHostRecoveryTarget;
  readonly requestId: string;
  readonly decisionId: string;
}

export interface TrustedHostRecoveryCapabilityVerifyInput {
  readonly token: string;
  readonly target: TrustedHostRecoveryTarget;
  readonly nowSeconds?: number;
}

export interface VerifiedTrustedHostRecoveryCapability {
  readonly kind: 'trusted_host_garden_recovery';
  readonly issuer: string;
  readonly keyId: string;
  readonly audience: `recovery:${string}`;
  readonly companionId: string;
  readonly action: typeof TRUSTED_HOST_RECOVERY_ACTION;
  readonly resource: TrustedHostRecoveryResource;
  readonly resourceDigest: string;
  readonly reasonDigest: string;
  readonly credentialId: string;
  readonly authorityFloor: TrustedHostRecoveryAuthorityFloor;
  readonly authorityFloorDigest: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly jti: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly targetDigest: string;
}

export interface TrustedHostRecoveryCapabilityVerifierKey {
  readonly issuer: string;
  readonly kid: string;
  readonly publicKeyPem: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly status: 'active' | 'retiring' | 'revoked';
}

export interface GatewayTrustedHostRecoveryCapabilitySigner {
  signRecovery(input: TrustedHostRecoveryCapabilitySignInput): string;
}

export interface TrustedHostRecoveryCapabilityVerifier {
  verifyRecovery(
    input: TrustedHostRecoveryCapabilityVerifyInput,
  ): VerifiedTrustedHostRecoveryCapability;
}

interface RecoveryResourceClaims {
  schema_version: 1;
  kind: 'garden_recovery';
  route_id: typeof TRUSTED_HOST_RECOVERY_CONSUME_ROUTE;
  scope: 'companion';
  area: 'sessions';
  companion_id: string;
}

interface RecoveryFloorClaims {
  lineage_id: string;
  authority_generation: number;
  activation_generation: number;
  restore_checkpoint: number;
  revocation_checkpoint: number;
}

interface RecoveryClaims {
  kind: 'trusted_host_garden_recovery';
  iss: string;
  aud: `recovery:${string}`;
  companion_id: string;
  action: typeof TRUSTED_HOST_RECOVERY_ACTION;
  resource: RecoveryResourceClaims;
  resource_digest: string;
  reason_digest: string;
  credential_id: string;
  authority_floor: RecoveryFloorClaims;
  authority_floor_digest: string;
  request_id: string;
  decision_id: string;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  target_digest: string;
}

interface ParsedKey extends TrustedHostRecoveryCapabilityVerifierKey {
  publicKey: KeyObject;
  notBeforeSeconds: number;
  notAfterSeconds: number;
}

export class TrustedHostRecoveryCapabilityRejectedError extends Error {
  constructor(message: string) {
    super(`Trusted-host recovery capability rejected: ${message}`);
    this.name = 'TrustedHostRecoveryCapabilityRejectedError';
  }
}

function reject(message: string): never {
  throw new TrustedHostRecoveryCapabilityRejectedError(message);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  try {
    assertNoUnknownKeys(value, keys, field);
  } catch {
    reject(`${field} has an invalid shape`);
  }
  if (keys.some(key => !Object.hasOwn(value, key))) reject(`${field} has an invalid shape`);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) return reject(`${field} must be an object`);
  return value;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) return reject(`${field} is invalid`);
  return value;
}

function requireStableId(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!STABLE_ID_PATTERN.test(result)) reject(`${field} is invalid`);
  return result;
}

function requireTokenId(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!TOKEN_ID_PATTERN.test(result)) reject(`${field} is invalid`);
  return result;
}

function requireDigest(value: unknown, field: string): string {
  const result = requireString(value, field);
  if (!DIGEST_PATTERN.test(result)) reject(`${field} is invalid`);
  return result;
}

function requireInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) reject(`${field} is invalid`);
  return Number(value);
}

function requireUuid(value: unknown, field: string): string {
  if (!isRfc4122Uuid(value)) reject(`${field} must be a lowercase RFC-4122 UUID`);
  return value;
}

function canonicalResource(companionId: string): TrustedHostRecoveryResource {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'garden_recovery',
    routeId: TRUSTED_HOST_RECOVERY_CONSUME_ROUTE,
    scope: 'companion',
    area: 'sessions',
    companionId,
  });
}

function assertDedicatedResource(
  value: TrustedHostRecoveryResource,
  companionId: string,
): TrustedHostRecoveryResource {
  const raw = requireRecord(value, 'resource');
  requireExactKeys(raw, TARGET_RESOURCE_KEYS, 'resource');
  if (raw.schemaVersion !== 1
    || raw.kind !== 'garden_recovery'
    || raw.routeId !== TRUSTED_HOST_RECOVERY_CONSUME_ROUTE
    || raw.scope !== 'companion'
    || raw.area !== 'sessions'
    || raw.companionId !== companionId) {
    reject('resource is not the dedicated recovery resource');
  }
  return canonicalResource(companionId);
}

function canonicalFloor(
  floor: TrustedHostRecoveryAuthorityFloor,
): TrustedHostRecoveryAuthorityFloor {
  const raw = requireRecord(floor, 'authorityFloor');
  requireExactKeys(raw, TARGET_FLOOR_KEYS, 'authorityFloor');
  const lineageId = requireDigest(raw.lineageId, 'authorityFloor.lineageId');
  return Object.freeze({
    lineageId,
    authorityGeneration: requireInteger(
      raw.authorityGeneration,
      'authorityFloor.authorityGeneration',
      1,
    ),
    activationGeneration: requireInteger(
      raw.activationGeneration,
      'authorityFloor.activationGeneration',
      1,
    ),
    restoreCheckpoint: requireInteger(
      raw.restoreCheckpoint,
      'authorityFloor.restoreCheckpoint',
      0,
    ),
    revocationCheckpoint: requireInteger(
      raw.revocationCheckpoint,
      'authorityFloor.revocationCheckpoint',
      0,
    ),
  });
}

export function compileTrustedHostRecoveryTarget(input: {
  readonly companionId: string;
  readonly action: typeof TRUSTED_HOST_RECOVERY_ACTION;
  readonly resource: TrustedHostRecoveryResource;
  readonly reason: string;
  readonly credentialId: string;
  readonly authorityFloor: TrustedHostRecoveryAuthorityFloor;
}): TrustedHostRecoveryTarget {
  const companionId = requireUuid(input.companionId, 'companionId');
  if (String(input.action) !== TRUSTED_HOST_RECOVERY_ACTION) reject('action is not recoverable');
  const expectedResource = assertDedicatedResource(input.resource, companionId);
  if (!input.reason || input.reason.length > 1_024 || input.reason.trim() !== input.reason) {
    reject('reason must be an exact non-empty string of at most 1024 characters');
  }
  const credentialId = requireDigest(input.credentialId, 'credentialId');
  const authorityFloor = canonicalFloor(input.authorityFloor);
  const resourceDigest = digest(JSON.stringify(expectedResource));
  const reasonDigest = digest(input.reason);
  const authorityFloorDigest = digest(JSON.stringify(authorityFloor));
  const audience = `recovery:${companionId}` as const;
  const targetDigest = digest(JSON.stringify({
    schemaVersion: 1,
    audience,
    companionId,
    action: TRUSTED_HOST_RECOVERY_ACTION,
    resourceDigest,
    reasonDigest,
    credentialId,
    authorityFloorDigest,
  }));
  return Object.freeze({
    schemaVersion: 1,
    audience,
    companionId,
    action: TRUSTED_HOST_RECOVERY_ACTION,
    resource: expectedResource,
    resourceDigest,
    reasonDigest,
    credentialId,
    authorityFloor,
    authorityFloorDigest,
    targetDigest,
  });
}

export function trustedHostRecoveryResource(companionId: string): TrustedHostRecoveryResource {
  return canonicalResource(requireUuid(companionId, 'companionId'));
}

function toResourceClaims(resource: TrustedHostRecoveryResource): RecoveryResourceClaims {
  return {
    schema_version: 1,
    kind: 'garden_recovery',
    route_id: resource.routeId,
    scope: 'companion',
    area: 'sessions',
    companion_id: resource.companionId,
  };
}

function fromResourceClaims(resource: RecoveryResourceClaims): TrustedHostRecoveryResource {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'garden_recovery',
    routeId: resource.route_id,
    scope: 'companion',
    area: 'sessions',
    companionId: resource.companion_id,
  });
}

function toFloorClaims(floor: TrustedHostRecoveryAuthorityFloor): RecoveryFloorClaims {
  return {
    lineage_id: floor.lineageId,
    authority_generation: floor.authorityGeneration,
    activation_generation: floor.activationGeneration,
    restore_checkpoint: floor.restoreCheckpoint,
    revocation_checkpoint: floor.revocationCheckpoint,
  };
}

function fromFloorClaims(floor: RecoveryFloorClaims): TrustedHostRecoveryAuthorityFloor {
  return Object.freeze({
    lineageId: floor.lineage_id,
    authorityGeneration: floor.authority_generation,
    activationGeneration: floor.activation_generation,
    restoreCheckpoint: floor.restore_checkpoint,
    revocationCheckpoint: floor.revocation_checkpoint,
  });
}

function parseCanonicalSegment(encoded: string, field: string): Record<string, unknown> {
  if (!encoded || encoded.length > 65_536 || !BASE64URL_PATTERN.test(encoded)) {
    reject(`${field} is malformed`);
  }
  const bytes = Buffer.from(encoded, 'base64url');
  const canonical = bytes.toString('base64url');
  if (canonical.length !== encoded.length
    || !timingSafeEqual(Buffer.from(canonical, 'ascii'), Buffer.from(encoded, 'ascii'))) {
    reject(`${field} is not canonical`);
  }
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8')) as unknown;
  } catch {
    return reject(`${field} is not JSON`);
  }
  return requireRecord(value, field);
}

function parseClaims(encoded: string): RecoveryClaims {
  const raw = parseCanonicalSegment(encoded, 'claims');
  requireExactKeys(raw, CLAIM_KEYS, 'claims');
  if (raw.kind !== 'trusted_host_garden_recovery') reject('kind is invalid');
  const companionId = requireUuid(raw.companion_id, 'claims.companion_id');
  const audience = requireString(raw.aud, 'claims.aud');
  if (audience !== `recovery:${companionId}`) reject('audience is invalid');
  if (raw.action !== TRUSTED_HOST_RECOVERY_ACTION) reject('action is invalid');
  const resource = requireRecord(raw.resource, 'claims.resource');
  requireExactKeys(resource, RESOURCE_KEYS, 'claims.resource');
  if (resource.schema_version !== 1
    || resource.kind !== 'garden_recovery'
    || resource.route_id !== TRUSTED_HOST_RECOVERY_CONSUME_ROUTE
    || resource.scope !== 'companion'
    || resource.area !== 'sessions'
    || resource.companion_id !== companionId) {
    reject('resource is invalid');
  }
  const floor = requireRecord(raw.authority_floor, 'claims.authority_floor');
  requireExactKeys(floor, FLOOR_KEYS, 'claims.authority_floor');
  const claims: RecoveryClaims = {
    kind: 'trusted_host_garden_recovery',
    iss: requireStableId(raw.iss, 'claims.iss'),
    aud: audience as RecoveryClaims['aud'],
    companion_id: companionId,
    action: TRUSTED_HOST_RECOVERY_ACTION,
    resource: {
      schema_version: 1,
      kind: 'garden_recovery',
      route_id: TRUSTED_HOST_RECOVERY_CONSUME_ROUTE,
      scope: 'companion',
      area: 'sessions',
      companion_id: companionId,
    },
    resource_digest: requireDigest(raw.resource_digest, 'claims.resource_digest'),
    reason_digest: requireDigest(raw.reason_digest, 'claims.reason_digest'),
    credential_id: requireDigest(raw.credential_id, 'claims.credential_id'),
    authority_floor: {
      lineage_id: requireDigest(floor.lineage_id, 'claims.authority_floor.lineage_id'),
      authority_generation: requireInteger(
        floor.authority_generation,
        'claims.authority_floor.authority_generation',
        1,
      ),
      activation_generation: requireInteger(
        floor.activation_generation,
        'claims.authority_floor.activation_generation',
        1,
      ),
      restore_checkpoint: requireInteger(
        floor.restore_checkpoint,
        'claims.authority_floor.restore_checkpoint',
        0,
      ),
      revocation_checkpoint: requireInteger(
        floor.revocation_checkpoint,
        'claims.authority_floor.revocation_checkpoint',
        0,
      ),
    },
    authority_floor_digest: requireDigest(
      raw.authority_floor_digest,
      'claims.authority_floor_digest',
    ),
    request_id: requireUuid(raw.request_id, 'claims.request_id'),
    decision_id: requireUuid(raw.decision_id, 'claims.decision_id'),
    jti: requireTokenId(raw.jti, 'claims.jti'),
    iat: requireInteger(raw.iat, 'claims.iat', 1),
    nbf: requireInteger(raw.nbf, 'claims.nbf', 1),
    exp: requireInteger(raw.exp, 'claims.exp', 1),
    target_digest: requireDigest(raw.target_digest, 'claims.target_digest'),
  };
  if (Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url') !== encoded) {
    reject('claims are not canonical');
  }
  return claims;
}

function assertTarget(target: TrustedHostRecoveryTarget): void {
  const raw = requireRecord(target, 'target');
  requireExactKeys(raw, TARGET_KEYS, 'target');
  if (Number(target.schemaVersion) !== 1) reject('target schema version is invalid');
  const companionId = requireUuid(target.companionId, 'target.companionId');
  if (target.audience !== `recovery:${companionId}`) reject('target audience is invalid');
  if (String(target.action) !== TRUSTED_HOST_RECOVERY_ACTION) reject('target action is invalid');
  const resource = assertDedicatedResource(target.resource, companionId);
  const authorityFloor = canonicalFloor(target.authorityFloor);
  if (JSON.stringify(target.authorityFloor) !== JSON.stringify(authorityFloor)) {
    reject('target authority floor is invalid');
  }
  const resourceDigest = digest(JSON.stringify(resource));
  const authorityFloorDigest = digest(JSON.stringify(authorityFloor));
  if (!equalDigest(target.resourceDigest, resourceDigest)
    || !equalDigest(target.authorityFloorDigest, authorityFloorDigest)) {
    reject('target projection is invalid');
  }
  requireDigest(target.reasonDigest, 'target.reasonDigest');
  requireDigest(target.credentialId, 'target.credentialId');
  const expectedTargetDigest = digest(JSON.stringify({
    schemaVersion: 1,
    audience: target.audience,
    companionId: target.companionId,
    action: target.action,
    resourceDigest: target.resourceDigest,
    reasonDigest: target.reasonDigest,
    credentialId: target.credentialId,
    authorityFloorDigest: target.authorityFloorDigest,
  }));
  if (!equalDigest(target.targetDigest, expectedTargetDigest)) reject('target digest is invalid');
}

export function createGatewayTrustedHostRecoveryCapabilitySigner(input: {
  readonly issuer: string;
  readonly kid: string;
  readonly privateKeyPem: string;
  readonly ttlSeconds: number;
  readonly nowSeconds?: () => number;
  readonly generateJti?: () => string;
}): GatewayTrustedHostRecoveryCapabilitySigner {
  const issuer = requireStableId(input.issuer, 'signer issuer');
  const kid = requireStableId(input.kid, 'signer key id');
  if (!Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 60) {
    reject('signer TTL is invalid');
  }
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(input.privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
  } catch {
    return reject('gateway signer requires an Ed25519 private key');
  }
  const header = { alg: 'EdDSA', typ: 'PSFN-RECOVERY', v: 1, kid } as const;
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  return Object.freeze({
    signRecovery: (signInput: TrustedHostRecoveryCapabilitySignInput): string => {
      assertTarget(signInput.target);
      const requestId = requireUuid(signInput.requestId, 'requestId');
      const decisionId = requireUuid(signInput.decisionId, 'decisionId');
      const issuedAt = input.nowSeconds?.() ?? Math.floor(Date.now() / 1_000);
      requireInteger(issuedAt, 'signing time', 1);
      const jti = requireTokenId(input.generateJti?.() ?? randomUUID(), 'generated jti');
      const claims: RecoveryClaims = {
        kind: 'trusted_host_garden_recovery',
        iss: issuer,
        aud: signInput.target.audience,
        companion_id: signInput.target.companionId,
        action: TRUSTED_HOST_RECOVERY_ACTION,
        resource: toResourceClaims(signInput.target.resource),
        resource_digest: signInput.target.resourceDigest,
        reason_digest: signInput.target.reasonDigest,
        credential_id: signInput.target.credentialId,
        authority_floor: toFloorClaims(signInput.target.authorityFloor),
        authority_floor_digest: signInput.target.authorityFloorDigest,
        request_id: requestId,
        decision_id: decisionId,
        jti,
        iat: issuedAt,
        nbf: issuedAt,
        exp: issuedAt + input.ttlSeconds,
        target_digest: signInput.target.targetDigest,
      };
      const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
      const signingInput = `${encodedHeader}.${encodedClaims}`;
      const signature = sign(null, Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
      return `${signingInput}.${signature}`;
    },
  });
}

function parseKeys(input: {
  issuer: string;
  maxTtlSeconds: number;
  keys: readonly TrustedHostRecoveryCapabilityVerifierKey[];
}): { issuer: string; maxTtlSeconds: number; keys: ParsedKey[] } {
  const issuer = requireStableId(input.issuer, 'verifier issuer');
  if (!Number.isSafeInteger(input.maxTtlSeconds)
    || input.maxTtlSeconds < 1
    || input.maxTtlSeconds > 60
    || !Array.isArray(input.keys)
    || input.keys.length === 0) {
    reject('verifier configuration is invalid');
  }
  const seen = new Set<string>();
  const keys = input.keys.map((key, index): ParsedKey => {
    if (key.issuer !== issuer) reject(`verifier key ${index} issuer does not match`);
    const kid = requireStableId(key.kid, `verifier key ${index} id`);
    if (seen.has(kid)) reject('verifier key ids must be unique');
    seen.add(kid);
    if (!isCanonicalIsoTimestamp(key.notBefore)
      || !isCanonicalIsoTimestamp(key.notAfter)
      || Date.parse(key.notAfter) <= Date.parse(key.notBefore)
      || !['active', 'retiring', 'revoked'].includes(key.status)) {
      reject(`verifier key ${index} metadata is invalid`);
    }
    let publicKey: KeyObject;
    try {
      if (key.publicKeyPem.includes('PRIVATE KEY')) throw new Error('private key forbidden');
      publicKey = createPublicKey(key.publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    } catch {
      return reject(`verifier key ${index} must be a public Ed25519 key`);
    }
    return {
      ...key,
      kid,
      publicKey,
      notBeforeSeconds: Math.floor(Date.parse(key.notBefore) / 1_000),
      notAfterSeconds: Math.floor(Date.parse(key.notAfter) / 1_000),
    };
  });
  return { issuer, maxTtlSeconds: input.maxTtlSeconds, keys };
}

export function createTrustedHostRecoveryCapabilityVerifier(input: {
  readonly issuer: string;
  readonly maxTtlSeconds: number;
  readonly keys: readonly TrustedHostRecoveryCapabilityVerifierKey[];
}): TrustedHostRecoveryCapabilityVerifier {
  const config = parseKeys(input);
  return Object.freeze({
    verifyRecovery: (
      expected: TrustedHostRecoveryCapabilityVerifyInput,
    ): VerifiedTrustedHostRecoveryCapability => {
      assertTarget(expected.target);
      if (!expected.token || expected.token.length > 65_536 || /[\r\n\u0000]/u.test(expected.token)) {
        reject('token is malformed');
      }
      const segments = expected.token.split('.');
      if (segments.length !== 3) reject('token is malformed');
      const [encodedHeader, encodedClaims, encodedSignature] = segments as [string, string, string];
      const header = parseCanonicalSegment(encodedHeader, 'header');
      requireExactKeys(header, HEADER_KEYS, 'header');
      if (header.alg !== 'EdDSA' || header.typ !== 'PSFN-RECOVERY' || header.v !== 1) {
        reject('header is invalid');
      }
      const kid = requireStableId(header.kid, 'header.kid');
      if (Buffer.from(JSON.stringify({
        alg: 'EdDSA', typ: 'PSFN-RECOVERY', v: 1, kid,
      }), 'utf8').toString('base64url') !== encodedHeader) {
        reject('header is not canonical');
      }
      const key = config.keys.find(candidate => candidate.kid === kid);
      if (!key) reject('key is not allowlisted');
      if (key.status === 'revoked') reject('key is revoked');
      if (!BASE64URL_PATTERN.test(encodedSignature) || encodedSignature.length > 256) {
        reject('signature is malformed');
      }
      const signature = Buffer.from(encodedSignature, 'base64url');
      if (signature.toString('base64url') !== encodedSignature) reject('signature is not canonical');
      const nowSeconds = expected.nowSeconds ?? Math.floor(Date.now() / 1_000);
      requireInteger(nowSeconds, 'verification time', 1);
      if (nowSeconds < key.notBeforeSeconds || nowSeconds >= key.notAfterSeconds) {
        reject('key is outside its validity window');
      }
      const signingInput = Buffer.from(`${encodedHeader}.${encodedClaims}`, 'ascii');
      if (!verify(null, signingInput, key.publicKey, signature)) reject('signature is invalid');
      const claims = parseClaims(encodedClaims);
      if (claims.iss !== config.issuer) reject('issuer is invalid');
      if (claims.iat !== claims.nbf
        || claims.exp <= claims.iat
        || claims.exp - claims.iat > config.maxTtlSeconds
        || claims.nbf > nowSeconds
        || claims.iat < key.notBeforeSeconds
        || claims.exp > key.notAfterSeconds) {
        reject('lifetime is invalid');
      }
      if (claims.exp <= nowSeconds) reject('capability has expired');
      const claimedResource = fromResourceClaims(claims.resource);
      const claimedFloor = fromFloorClaims(claims.authority_floor);
      if (claims.aud !== expected.target.audience
        || claims.companion_id !== expected.target.companionId
        || JSON.stringify(claimedResource) !== JSON.stringify(expected.target.resource)
        || JSON.stringify(claimedFloor) !== JSON.stringify(expected.target.authorityFloor)
        || !equalDigest(claims.resource_digest, expected.target.resourceDigest)
        || !equalDigest(claims.reason_digest, expected.target.reasonDigest)
        || !equalDigest(claims.credential_id, expected.target.credentialId)
        || !equalDigest(claims.authority_floor_digest, expected.target.authorityFloorDigest)
        || !equalDigest(claims.target_digest, expected.target.targetDigest)) {
        reject('exact recovery target binding does not match');
      }
      return Object.freeze({
        kind: 'trusted_host_garden_recovery',
        issuer: claims.iss,
        keyId: key.kid,
        audience: claims.aud,
        companionId: claims.companion_id,
        action: TRUSTED_HOST_RECOVERY_ACTION,
        resource: claimedResource,
        resourceDigest: claims.resource_digest,
        reasonDigest: claims.reason_digest,
        credentialId: claims.credential_id,
        authorityFloor: claimedFloor,
        authorityFloorDigest: claims.authority_floor_digest,
        requestId: claims.request_id,
        decisionId: claims.decision_id,
        jti: claims.jti,
        issuedAt: claims.iat,
        notBefore: claims.nbf,
        expiresAt: claims.exp,
        targetDigest: claims.target_digest,
      });
    },
  });
}
