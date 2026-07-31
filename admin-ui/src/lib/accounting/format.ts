import {
  MODEL_USAGE_RETIRED_CHARGE_SURFACE,
  MODEL_USAGE_UNKNOWN_DIMENSION,
  type ModelUsageGroupDimension,
} from '../../../../src/shared/telemetry/model-usage.js';

export const EMPTY_VALUE = '—';

export function formatInteger(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0';
  return new Intl.NumberFormat('en-US').format(value);
}

export function formatUsd(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '$0.00';
  if (value !== 0 && Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDurationMs(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_VALUE;
  if (value < 1_000) return `${Math.round(value)} ms`;
  return `${(value / 1_000).toFixed(2)} s`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY_VALUE;
  return `${value.toFixed(value >= 99.95 ? 0 : 1)}%`;
}

export function formatTimestamp(value: number | undefined, timezone?: string): string {
  if (!value) return EMPTY_VALUE;
  return new Date(value).toLocaleString('en-US', {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function labelDimension(value: string): string {
  return value
    .replace(/_/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, character => character.toUpperCase());
}

export function formatDimensionValue(
  dimension: ModelUsageGroupDimension | undefined,
  value: string,
): string {
  if (value === MODEL_USAGE_UNKNOWN_DIMENSION) return 'Unknown';
  if (
    dimension === 'chargeSurface'
    && value === MODEL_USAGE_RETIRED_CHARGE_SURFACE
  ) {
    return 'Retired / legacy';
  }
  return value;
}

export function shortId(value: string): string {
  return value.length > 18 ? `${value.slice(0, 10)}…${value.slice(-5)}` : value;
}
