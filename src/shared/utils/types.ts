export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Lowercase RFC-4122 UUID (versions 1-5). */
export const RFC_4122_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isRfc4122Uuid(value: unknown): value is string {
  return typeof value === 'string' && RFC_4122_UUID_PATTERN.test(value);
}

/** Fail closed unless every required key is present and every key is allowlisted. */
export function hasExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => allowed.has(key));
}

/** Bounded non-empty string guard for strict external protocol parsing. */
export function isBoundedString(
  value: unknown,
  maximum = 65_536,
  minimum = 1,
): value is string {
  return typeof value === 'string'
    && value.length >= minimum
    && value.length <= maximum;
}

/** Canonical UTC ISO-8601 timestamp with millisecond precision. */
export function isCanonicalIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const milliseconds = Date.parse(value);
  return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
}

/** Fail closed when an external object contains fields outside its contract. */
export function assertNoUnknownKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  fieldPath: string,
  options: { errorPrefix?: string } = {},
): void {
  const allowed = new Set(allowedKeys);
  const unknown = Object.keys(value).filter(key => !allowed.has(key)).sort();
  if (unknown.length > 0) {
    const prefix = options.errorPrefix ? `${options.errorPrefix}: ` : '';
    throw new Error(`${prefix}${fieldPath} contains unknown keys: ${unknown.join(', ')}`);
  }
}

export interface NormalizeStringArrayOptions {
  errorPrefix?: string;
}

export function normalizeStringArray(
  value: unknown,
  field: string,
  options: NormalizeStringArrayOptions = {},
): string[] {
  const errorPrefix = options.errorPrefix ?? 'Invalid config';

  if (!Array.isArray(value)) {
    throw new Error(`${errorPrefix}: ${field} must be an array`);
  }

  const unique = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') {
      throw new Error(`${errorPrefix}: ${field} items must be strings`);
    }
    const trimmed = item.trim();
    if (!trimmed) continue;
    unique.add(trimmed);
  }

  return [...unique];
}

/**
 * Audited widening seam (bead psfn-framework-aylm.5): view an already-typed
 * plain-data object as a `Record<string, unknown>` for structural walking —
 * e.g. redaction digests over a validated decision union, strict re-parsing
 * of a caller-typed candidate, or persisted-snapshot surgery.
 *
 * This is the type-erasing direction only: property names and types are
 * forgotten and every read comes back as `unknown`, so the view cannot
 * manufacture trust. A caller that needs a typed value back must go through
 * its own validated (or explicitly documented) narrowing seam. It replaces
 * scattered `x as unknown as Record<string, unknown>` casts; keep call sites
 * to plain JSON-ish data (no class instances whose behavior the record view
 * would hide).
 */
export function toRecordView(value: object): Record<string, unknown> {
  return value as Record<string, unknown>;
}
