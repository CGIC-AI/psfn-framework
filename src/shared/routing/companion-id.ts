declare const companionIdBrand: unique symbol;

/**
 * A validated companion routing identity.
 *
 * The brand is compile-time only: JSON and RPC wire values remain strings.
 * Existing deployments support both fleet UUIDs and legacy single-companion
 * identifiers, so the shared routing contract enforces their common invariant:
 * a companion id is a non-empty, trimmed string. Fleet config applies its
 * stricter lowercase RFC-4122 UUID rule before calling this constructor.
 */
export type CompanionId = string & { readonly [companionIdBrand]: true };

export function createCompanionId(
  value: unknown,
  fieldName = 'companionId',
): CompanionId {
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string, got ${JSON.stringify(value)}`);
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${fieldName} must be a non-empty string`);
  }
  return normalized as CompanionId;
}
