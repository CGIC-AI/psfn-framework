import type {
  AdminAdaptiveToolsData,
  AdminToolAvailabilityStatus,
  RuntimeServiceHealth,
  RuntimeServiceHealthStatus,
} from '$lib/types/tools';

type AdminAdaptiveToolTelemetryEvent = AdminAdaptiveToolsData['recentTelemetry'][number];

export const SERVICE_LABELS: Record<RuntimeServiceHealth['serviceId'], string> = {
  gateway: 'Gateway RPC',
  vault: 'Vault',
  ntfy: 'ntfy',
};

export const HEALTH_LABELS: Record<RuntimeServiceHealthStatus, string> = {
  healthy: 'Healthy',
  degraded: 'Degraded',
  unavailable: 'Unavailable',
  not_applicable: 'N/A',
};

export const HEALTH_BADGE: Record<RuntimeServiceHealthStatus, string> = {
  healthy: 'border-moss-300 bg-moss-100 text-moss-700',
  degraded: 'border-gold-300 bg-gold-100 text-gold-700',
  unavailable: 'border-wilt-300 bg-wilt-100 text-wilt-700',
  not_applicable: 'border-bark-300 bg-bark-100 text-shadow-700',
};

export const AVAILABILITY_LABELS: Record<AdminToolAvailabilityStatus, string> = {
  active: 'Active',
  available: 'Available',
  unavailable: 'Unavailable',
  not_applicable: 'N/A',
};

export const AVAILABILITY_BADGE: Record<AdminToolAvailabilityStatus, string> = {
  active: 'border-petal-300 bg-petal-100 text-petal-700',
  available: 'border-moss-300 bg-moss-100 text-moss-700',
  unavailable: 'border-wilt-300 bg-wilt-100 text-wilt-700',
  not_applicable: 'border-bark-300 bg-bark-100 text-shadow-700',
};

export function formatTimestamp(timestamp: number | undefined): string {
  if (!Number.isFinite(timestamp)) return 'Unknown';
  return new Date(timestamp as number).toLocaleString('en-US', {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

export function availableActionSummary(service: RuntimeServiceHealth): string | null {
  if (!service.availableActions?.length) return null;
  return `Enabled actions: ${service.availableActions.join(', ')}`;
}

export function telemetryEventTitle(event: AdminAdaptiveToolTelemetryEvent): string {
  if (event.type === 'decision') {
    return event.payload.toolName;
  }
  return `${event.payload.counts.total} active tools`;
}

export function telemetryEventDetail(event: AdminAdaptiveToolTelemetryEvent): string {
  if (event.type === 'decision') {
    const reason = event.payload.reason ? ` (${event.payload.reason})` : '';
    return `${event.payload.decision} from ${event.payload.source}${reason}`;
  }
  const skipped = event.payload.skipped.length
    ? `, ${event.payload.skipped.length} skipped`
    : '';
  return `Snapshot: ${event.payload.tools.length} visible${skipped}`;
}

export function telemetryEventMeta(event: AdminAdaptiveToolTelemetryEvent): string {
  const context = event.payload.channelId ?? event.payload.purpose ?? event.payload.callType ?? 'runtime';
  return `${event.type} | ${context}`;
}
