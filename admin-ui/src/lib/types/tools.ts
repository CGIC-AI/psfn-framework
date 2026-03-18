export type RuntimeServiceHealthStatus =
  | 'healthy'
  | 'degraded'
  | 'unavailable'
  | 'not_applicable';

export type RuntimeServiceId = 'gateway' | 'vault' | 'ntfy';

export interface RuntimeServiceFailure {
  message: string;
  at: number;
  scope?: string;
}

export interface RuntimeServiceHealth {
  serviceId: RuntimeServiceId;
  status: RuntimeServiceHealthStatus;
  detail: string;
  checkedAt: number;
  availableActions?: string[];
  lastFailure?: RuntimeServiceFailure;
}

export interface RuntimeToolCatalogEntry {
  name: string;
  description: string;
  scope: 'core' | 'extended';
}

export interface RuntimeToolCatalogSnapshot {
  generatedAt: number;
  tools: RuntimeToolCatalogEntry[];
}

export interface AdaptiveToolRuntimeState {
  generatedAt: number;
  coreTools: string[];
  extendedTools: string[];
  promotedToolsConfigured: string[];
  promotedToolsActive: string[];
  promotedToolsSkipped: Array<{
    toolName: string;
    source: string;
    reason: string;
    missingTokens?: string[];
  }>;
  loadedExtendedTools: Array<{
    toolName: string;
    source: string;
    activatedAt: number;
    lastActivatedAt: number;
  }>;
  activeTools: Array<{
    toolName: string;
    source: string;
  }>;
  lastSnapshot: unknown | null;
}

export interface AdminToolFailureEvent {
  toolName: string;
  channelId: string;
  message: string;
  timestamp: number;
}

export type AdminToolAvailabilityStatus =
  | 'active'
  | 'available'
  | 'unavailable'
  | 'not_applicable';

export interface AdminToolAvailabilityView {
  status: AdminToolAvailabilityStatus;
  detail: string;
  source?: string;
}

export interface AdminToolHealthView {
  name: string;
  description: string;
  scope: 'core' | 'extended' | 'conditional';
  health: {
    status: RuntimeServiceHealthStatus;
    detail: string;
  };
  contexts: {
    chat: AdminToolAvailabilityView;
    internalHeartbeat: AdminToolAvailabilityView;
  };
  lastFailure?: AdminToolFailureEvent;
}

export interface AdminAdaptiveToolsData {
  state: AdaptiveToolRuntimeState | null;
  catalog: RuntimeToolCatalogSnapshot | null;
  serviceHealth: RuntimeServiceHealth[];
  toolHealth: AdminToolHealthView[];
  recentFailures: AdminToolFailureEvent[];
  recentTelemetry: Array<Record<string, unknown>>;
}
