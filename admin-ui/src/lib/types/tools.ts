import type { AdaptiveToolRuntimeState } from '../../../../src/core/agent/adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogSnapshot } from '../../../../src/core/agent/tool-catalog.js';
import type {
  RuntimeServiceHealth,
  RuntimeServiceHealthStatus,
} from '../../../../src/operator/tool-health/types.js';

export type { AdaptiveToolRuntimeState } from '../../../../src/core/agent/adaptive-tools-telemetry.js';
export type {
  RuntimeToolCatalogEntry,
  RuntimeToolCatalogSnapshot,
} from '../../../../src/core/agent/tool-catalog.js';
export type {
  RuntimeServiceFailure,
  RuntimeServiceHealth,
  RuntimeServiceHealthStatus,
  RuntimeServiceId,
} from '../../../../src/operator/tool-health/types.js';

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

export interface AdminToolInventoryGroup {
  key: string;
  title: string;
  detail: string;
  accent: string;
  tools: AdminToolHealthView[];
}

export interface AdminAdaptiveToolsData {
  state: AdaptiveToolRuntimeState | null;
  catalog: RuntimeToolCatalogSnapshot | null;
  serviceHealth: RuntimeServiceHealth[];
  toolHealth: AdminToolHealthView[];
  inventory: AdminToolInventoryGroup[];
  recentFailures: AdminToolFailureEvent[];
  recentTelemetry: Array<Record<string, unknown>>;
}
