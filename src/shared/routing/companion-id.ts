declare const companionIdBrand: unique symbol;
declare const shardCompanionIdBrand: unique symbol;

const SHARD_ID_MAX_LENGTH = 128;
const SHARD_ID_TOKEN_PATTERN = /^[A-Za-z0-9._-]+$/u;

export const LOWERCASE_RFC4122_COMPANION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

/**
 * A validated companion routing identity.
 *
 * The brand is compile-time only: JSON and RPC wire values remain strings.
 * Every deployment is fleet-shaped, including a one-entry fleet for a single
 * companion, so the only accepted wire shape is a lowercase RFC-4122 UUID.
 */
export type CompanionId = string & { readonly [companionIdBrand]: true };

/** A derived shard identity, deliberately not assignable to a core CompanionId. */
export type ShardCompanionId = string & { readonly [shardCompanionIdBrand]: true };

export type RuntimeCompanionId = CompanionId | ShardCompanionId;

/** Shared option contract for boundaries that require a core routing identity. */
export interface CompanionRoutingBinding {
  companionId: CompanionId;
}

/** Shared option contract for boundaries where identity binding is optional. */
export interface OptionalCompanionRoutingBinding {
  companionId?: CompanionId;
}

function isShardIdToken(value: string): boolean {
  return value.length <= SHARD_ID_MAX_LENGTH
    && SHARD_ID_TOKEN_PATTERN.test(value)
    && /[A-Za-z0-9]/u.test(value);
}

/** Parse an untrusted core companion identity without throwing. */
export function parseCompanionId(value: unknown): CompanionId | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  if (!LOWERCASE_RFC4122_COMPANION_ID_PATTERN.test(normalized)) return null;
  return normalized as CompanionId;
}

export function createCompanionId(
  value: unknown,
  fieldName = 'companionId',
): CompanionId {
  const parsed = parseCompanionId(value);
  if (!parsed) {
    throw new Error(
      `${fieldName} must be a lowercase RFC-4122 UUID, got ${JSON.stringify(value)}`,
    );
  }
  return parsed;
}

export function createShardCompanionId(
  value: unknown,
  fieldName = 'shardCompanionId',
): ShardCompanionId {
  if (typeof value !== 'string') {
    throw new Error(
      `${fieldName} must use the existing "<companionId>/shards/<shardId>" `
      + `or "<companionId>::<shardId>" wire format, got ${JSON.stringify(value)}`,
    );
  }
  const normalized = value.trim();
  const separator = normalized.includes('/shards/') ? '/shards/' : '::';
  const parts = normalized.split(separator);
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(
      `${fieldName} must use the existing "<companionId>/shards/<shardId>" `
      + 'or "<companionId>::<shardId>" wire format',
    );
  }
  const coreCompanionId = createCompanionId(parts[0], `${fieldName} core companionId`);
  const shardId = parts[1].trim();
  if (!isShardIdToken(shardId)) {
    throw new Error(
      `${fieldName} shardId must be a 1-${SHARD_ID_MAX_LENGTH} character token `
      + 'containing only letters, digits, ".", "_", or "-"',
    );
  }
  return `${coreCompanionId}${separator}${shardId}` as ShardCompanionId;
}

export function createRuntimeCompanionId(
  value: unknown,
  fieldName = 'companionId',
): RuntimeCompanionId {
  if (typeof value === 'string' && (value.includes('/shards/') || value.includes('::'))) {
    return createShardCompanionId(value, fieldName);
  }
  return createCompanionId(value, fieldName);
}
