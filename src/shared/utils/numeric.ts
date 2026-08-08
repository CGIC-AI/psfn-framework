export function clamp(value: unknown, min: number, max: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, candidate));
}

/**
 * Clamp a number between `min` and `max`, mapping `NaN` to the midpoint
 * `(min + max) / 2`. Preserves the historical memory-domain tool/extraction
 * behavior where a missing or unparseable numeric tool argument should resolve
 * to a neutral default rather than the shared `clamp` fallback of `0`.
 */
export function clampWithMidpointNaN(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return (min + max) / 2;
  return Math.max(min, Math.min(max, value));
}

export function clampUnit(value: unknown): number;
export function clampUnit(value: unknown, fallback: number): number;
export function clampUnit(value: unknown, fallback: undefined): number | undefined;
export function clampUnit(value: unknown, fallback?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return arguments.length > 1 ? fallback : 0;
  }
  return Math.max(0, Math.min(1, value));
}

export function clampSigned(value: unknown): number;
export function clampSigned(value: unknown, fallback: number): number;
export function clampSigned(value: unknown, fallback: undefined): number | undefined;
export function clampSigned(value: unknown, fallback?: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return arguments.length > 1 ? fallback : 0;
  }
  return Math.max(-1, Math.min(1, value));
}

/**
 * Coerce a value to a positive integer, or return `undefined` when the value
 * is not a positive integer (or a string representation of one).
 */
export function toPositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    if (!/^[+\-]?\d+$/.test(trimmed)) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    return parsed > 0 ? parsed : undefined;
  }
  return undefined;
}

/**
 * Coerce a finite positive number to a positive integer by flooring it, or
 * return `undefined` when the value is not a finite positive number.
 *
 * Unlike {@link toPositiveInteger}, this accepts non-integer positive numbers
 * and floors them (e.g. `1.9` becomes `1`). It does not parse strings.
 */
export function toFlooredPositiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return undefined;
  }
  return Math.floor(value);
}

/**
 * Return a positive integer coerced from `value`, or `fallback` when the value
 * is missing or not a positive integer.
 */
export function positiveIntegerOr(value: unknown, fallback: number): number {
  return toPositiveInteger(value) ?? fallback;
}

/**
 * Require a positive integer, throwing a descriptive error otherwise.
 */
export function requirePositiveInteger(value: unknown, field: string): number {
  const parsed = toPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${field} must be a positive integer, received ${String(value)}`);
  }
  return parsed;
}
