import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotTelemetry,
} from '../../../../core/agent/adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogSnapshot } from '../../../../core/agent/tool-catalog.js';
import type {
  RuntimeServiceHealth,
  RuntimeServiceHealthStatus,
} from '../../../tool-health/types.js';

export type AdminAdaptiveToolTelemetryEvent =
  | {
    type: 'decision';
    timestamp: number;
    payload: AdaptiveToolDecisionTelemetry;
  }
  | {
    type: 'snapshot';
    timestamp: number;
    payload: AdaptiveToolSnapshotTelemetry;
  };

export interface AdminToolFailureEvent {
  toolName: string;
  channelId: string;
  message: string;
  timestamp: number;
}

export interface AdminToolAvailabilityView {
  status: 'active' | 'available' | 'unavailable' | 'not_applicable';
  detail: string;
  source?: string;
}

export interface AdminToolHealthView {
  name: string;
  description: string;
  scope: 'core' | 'extended' | 'conditional';
  schema?: RuntimeToolCatalogSnapshot['tools'][number]['schema'];
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
  recentTelemetry: AdminAdaptiveToolTelemetryEvent[];
}

export interface AdminAdaptiveToolsService {
  getAdaptiveToolsData(): Promise<AdminAdaptiveToolsData>;
}
