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
import { FLEET_AUTH_ACTIONS, type FleetAuthAction } from '../../system/config/fleet-auth-config.js';
import {
  assertNoUnknownKeys,
  isCanonicalIsoTimestamp,
  isRecord,
  isRfc4122Uuid,
} from '../../shared/utils/types.js';
import {
  GARDEN_FORWARD_METHODS,
  type GardenForwardMethod,
  type GardenResourceArea,
  type GardenWorkspaceScope,
} from './garden-route-capabilities.js';
import type { CompiledGardenRequestTarget } from './request-capability-target.js';

const HEADER_KEYS = ['alg', 'typ', 'v', 'kid'] as const;
const OPERATOR_CLAIM_KEYS = [
  'iss',
  'aud',
  'companion_id',
  'method',
  'path',
  'query',
  'request_target',
  'action',
  'resource',
  'body_digest',
  'body_length',
  'resource_digest',
  'request_id',
  'decision_id',
  'versions',
  'jti',
  'iat',
  'nbf',
  'exp',
  'target_digest',
] as const;
const AGENT_CLAIM_KEYS = [
  ...OPERATOR_CLAIM_KEYS.slice(0, 14),
  'parent',
  ...OPERATOR_CLAIM_KEYS.slice(14),
] as const;
const RESOURCE_KEYS = [
  'schema_version',
  'kind',
  'route_id',
  'scope',
  'area',
  'companion_id',
  'path_params',
  'query',
  'body_digest',
] as const;
const VERSION_KEYS = [
  'authority_generation',
  'global_auth_epoch',
  'session_authn_version',
  'session_authz_version',
  'binding_version',
  'grant_version',
  'policy_version',
] as const;
const PARENT_KEYS = ['aud', 'request_id', 'decision_id', 'jti', 'target_digest'] as const;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;
const STABLE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;
const TOKEN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const METHODS = new Set<string>(GARDEN_FORWARD_METHODS);
const ACTIONS = new Set<string>(FLEET_AUTH_ACTIONS);
const SCOPES = new Set<string>([
  'personal_workspace',
  'governed_shared_workspace',
  'garden_surface',
]);
const RESOURCE_AREAS = new Set<string>([
  'action_pipe',
  'attachments',
  'audit',
  'beads',
  'channels',
  'channel_artifacts',
  'cognitive_security',
  'contacts',
  'devices',
  'filesystem',
  'garden_ui',
  'identity',
  'images',
  'memory',
  'models',
  'personal_settings',
  'scheduler',
  'shared_workspace',
  'shell',
  'skills',
  'telemetry',
  'wiki',
]);

export type RequestCapabilityAudience = `operator:${string}` | `agent:${string}`;

export interface RequestCapabilityAuthorityVersions {
  readonly authorityGeneration: number;
  readonly globalAuthEpoch: number;
  readonly sessionAuthnVersion: number;
  readonly sessionAuthzVersion: number;
  readonly bindingVersion: number;
  readonly grantVersion: number;
  readonly policyVersion: number;
}

export interface RequestCapabilityParentBinding {
  readonly audience: `operator:${string}`;
  readonly requestId: string;
  readonly decisionId: string;
  readonly jti: string;
  readonly targetDigest: string;
}

export interface RequestCapabilityVerifierKey {
  readonly issuer: string;
  readonly kid: string;
  readonly publicKeyPem: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly status: 'active' | 'retiring' | 'revoked';
}

export interface RequestCapabilityVerifierConfig {
  readonly issuer: string;
  readonly maxTtlSeconds: number;
  readonly keys: readonly RequestCapabilityVerifierKey[];
}

export interface GatewayRequestCapabilitySigner {
  signOperator(input: RequestCapabilitySignInput): string;
  signAgent(input: RequestCapabilitySignInput & {
    readonly parent: RequestCapabilityParentBinding;
  }): string;
}

export interface RequestCapabilitySignInput {
  readonly target: CompiledGardenRequestTarget;
  readonly requestId: string;
  readonly decisionId: string;
  readonly versions: RequestCapabilityAuthorityVersions;
}

export interface RequestCapabilityVerifyInput extends RequestCapabilitySignInput {
  readonly token: string;
  readonly nowSeconds?: number;
}

export interface RequestCapabilityVerifier {
  verifyOperator(input: RequestCapabilityVerifyInput): VerifiedRequestCapability;
  verifyAgent(input: RequestCapabilityVerifyInput & {
    readonly parent: RequestCapabilityParentBinding;
  }): VerifiedRequestCapability;
}

export interface VerifiedRequestCapability {
  readonly issuer: string;
  readonly keyId: string;
  readonly audience: RequestCapabilityAudience;
  readonly companionId: string;
  readonly requestId: string;
  readonly decisionId: string;
  readonly jti: string;
  readonly action: FleetAuthAction;
  readonly bodyDigest: string;
  readonly resourceDigest: string;
  readonly versions: RequestCapabilityAuthorityVersions;
  readonly targetDigest: string;
  readonly issuedAt: number;
  readonly notBefore: number;
  readonly expiresAt: number;
  readonly parent?: RequestCapabilityParentBinding;
}

export class RequestCapabilityRejectedError extends Error {
  constructor(message: string) {
    super(`Request capability rejected: ${message}`);
    this.name = 'RequestCapabilityRejectedError';
  }
}

interface RequestCapabilityResourceClaims {
  schema_version: 1;
  kind: 'garden_route';
  route_id: string;
  scope: GardenWorkspaceScope;
  area: GardenResourceArea;
  companion_id: string;
  path_params: Record<string, string>;
  query: Record<string, readonly string[]>;
  body_digest: string;
}

interface RequestCapabilityVersionClaims {
  authority_generation: number;
  global_auth_epoch: number;
  session_authn_version: number;
  session_authz_version: number;
  binding_version: number;
  grant_version: number;
  policy_version: number;
}

interface RequestCapabilityParentClaims {
  aud: `operator:${string}`;
  request_id: string;
  decision_id: string;
  jti: string;
  target_digest: string;
}

interface RequestCapabilityClaims {
  iss: string;
  aud: RequestCapabilityAudience;
  companion_id: string;
  method: GardenForwardMethod;
  path: string;
  query: string;
  request_target: string;
  action: FleetAuthAction;
  resource: RequestCapabilityResourceClaims;
  body_digest: string;
  body_length: number;
  resource_digest: string;
  request_id: string;
  decision_id: string;
  parent?: RequestCapabilityParentClaims;
  versions: RequestCapabilityVersionClaims;
  jti: string;
  iat: number;
  nbf: number;
  exp: number;
  target_digest: string;
}

interface ParsedVerifierKey extends RequestCapabilityVerifierKey {
  publicKey: KeyObject;
  notBeforeSeconds: number;
  notAfterSeconds: number;
}

interface ParsedVerifierConfig {
  issuer: string;
  maxTtlSeconds: number;
  keys: ParsedVerifierKey[];
}

function reject(message: string): never {
  throw new RequestCapabilityRejectedError(message);
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function equalEncodedValue(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, 'ascii');
  const rightBytes = Buffer.from(right, 'ascii');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) return reject(`${field} must be an object`);
  return value;
}

function requireExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  field: string,
): void {
  try {
    assertNoUnknownKeys(value, keys, field);
  } catch {
    return reject(`${field} has an invalid shape`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) reject(`${field} has an invalid shape`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0) return reject(`${field} must be a non-empty string`);
  return value;
}

function requireStableId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!STABLE_ID_PATTERN.test(id)) return reject(`${field} is invalid`);
  return id;
}

function requireTokenId(value: unknown, field: string): string {
  const id = requireString(value, field);
  if (!TOKEN_ID_PATTERN.test(id)) return reject(`${field} is invalid`);
  return id;
}

function requireBoundedString(value: unknown, field: string, maximumLength: number): string {
  const text = requireString(value, field);
  if (text.length > maximumLength) return reject(`${field} is too long`);
  return text;
}

function requireUuid(value: unknown, field: string): string {
  if (!isRfc4122Uuid(value)) return reject(`${field} must be a lowercase RFC-4122 UUID`);
  return value;
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) return reject(`${field} is invalid`);
  return Number(value);
}

function requireDigest(value: unknown, field: string): string {
  const hash = requireString(value, field);
  if (!DIGEST_PATTERN.test(hash)) return reject(`${field} is invalid`);
  return hash;
}

function freezeStringRecord(value: unknown, field: string): Record<string, string> {
  const record = requireRecord(value, field);
  const result: Record<string, string> = {};
  for (const key of Object.keys(record).sort()) {
    if (!key || typeof record[key] !== 'string') return reject(`${field} is invalid`);
    result[key] = record[key];
  }
  return Object.freeze(result);
}

function freezeQueryRecord(value: unknown, field: string): Record<string, readonly string[]> {
  const record = requireRecord(value, field);
  const result: Record<string, readonly string[]> = {};
  for (const key of Object.keys(record).sort()) {
    const values = record[key];
    if (!key || !Array.isArray(values) || values.some(entry => typeof entry !== 'string')) {
      return reject(`${field} is invalid`);
    }
    const sorted = [...values].sort();
    if (sorted.some((entry, index) => entry !== values[index])) return reject(`${field} is not canonical`);
    result[key] = Object.freeze(sorted);
  }
  return Object.freeze(result);
}

function toResourceClaims(target: CompiledGardenRequestTarget): RequestCapabilityResourceClaims {
  return {
    schema_version: 1,
    kind: 'garden_route',
    route_id: target.resource.routeId,
    scope: target.resource.scope,
    area: target.resource.area,
    companion_id: target.resource.companionId,
    path_params: Object.fromEntries(Object.entries(target.resource.pathParams).sort()),
    query: Object.fromEntries(Object.entries(target.resource.query).sort()),
    body_digest: target.resource.bodyDigest,
  };
}

function fromResourceClaims(claims: RequestCapabilityResourceClaims): CompiledGardenRequestTarget['resource'] {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'garden_route',
    routeId: claims.route_id,
    scope: claims.scope,
    area: claims.area,
    companionId: claims.companion_id as CompiledGardenRequestTarget['companionId'],
    pathParams: claims.path_params,
    query: claims.query,
    bodyDigest: claims.body_digest,
  });
}

function toVersionClaims(versions: RequestCapabilityAuthorityVersions): RequestCapabilityVersionClaims {
  return {
    authority_generation: versions.authorityGeneration,
    global_auth_epoch: versions.globalAuthEpoch,
    session_authn_version: versions.sessionAuthnVersion,
    session_authz_version: versions.sessionAuthzVersion,
    binding_version: versions.bindingVersion,
    grant_version: versions.grantVersion,
    policy_version: versions.policyVersion,
  };
}

function toParentClaims(parent: RequestCapabilityParentBinding): RequestCapabilityParentClaims {
  return {
    aud: parent.audience,
    request_id: parent.requestId,
    decision_id: parent.decisionId,
    jti: parent.jti,
    target_digest: parent.targetDigest,
  };
}

function fromParentClaims(parent: RequestCapabilityParentClaims): RequestCapabilityParentBinding {
  return Object.freeze({
    audience: parent.aud,
    requestId: parent.request_id,
    decisionId: parent.decision_id,
    jti: parent.jti,
    targetDigest: parent.target_digest,
  });
}

function assertVersions(versions: RequestCapabilityAuthorityVersions): void {
  requireInteger(versions.authorityGeneration, 'versions.authorityGeneration', 1);
  requireInteger(versions.globalAuthEpoch, 'versions.globalAuthEpoch');
  requireInteger(versions.sessionAuthnVersion, 'versions.sessionAuthnVersion', 1);
  requireInteger(versions.sessionAuthzVersion, 'versions.sessionAuthzVersion', 1);
  requireInteger(versions.bindingVersion, 'versions.bindingVersion', 1);
  requireInteger(versions.grantVersion, 'versions.grantVersion', 1);
  requireInteger(versions.policyVersion, 'versions.policyVersion', 1);
}

function assertParent(parent: RequestCapabilityParentBinding, companionId: string): void {
  if (parent.audience !== `operator:${companionId}`) reject('parent audience does not match');
  requireUuid(parent.requestId, 'parent.requestId');
  requireUuid(parent.decisionId, 'parent.decisionId');
  requireTokenId(parent.jti, 'parent.jti');
  requireDigest(parent.targetDigest, 'parent.targetDigest');
}

function assertTarget(target: CompiledGardenRequestTarget): void {
  const targetSchemaVersion: unknown = target.schemaVersion;
  if (targetSchemaVersion !== 1) reject('target schema is invalid');
  if (!METHODS.has(target.method)) reject('target method is invalid');
  requireUuid(target.companionId, 'target.companionId');
  if (!ACTIONS.has(target.action)) reject('target action is invalid');
  const resourceSchemaVersion: unknown = target.resource.schemaVersion;
  const resourceKind: unknown = target.resource.kind;
  if (resourceSchemaVersion !== 1 || resourceKind !== 'garden_route') {
    reject('target resource schema is invalid');
  }
  if (target.resource.companionId !== target.companionId) reject('target resource companion does not match');
  if (!SCOPES.has(target.resource.scope) || !RESOURCE_AREAS.has(target.resource.area)) {
    reject('target resource type is invalid');
  }
  requireDigest(target.bodyDigest, 'target.bodyDigest');
  if (!equalDigest(target.resource.bodyDigest, target.bodyDigest)) reject('target resource body digest does not match');
  requireInteger(target.bodyLength, 'target.bodyLength');
  if (target.bodyLength !== target.body.byteLength) reject('target body length does not match bytes');
  const actualBodyDigest = createHash('sha256').update(target.body).digest('hex');
  if (!equalDigest(actualBodyDigest, target.bodyDigest)) reject('target body digest does not match bytes');
  const expectedRequestTarget = target.canonicalQuery
    ? `${target.canonicalPath}?${target.canonicalQuery}`
    : target.canonicalPath;
  if (target.canonicalRequestTarget !== expectedRequestTarget) reject('target request path is not canonical');
  const canonicalResource = fromResourceClaims(toResourceClaims(target));
  const resourceDigest = digest(JSON.stringify(canonicalResource));
  if (!equalDigest(target.resourceDigest, resourceDigest)) reject('target resource digest does not match');
  const targetDigest = digest(JSON.stringify({
    schemaVersion: 1,
    method: target.method,
    canonicalRequestTarget: target.canonicalRequestTarget,
    companionId: target.companionId,
    action: target.action,
    resourceDigest,
  }));
  if (!equalDigest(target.targetDigest, targetDigest)) reject('target digest does not match');
}

function buildClaims(input: RequestCapabilitySignInput & {
  audience: RequestCapabilityAudience;
  issuer: string;
  jti: string;
  issuedAt: number;
  expiresAt: number;
  parent?: RequestCapabilityParentBinding;
}): RequestCapabilityClaims {
  const common = {
    iss: input.issuer,
    aud: input.audience,
    companion_id: input.target.companionId,
    method: input.target.method,
    path: input.target.canonicalPath,
    query: input.target.canonicalQuery,
    request_target: input.target.canonicalRequestTarget,
    action: input.target.action,
    resource: toResourceClaims(input.target),
    body_digest: input.target.bodyDigest,
    body_length: input.target.bodyLength,
    resource_digest: input.target.resourceDigest,
    request_id: input.requestId,
    decision_id: input.decisionId,
  };
  return input.parent
    ? {
        ...common,
        parent: toParentClaims(input.parent),
        versions: toVersionClaims(input.versions),
        jti: input.jti,
        iat: input.issuedAt,
        nbf: input.issuedAt,
        exp: input.expiresAt,
        target_digest: input.target.targetDigest,
      }
    : {
        ...common,
        versions: toVersionClaims(input.versions),
        jti: input.jti,
        iat: input.issuedAt,
        nbf: input.issuedAt,
        exp: input.expiresAt,
        target_digest: input.target.targetDigest,
      };
}

function validateSignInput(input: RequestCapabilitySignInput): void {
  assertTarget(input.target);
  requireUuid(input.requestId, 'requestId');
  requireUuid(input.decisionId, 'decisionId');
  assertVersions(input.versions);
}

/** The only exported private-key constructor is explicitly gateway-owned. */
export function createGatewayRequestCapabilitySigner(input: {
  readonly issuer: string;
  readonly kid: string;
  readonly privateKeyPem: string;
  readonly ttlSeconds: number;
  readonly nowSeconds?: () => number;
  readonly generateJti?: () => string;
}): GatewayRequestCapabilitySigner {
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
  const header = { alg: 'EdDSA', typ: 'HOP-RC', v: 1, kid } as const;
  const encodedHeader = Buffer.from(JSON.stringify(header), 'utf8').toString('base64url');
  const issue = (
    signInput: RequestCapabilitySignInput,
    audience: RequestCapabilityAudience,
    parent?: RequestCapabilityParentBinding,
  ): string => {
    validateSignInput(signInput);
    if (parent) assertParent(parent, signInput.target.companionId);
    const issuedAt = input.nowSeconds?.() ?? Math.floor(Date.now() / 1000);
    requireInteger(issuedAt, 'signing time', 1);
    const jti = requireTokenId(input.generateJti?.() ?? randomUUID(), 'generated jti');
    const claims = buildClaims({
      ...signInput,
      audience,
      issuer,
      jti,
      issuedAt,
      expiresAt: issuedAt + input.ttlSeconds,
      ...(parent ? { parent } : {}),
    });
    const encodedClaims = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
    const signingInput = `${encodedHeader}.${encodedClaims}`;
    const signature = sign(null, Buffer.from(signingInput, 'ascii'), privateKey).toString('base64url');
    return `${signingInput}.${signature}`;
  };
  return Object.freeze({
    signOperator: (signInput: RequestCapabilitySignInput) => issue(
      signInput,
      `operator:${signInput.target.companionId}`,
    ),
    signAgent: (signInput: RequestCapabilitySignInput & { parent: RequestCapabilityParentBinding }) => issue(
      signInput,
      `agent:${signInput.target.companionId}`,
      signInput.parent,
    ),
  });
}

function parseVerifierConfig(config: RequestCapabilityVerifierConfig): ParsedVerifierConfig {
  const issuer = requireStableId(config.issuer, 'verifier issuer');
  if (!Number.isSafeInteger(config.maxTtlSeconds)
    || config.maxTtlSeconds < 1
    || config.maxTtlSeconds > 60) {
    reject('verifier max TTL is invalid');
  }
  if (!Array.isArray(config.keys) || config.keys.length === 0) reject('verifier key ring is empty');
  const seen = new Set<string>();
  let activeCount = 0;
  const keys = config.keys.map((key, index): ParsedVerifierKey => {
    if (key.issuer !== issuer) reject(`verifier key ${index} issuer does not match`);
    const kid = requireStableId(key.kid, `verifier key ${index} id`);
    if (seen.has(kid)) reject('verifier key ids must be unique');
    seen.add(kid);
    if (!isCanonicalIsoTimestamp(key.notBefore)
      || !isCanonicalIsoTimestamp(key.notAfter)
      || Date.parse(key.notAfter) <= Date.parse(key.notBefore)) {
      reject(`verifier key ${index} validity window is invalid`);
    }
    if (key.status !== 'active' && key.status !== 'retiring' && key.status !== 'revoked') {
      reject(`verifier key ${index} status is invalid`);
    }
    if (key.status === 'active') activeCount += 1;
    let publicKey: KeyObject;
    try {
      if (key.publicKeyPem.includes('PRIVATE KEY')) throw new Error('private key forbidden');
      publicKey = createPublicKey(key.publicKeyPem);
      if (publicKey.asymmetricKeyType !== 'ed25519') throw new Error('not Ed25519');
    } catch {
      return reject(`verifier key ${index} must contain a public Ed25519 key`);
    }
    return {
      ...key,
      kid,
      publicKey,
      notBeforeSeconds: Date.parse(key.notBefore) / 1000,
      notAfterSeconds: Date.parse(key.notAfter) / 1000,
    };
  });
  if (activeCount !== 1) reject('verifier key ring must contain exactly one active key');
  return { issuer, maxTtlSeconds: config.maxTtlSeconds, keys };
}

function parseCompactToken(compactValue: string): {
  encodedHeader: string;
  encodedClaims: string;
  signature: Buffer;
} {
  if (typeof compactValue !== 'string' || compactValue.length === 0 || compactValue.length > 65_536) {
    return reject('token is malformed');
  }
  const parts = compactValue.split('.');
  if (parts.length !== 3 || parts.some(part => !BASE64URL_PATTERN.test(part))) {
    return reject('token is malformed');
  }
  const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
  const signature = Buffer.from(encodedSignature, 'base64url');
  if (signature.length !== 64 || !equalEncodedValue(signature.toString('base64url'), encodedSignature)) {
    return reject('signature encoding is invalid');
  }
  return { encodedHeader, encodedClaims, signature };
}

function selectVerifierKey(keys: readonly ParsedVerifierKey[], kid: string): ParsedVerifierKey {
  return keys.find(candidate => candidate.kid === kid) ?? reject('key id is not allowlisted');
}

function parseJsonSegment(encoded: string, field: string): Record<string, unknown> {
  const decoded = Buffer.from(encoded, 'base64url');
  if (decoded.toString('base64url') !== encoded) reject(`${field} encoding is invalid`);
  try {
    return requireRecord(JSON.parse(decoded.toString('utf8')) as unknown, field);
  } catch (error) {
    if (error instanceof RequestCapabilityRejectedError) throw error;
    return reject(`${field} JSON is invalid`);
  }
}

function parseHeader(encoded: string): { kid: string } {
  const record = parseJsonSegment(encoded, 'header');
  requireExactKeys(record, HEADER_KEYS, 'header');
  const kid = requireStableId(record.kid, 'header.kid');
  const canonical = { alg: 'EdDSA', typ: 'HOP-RC', v: 1, kid } as const;
  if (record.alg !== canonical.alg || record.typ !== canonical.typ || record.v !== canonical.v) {
    reject('header protocol is invalid');
  }
  if (Buffer.from(JSON.stringify(canonical), 'utf8').toString('base64url') !== encoded) {
    reject('header is not canonical');
  }
  return { kid };
}

function parseResource(value: unknown): RequestCapabilityResourceClaims {
  const record = requireRecord(value, 'claims.resource');
  requireExactKeys(record, RESOURCE_KEYS, 'claims.resource');
  if (record.schema_version !== 1 || record.kind !== 'garden_route') reject('claims.resource schema is invalid');
  const scope = requireString(record.scope, 'claims.resource.scope');
  const area = requireString(record.area, 'claims.resource.area');
  if (!SCOPES.has(scope) || !RESOURCE_AREAS.has(area)) reject('claims.resource type is invalid');
  return {
    schema_version: 1,
    kind: 'garden_route',
    route_id: requireBoundedString(record.route_id, 'claims.resource.route_id', 1024),
    scope: scope as GardenWorkspaceScope,
    area: area as GardenResourceArea,
    companion_id: requireUuid(record.companion_id, 'claims.resource.companion_id'),
    path_params: freezeStringRecord(record.path_params, 'claims.resource.path_params'),
    query: freezeQueryRecord(record.query, 'claims.resource.query'),
    body_digest: requireDigest(record.body_digest, 'claims.resource.body_digest'),
  };
}

function parseVersions(value: unknown): RequestCapabilityVersionClaims {
  const record = requireRecord(value, 'claims.versions');
  requireExactKeys(record, VERSION_KEYS, 'claims.versions');
  return {
    authority_generation: requireInteger(record.authority_generation, 'claims.versions.authority_generation', 1),
    global_auth_epoch: requireInteger(record.global_auth_epoch, 'claims.versions.global_auth_epoch'),
    session_authn_version: requireInteger(record.session_authn_version, 'claims.versions.session_authn_version', 1),
    session_authz_version: requireInteger(record.session_authz_version, 'claims.versions.session_authz_version', 1),
    binding_version: requireInteger(record.binding_version, 'claims.versions.binding_version', 1),
    grant_version: requireInteger(record.grant_version, 'claims.versions.grant_version', 1),
    policy_version: requireInteger(record.policy_version, 'claims.versions.policy_version', 1),
  };
}

function parseParent(value: unknown, companionId: string): RequestCapabilityParentClaims {
  const record = requireRecord(value, 'claims.parent');
  requireExactKeys(record, PARENT_KEYS, 'claims.parent');
  const aud = requireString(record.aud, 'claims.parent.aud');
  if (aud !== `operator:${companionId}`) reject('claims.parent audience does not match');
  return {
    aud: aud as `operator:${string}`,
    request_id: requireUuid(record.request_id, 'claims.parent.request_id'),
    decision_id: requireUuid(record.decision_id, 'claims.parent.decision_id'),
    jti: requireTokenId(record.jti, 'claims.parent.jti'),
    target_digest: requireDigest(record.target_digest, 'claims.parent.target_digest'),
  };
}

function canonicalClaims(claims: RequestCapabilityClaims): RequestCapabilityClaims {
  const common = {
    iss: claims.iss,
    aud: claims.aud,
    companion_id: claims.companion_id,
    method: claims.method,
    path: claims.path,
    query: claims.query,
    request_target: claims.request_target,
    action: claims.action,
    resource: claims.resource,
    body_digest: claims.body_digest,
    body_length: claims.body_length,
    resource_digest: claims.resource_digest,
    request_id: claims.request_id,
    decision_id: claims.decision_id,
  };
  return claims.parent
    ? {
        ...common,
        parent: claims.parent,
        versions: claims.versions,
        jti: claims.jti,
        iat: claims.iat,
        nbf: claims.nbf,
        exp: claims.exp,
        target_digest: claims.target_digest,
      }
    : {
        ...common,
        versions: claims.versions,
        jti: claims.jti,
        iat: claims.iat,
        nbf: claims.nbf,
        exp: claims.exp,
        target_digest: claims.target_digest,
      };
}

function parseClaims(encoded: string, audienceKind: 'operator' | 'agent'): RequestCapabilityClaims {
  const record = parseJsonSegment(encoded, 'claims');
  requireExactKeys(record, audienceKind === 'operator' ? OPERATOR_CLAIM_KEYS : AGENT_CLAIM_KEYS, 'claims');
  const companionId = requireUuid(record.companion_id, 'claims.companion_id');
  const audience = requireString(record.aud, 'claims.aud');
  if (audience !== `${audienceKind}:${companionId}`) reject('claims audience does not match companion');
  const method = requireString(record.method, 'claims.method');
  const action = requireString(record.action, 'claims.action');
  if (!METHODS.has(method) || !ACTIONS.has(action)) reject('claims target vocabulary is invalid');
  const claims: RequestCapabilityClaims = {
    iss: requireStableId(record.iss, 'claims.iss'),
    aud: audience as RequestCapabilityAudience,
    companion_id: companionId,
    method: method as GardenForwardMethod,
    path: requireString(record.path, 'claims.path'),
    query: typeof record.query === 'string' ? record.query : reject('claims.query is invalid'),
    request_target: requireString(record.request_target, 'claims.request_target'),
    action: action as FleetAuthAction,
    resource: parseResource(record.resource),
    body_digest: requireDigest(record.body_digest, 'claims.body_digest'),
    body_length: requireInteger(record.body_length, 'claims.body_length'),
    resource_digest: requireDigest(record.resource_digest, 'claims.resource_digest'),
    request_id: requireUuid(record.request_id, 'claims.request_id'),
    decision_id: requireUuid(record.decision_id, 'claims.decision_id'),
    ...(audienceKind === 'agent' ? { parent: parseParent(record.parent, companionId) } : {}),
    versions: parseVersions(record.versions),
    jti: requireTokenId(record.jti, 'claims.jti'),
    iat: requireInteger(record.iat, 'claims.iat', 1),
    nbf: requireInteger(record.nbf, 'claims.nbf', 1),
    exp: requireInteger(record.exp, 'claims.exp', 1),
    target_digest: requireDigest(record.target_digest, 'claims.target_digest'),
  };
  if (Buffer.from(JSON.stringify(canonicalClaims(claims)), 'utf8').toString('base64url') !== encoded) {
    reject('claims are not canonical');
  }
  return claims;
}

function assertSameVersions(actual: RequestCapabilityVersionClaims, expected: RequestCapabilityAuthorityVersions): void {
  if (JSON.stringify(actual) !== JSON.stringify(toVersionClaims(expected))) reject('authority versions do not match');
}

function assertSameParent(actual: RequestCapabilityParentClaims, expected: RequestCapabilityParentBinding): void {
  if (JSON.stringify(actual) !== JSON.stringify(toParentClaims(expected))) reject('parent binding does not match');
}

function assertClaimsBinding(
  claims: RequestCapabilityClaims,
  expected: RequestCapabilitySignInput,
): void {
  assertTarget(expected.target);
  requireUuid(expected.requestId, 'expected requestId');
  requireUuid(expected.decisionId, 'expected decisionId');
  assertVersions(expected.versions);
  const target = expected.target;
  if (claims.companion_id !== target.companionId
    || claims.method !== target.method
    || claims.path !== target.canonicalPath
    || claims.query !== target.canonicalQuery
    || claims.request_target !== target.canonicalRequestTarget
    || claims.action !== target.action
    || !equalDigest(claims.body_digest, target.bodyDigest)
    || claims.body_length !== target.bodyLength
    || !equalDigest(claims.resource_digest, target.resourceDigest)
    || !equalDigest(claims.target_digest, target.targetDigest)) {
    reject('request target binding does not match');
  }
  if (JSON.stringify(fromResourceClaims(claims.resource)) !== JSON.stringify(target.resource)) {
    reject('request resource binding does not match');
  }
  if (claims.request_id !== expected.requestId || claims.decision_id !== expected.decisionId) {
    reject('request decision binding does not match');
  }
  assertSameVersions(claims.versions, expected.versions);
}

export function createRequestCapabilityVerifier(
  config: RequestCapabilityVerifierConfig,
): RequestCapabilityVerifier {
  const parsedConfig = parseVerifierConfig(config);
  const verifyExpected = (
    input: RequestCapabilityVerifyInput,
    audienceKind: 'operator' | 'agent',
    expectedParent?: RequestCapabilityParentBinding,
  ): VerifiedRequestCapability => {
    const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    requireInteger(nowSeconds, 'verification time', 1);
    const compact = parseCompactToken(input.token);
    const header = parseHeader(compact.encodedHeader);
    const key = selectVerifierKey(parsedConfig.keys, header.kid);
    if (key.status === 'revoked') reject('key is revoked');
    if (nowSeconds < key.notBeforeSeconds || nowSeconds >= key.notAfterSeconds) {
      reject('key is outside its validity window');
    }
    const signingInput = Buffer.from(`${compact.encodedHeader}.${compact.encodedClaims}`, 'ascii');
    if (!verify(null, signingInput, key.publicKey, compact.signature)) reject('signature is invalid');
    const claims = parseClaims(compact.encodedClaims, audienceKind);
    if (claims.iss !== parsedConfig.issuer) reject('issuer does not match');
    if (claims.iat !== claims.nbf
      || claims.exp <= claims.iat
      || claims.exp - claims.iat > parsedConfig.maxTtlSeconds) {
      reject('lifetime is invalid');
    }
    if (claims.nbf > nowSeconds) reject('capability is not active yet');
    if (claims.exp <= nowSeconds) reject('capability has expired');
    if (claims.iat < key.notBeforeSeconds || claims.exp > key.notAfterSeconds) {
      reject('capability is outside the key validity window');
    }
    assertClaimsBinding(claims, input);
    if (audienceKind === 'agent') {
      if (!claims.parent || !expectedParent) reject('agent parent binding is required');
      assertParent(expectedParent, input.target.companionId);
      assertSameParent(claims.parent, expectedParent);
    } else if (claims.parent || expectedParent) {
      reject('operator capabilities must not contain a parent binding');
    }
    return Object.freeze({
      issuer: claims.iss,
      keyId: key.kid,
      audience: claims.aud,
      companionId: claims.companion_id,
      requestId: claims.request_id,
      decisionId: claims.decision_id,
      jti: claims.jti,
      action: claims.action,
      bodyDigest: claims.body_digest,
      resourceDigest: claims.resource_digest,
      versions: Object.freeze({
        authorityGeneration: claims.versions.authority_generation,
        globalAuthEpoch: claims.versions.global_auth_epoch,
        sessionAuthnVersion: claims.versions.session_authn_version,
        sessionAuthzVersion: claims.versions.session_authz_version,
        bindingVersion: claims.versions.binding_version,
        grantVersion: claims.versions.grant_version,
        policyVersion: claims.versions.policy_version,
      }),
      targetDigest: claims.target_digest,
      issuedAt: claims.iat,
      notBefore: claims.nbf,
      expiresAt: claims.exp,
      ...(claims.parent ? { parent: fromParentClaims(claims.parent) } : {}),
    });
  };
  return Object.freeze({
    verifyOperator: (input: RequestCapabilityVerifyInput) => verifyExpected(input, 'operator'),
    verifyAgent: (input: RequestCapabilityVerifyInput & { parent: RequestCapabilityParentBinding }) => (
      verifyExpected(input, 'agent', input.parent)
    ),
  });
}
