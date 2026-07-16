import { createHash, timingSafeEqual } from 'node:crypto';
import type { CompiledGardenRequestTarget } from './request-capability-target.js';
import type {
  RequestCapabilityAuthorityVersions,
  RequestCapabilityParentBinding,
  VerifiedRequestCapability,
} from './request-capability.js';

const DIGEST_PATTERN = /^[0-9a-f]{64}$/u;

export interface RequestCapabilityConsumeResult {
  readonly schemaVersion: 1;
  readonly decision: 'allow';
  readonly requestId: string;
  readonly decisionId: string;
  readonly targetDigest: string;
  readonly audience: string;
  readonly companionId: string;
  readonly parentDigest: string;
  readonly authorityVersionsDigest: string;
  readonly expiresAt: number;
}

export interface RequestCapabilityReplayConsumption {
  readonly issuer: string;
  readonly jti: string;
  readonly capabilityDigest: string;
  readonly targetDigest: string;
  readonly bodyDigest: string;
  readonly audienceDigest: string;
  readonly companionDigest: string;
  readonly actionDigest: string;
  readonly resourceDigest: string;
  readonly parentDigest: string;
  readonly decisionDigest: string;
  readonly authorityVersionsDigest: string;
  readonly expiresAt: Date;
  readonly consumeResult: RequestCapabilityConsumeResult;
}

export type RequestCapabilityReplayOutcome =
  | {
      readonly outcome: 'consumed' | 'replayed';
      readonly result: RequestCapabilityConsumeResult;
    }
  | { readonly outcome: 'mismatch' };

export interface RequestCapabilityReplayPort {
  consume(input: RequestCapabilityReplayConsumption): Promise<RequestCapabilityReplayOutcome>;
}

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function equalDigest(left: string, right: string): boolean {
  if (!DIGEST_PATTERN.test(left) || !DIGEST_PATTERN.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

function canonicalVersions(versions: RequestCapabilityAuthorityVersions): Record<string, number> {
  return {
    authorityGeneration: versions.authorityGeneration,
    globalAuthEpoch: versions.globalAuthEpoch,
    sessionAuthnVersion: versions.sessionAuthnVersion,
    sessionAuthzVersion: versions.sessionAuthzVersion,
    bindingVersion: versions.bindingVersion,
    grantVersion: versions.grantVersion,
    policyVersion: versions.policyVersion,
  };
}

function canonicalParent(parent: RequestCapabilityParentBinding | undefined): unknown {
  if (!parent) return null;
  return {
    audience: parent.audience,
    requestId: parent.requestId,
    decisionId: parent.decisionId,
    jti: parent.jti,
    targetDigest: parent.targetDigest,
  };
}

/**
 * Compile only the shared verifier/compiler outputs. This deliberately does
 * not duplicate or recompute the canonical target digest algorithm.
 */
export function compileRequestCapabilityReplayConsumption(input: {
  readonly token: string;
  readonly verified: VerifiedRequestCapability;
  readonly target: CompiledGardenRequestTarget;
}): RequestCapabilityReplayConsumption {
  const { verified, target } = input;
  if (!input.token || input.token.length > 65_536) {
    throw new Error('Request capability replay token is invalid');
  }
  if (verified.companionId !== target.companionId
    || verified.action !== target.action
    || !equalDigest(verified.bodyDigest, target.bodyDigest)
    || !equalDigest(verified.resourceDigest, target.resourceDigest)
    || !equalDigest(verified.targetDigest, target.targetDigest)) {
    throw new Error('Request capability replay target does not match the verified capability');
  }
  if (!Number.isSafeInteger(verified.expiresAt) || verified.expiresAt < 1) {
    throw new Error('Request capability replay expiry is invalid');
  }
  const parentDigest = digest(JSON.stringify(canonicalParent(verified.parent)));
  const authorityVersionsDigest = digest(JSON.stringify(canonicalVersions(verified.versions)));
  const consumeResult = Object.freeze({
    schemaVersion: 1 as const,
    decision: 'allow' as const,
    requestId: verified.requestId,
    decisionId: verified.decisionId,
    targetDigest: verified.targetDigest,
    audience: verified.audience,
    companionId: verified.companionId,
    parentDigest,
    authorityVersionsDigest,
    expiresAt: verified.expiresAt,
  });
  return Object.freeze({
    issuer: verified.issuer,
    jti: verified.jti,
    capabilityDigest: digest(input.token),
    targetDigest: verified.targetDigest,
    bodyDigest: verified.bodyDigest,
    audienceDigest: digest(verified.audience),
    companionDigest: digest(verified.companionId),
    actionDigest: digest(verified.action),
    resourceDigest: verified.resourceDigest,
    parentDigest,
    decisionDigest: digest(verified.decisionId),
    authorityVersionsDigest,
    expiresAt: new Date(verified.expiresAt * 1_000),
    consumeResult,
  });
}
