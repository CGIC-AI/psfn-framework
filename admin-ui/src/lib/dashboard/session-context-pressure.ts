import type { DashboardSessionContextPressure } from '$lib/types';

export interface SessionContextPressureView {
  utilizationPct: number;
  hasTelemetry: boolean;
  isOverLimit: boolean;
}

type SessionContextPressureInput = Partial<Record<keyof DashboardSessionContextPressure, unknown>> | null | undefined;

function asNonNegativeFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    return null;
  }
  return value;
}

export function resolveSessionContextPressureView(
  pressure: SessionContextPressureInput,
): SessionContextPressureView {
  const utilizationPct = asNonNegativeFiniteNumber(pressure?.utilizationPct);
  const hasValidTelemetry = pressure?.hasTelemetry === true && utilizationPct !== null;
  if (!hasValidTelemetry) {
    return {
      utilizationPct: 0,
      hasTelemetry: false,
      isOverLimit: false,
    };
  }
  return {
    utilizationPct,
    hasTelemetry: true,
    isOverLimit: utilizationPct > 100,
  };
}
