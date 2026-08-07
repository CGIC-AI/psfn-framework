export function clamp(value: unknown, min: number, max: number): number {
  const candidate = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  return Math.max(min, Math.min(max, candidate));
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
