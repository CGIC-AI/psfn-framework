import type { ModelUsageEvent } from '../../../shared/telemetry/model-usage.js';

export function optionalText(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length > 0 ? normalized : undefined;
}

export function normalizeTelemetryVisibility(
  value: unknown,
): NonNullable<ModelUsageEvent['telemetryVisibility']> {
  if (value === undefined || value === 'operator_visible') return 'operator_visible';
  if (value === 'companion_private') return 'companion_private';
  throw new Error(`Unsupported model usage telemetry visibility: ${String(value)}`);
}

export function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asNullableNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  const numeric = asNumber(value);
  return Number.isFinite(numeric) ? numeric : undefined;
}

export function nonNegativeInteger(value: unknown): number {
  const numeric = asNumber(value);
  return Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 0;
}

export function inputNonNegativeInteger(
  value: unknown,
  field: string,
  fallback: number = 0,
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || !Number.isInteger(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }
  return value;
}

export function nonNegativeCost(value: unknown): number | undefined {
  const numeric = asNullableNumber(value);
  if (numeric === undefined || numeric < 0) return undefined;
  return numeric;
}

export function inputNonNegativeCost(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite number >= 0`);
  }
  return value;
}

export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== 'object' || value === null) return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .filter(key => record[key] !== undefined)
      .map(key => [key, canonicalize(record[key])]),
  );
}

export function dayKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 10);
}

export function monthKey(timestampMs: number): string {
  return new Date(timestampMs).toISOString().slice(0, 7);
}
