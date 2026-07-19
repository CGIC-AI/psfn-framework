import { timingSafeEqual } from 'node:crypto';
import type {
  RequestCapabilityAuthorityVersions,
  RequestCapabilityParentBinding,
} from './request-capability.js';
import { REQUEST_CAPABILITY_ASSERTION_HEADERS } from './request-capability-transport.js';
import type { CompanionId } from '../../shared/routing/companion-id.js';
import { hasExactKeys, isRecord, isRfc4122Uuid } from '../../shared/utils/types.js';

/**
 * Canonical Garden capability envelope shared by every trusted hop that
 * presents a gateway-signed request capability to a Garden admission point:
 * gateway -> fleet Garden, fleet Garden -> agent admin transport, and the
 * single-companion operator surface. One token header plus one canonical,
 * exact-byte context header; there is no alternate transport envelope.
 */
export const GARDEN_CAPABILITY_CONTEXT_HEADER = 'x-psfn-capability-context';
export const GARDEN_CAPABILITY_TOKEN_HEADER = REQUEST_CAPABILITY_ASSERTION_HEADERS[0];

export const GARDEN_CAPABILITY_PROTOCOL_BOUNDS = Object.freeze({
  capabilityLength: 65_536,
  contextLength: 8_192,
});

export interface GardenCapabilityContext {
  readonly requestId: string;
  readonly decisionId: string;
  readonly versions: RequestCapabilityAuthorityVersions;
  readonly parent?: RequestCapabilityParentBinding;
}

function parseVersions(value: unknown): RequestCapabilityAuthorityVersions {
  const keys = [
    'authorityGeneration',
    'globalAuthEpoch',
    'sessionAuthnVersion',
    'sessionAuthzVersion',
    'bindingVersion',
    'grantVersion',
    'policyVersion',
  ] as const;
  if (!isRecord(value) || !hasExactKeys(value, keys)) throw new Error('invalid authority versions');
  for (const key of keys) {
    if (!Number.isSafeInteger(value[key]) || (value[key] as number) < 1) {
      throw new Error('invalid authority versions');
    }
  }
  return Object.freeze({
    authorityGeneration: value.authorityGeneration as number,
    globalAuthEpoch: value.globalAuthEpoch as number,
    sessionAuthnVersion: value.sessionAuthnVersion as number,
    sessionAuthzVersion: value.sessionAuthzVersion as number,
    bindingVersion: value.bindingVersion as number,
    grantVersion: value.grantVersion as number,
    policyVersion: value.policyVersion as number,
  });
}

function parseParent(value: unknown, companionId: CompanionId): RequestCapabilityParentBinding {
  const keys = ['audience', 'requestId', 'decisionId', 'jti', 'targetDigest'] as const;
  if (!isRecord(value)
    || !hasExactKeys(value, keys)
    || value.audience !== `operator:${companionId}`
    || !isRfc4122Uuid(value.requestId)
    || !isRfc4122Uuid(value.decisionId)
    || typeof value.jti !== 'string'
    || value.jti.length < 1
    || value.jti.length > 256
    || typeof value.targetDigest !== 'string'
    || !/^[0-9a-f]{64}$/u.test(value.targetDigest)) {
    throw new Error('invalid parent binding');
  }
  return Object.freeze({
    audience: value.audience as RequestCapabilityParentBinding['audience'],
    requestId: value.requestId,
    decisionId: value.decisionId,
    jti: value.jti,
    targetDigest: value.targetDigest,
  });
}

export function parseGardenCapabilityContext(
  encoded: string,
  companionId: CompanionId,
): GardenCapabilityContext {
  if (!encoded
    || encoded.length > GARDEN_CAPABILITY_PROTOCOL_BOUNDS.contextLength
    || !/^[A-Za-z0-9_-]+$/u.test(encoded)) {
    throw new Error('invalid capability context');
  }
  const raw = Buffer.from(encoded, 'base64url');
  const canonicalEncodedBytes = Buffer.from(raw.toString('base64url'));
  const encodedBytes = Buffer.from(encoded);
  if (canonicalEncodedBytes.byteLength !== encodedBytes.byteLength
    || !timingSafeEqual(canonicalEncodedBytes, encodedBytes)) {
    throw new Error('invalid capability context');
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    throw new Error('invalid capability context');
  }
  if (!isRecord(value)
    || !hasExactKeys(value, value.parent === undefined
      ? ['schemaVersion', 'requestId', 'decisionId', 'versions']
      : ['schemaVersion', 'requestId', 'decisionId', 'versions', 'parent'])
    || value.schemaVersion !== 1
    || !isRfc4122Uuid(value.requestId)
    || !isRfc4122Uuid(value.decisionId)) {
    throw new Error('invalid capability context');
  }
  const context = Object.freeze({
    requestId: value.requestId,
    decisionId: value.decisionId,
    versions: parseVersions(value.versions),
    ...(value.parent === undefined ? {} : { parent: parseParent(value.parent, companionId) }),
  });
  const canonical = encodeGardenCapabilityContext(context);
  if (canonical.length !== encoded.length
    || !timingSafeEqual(Buffer.from(canonical), Buffer.from(encoded))) {
    throw new Error('noncanonical capability context');
  }
  return context;
}

export function encodeGardenCapabilityContext(context: GardenCapabilityContext): string {
  return Buffer.from(JSON.stringify({
    schemaVersion: 1,
    requestId: context.requestId,
    decisionId: context.decisionId,
    versions: {
      authorityGeneration: context.versions.authorityGeneration,
      globalAuthEpoch: context.versions.globalAuthEpoch,
      sessionAuthnVersion: context.versions.sessionAuthnVersion,
      sessionAuthzVersion: context.versions.sessionAuthzVersion,
      bindingVersion: context.versions.bindingVersion,
      grantVersion: context.versions.grantVersion,
      policyVersion: context.versions.policyVersion,
    },
    ...(context.parent ? {
      parent: {
        audience: context.parent.audience,
        requestId: context.parent.requestId,
        decisionId: context.parent.decisionId,
        jti: context.parent.jti,
        targetDigest: context.parent.targetDigest,
      },
    } : {}),
  }), 'utf8').toString('base64url');
}

export function buildGardenCapabilityHeaders(input: {
  token: string;
  context: GardenCapabilityContext;
}): Readonly<Record<string, string>> {
  if (!input.token
    || input.token.length > GARDEN_CAPABILITY_PROTOCOL_BOUNDS.capabilityLength
    || /[\r\n\u0000]/u.test(input.token)) {
    throw new Error('invalid request capability');
  }
  return Object.freeze({
    [GARDEN_CAPABILITY_TOKEN_HEADER]: input.token,
    [GARDEN_CAPABILITY_CONTEXT_HEADER]: encodeGardenCapabilityContext(input.context),
  });
}
