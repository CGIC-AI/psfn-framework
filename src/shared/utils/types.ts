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
