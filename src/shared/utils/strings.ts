export function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set([...values].map(value => value.trim()).filter(Boolean))];
}

/**
 * Require a non-empty string, throwing a descriptive error otherwise.
 * Returns the trimmed value so callers do not accidentally retain surrounding
 * whitespace.
 */
export function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

/**
 * Return a non-empty string when `value` is one, otherwise `undefined`.
 */
export function nonEmptyStringOrUndefined(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
