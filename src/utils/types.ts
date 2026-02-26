export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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
