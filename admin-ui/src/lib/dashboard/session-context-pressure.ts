import type { DashboardSessionContextPressure } from '$lib/types';

export interface SessionContextPressureView {
  utilizationPct: number;
  hasTelemetry: boolean;
  isOverLimit: boolean;
}

export function resolveSessionContextPressureView(
  pressure: DashboardSessionContextPressure | null | undefined,
): SessionContextPressureView {
  const hasValidTelemetry = pressure?.hasTelemetry === true
    && Number.isFinite(pressure.utilizationPct)
    && pressure.utilizationPct >= 0;
  if (!hasValidTelemetry) {
    return {
      utilizationPct: 0,
      hasTelemetry: false,
      isOverLimit: false,
    };
  }
  return {
    utilizationPct: pressure.utilizationPct,
    hasTelemetry: true,
    isOverLimit: pressure.utilizationPct > 100,
  };
}
