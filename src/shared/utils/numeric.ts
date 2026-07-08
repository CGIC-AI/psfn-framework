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
