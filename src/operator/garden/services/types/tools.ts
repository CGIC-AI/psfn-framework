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
import type { ToolCallOutcome } from '../../../../shared/contracts/tool-call-outcome.js';

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

export interface AdminToolInvocationEvent {
  toolName: string;
  toolCallId: string;
  channelId: string;
  action?: string;
  outcome: ToolCallOutcome;
  /** Compatibility roll-up for existing clients; outcome is authoritative. */
  status: 'ok' | 'error';
  timestamp: number;
  turnId?: string;
  requestId?: string;
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
    /** Legacy Garden wire key retained for mixed-version clients. */
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
  recentInvocations: AdminToolInvocationEvent[];
  recentFailures: AdminToolFailureEvent[];
  recentTelemetry: AdminAdaptiveToolTelemetryEvent[];
}

export interface AdminAdaptiveToolsService {
  getAdaptiveToolsData(): Promise<AdminAdaptiveToolsData>;
  releaseMcp?(serverId?: string): Promise<{ released: true; serverId?: string }>;
}
