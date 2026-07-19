import { createHash } from 'node:crypto';
import {
  SHARD_CAPABILITY_DENIAL_MASK,
  SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS,
  type ShardDenialMaskToken,
} from './shard-derivation.js';
import { isCapabilityToken, type CapabilityToken } from './tokens.js';
import { isRecord } from '../../shared/utils/types.js';

export function requiredShardGrantText(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Shard approval grant ${field} must be a non-empty string`);
  }
  return value.trim();
}

export function normalizeShardGrantScope(value: unknown): string {
  return requiredShardGrantText(value, 'scope').replace(/\s+/g, ' ');
}

function canonicalJson(value: unknown): string {
  const visit = (candidate: unknown): unknown => {
    if (
      candidate === null
      || typeof candidate === 'string'
      || typeof candidate === 'boolean'
    ) {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new Error('Shard approval grant params must contain only finite JSON numbers');
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      return candidate.map(visit);
    }
    if (!isRecord(candidate)) {
      throw new Error('Shard approval grant params must be JSON-compatible');
    }
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error('Shard approval grant params must contain only plain JSON objects');
    }
    const normalized = Object.create(null) as Record<string, unknown>;
    for (const key of Object.keys(candidate).sort()) {
      normalized[key] = visit(candidate[key]);
    }
    return normalized;
  };

  return JSON.stringify(visit(value));
}

export function shardGrantDigest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function shardGrantParamsDigest(
  params: Readonly<Record<string, unknown>>,
): string {
  return shardGrantDigest(canonicalJson(params));
}

function isDenialMaskToken(token: CapabilityToken): token is ShardDenialMaskToken {
  return SHARD_CAPABILITY_DENIAL_MASK.includes(token);
}

/**
 * Shared disposition check for all six denial-mask tokens. The authoritative
 * values remain SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS.
 */
export function assertShardTemporaryGrantDisposition(
  token: CapabilityToken,
  mode: 'request' | 'ttl',
): asserts token is ShardDenialMaskToken {
  if (!isCapabilityToken(token) || !isDenialMaskToken(token)) {
    throw new Error(`Capability token "${String(token)}" is not a shard denial-mask token`);
  }
  const disposition = SHARD_MASK_TEMPORARY_GRANT_DISPOSITIONS[token];
  if (mode === 'request' && disposition.requestScoped !== 'human-approval-required') {
    throw new Error(`Capability token "${token}" is not eligible for a shard request grant`);
  }
  if (mode === 'ttl' && disposition.ttl !== 'policy-gated-disabled') {
    throw new Error(`Capability token "${token}" is not eligible for a shard TTL grant`);
  }
}

/**
 * The only currently implemented exceptional action. This trusted mapping
 * prevents a caller from relabelling an unrelated method (for example,
 * memory.delete) as world.control.
 */
export function resolveShardExceptionalAction(
  methodInput: unknown,
  actionInput: unknown,
): {
  readonly token: 'world.control';
  readonly method: 'home_assistant.call_service';
  readonly action: 'home_assistant.control';
} {
  const method = requiredShardGrantText(methodInput, 'method');
  const action = requiredShardGrantText(actionInput, 'action');
  if (method !== 'home_assistant.call_service' || action !== 'home_assistant.control') {
    throw new Error('Operation is not an eligible shard exceptional action');
  }
  assertShardTemporaryGrantDisposition('world.control', 'request');
  return {
    token: 'world.control',
    method,
    action,
  };
}

/**
 * Non-throwing eligibility probe for the approval boundary: true only when the
 * method/action pair is the trusted exceptional-action mapping above. Used to
 * split shard-originated gated dispatches between the exact-once grant path
 * and a fail-closed denial (a shard fence is never auto-cleared).
 */
export function isShardExceptionalAction(
  methodInput: unknown,
  actionInput: unknown,
): boolean {
  try {
    resolveShardExceptionalAction(methodInput, actionInput);
    return true;
  } catch {
    return false;
  }
}
