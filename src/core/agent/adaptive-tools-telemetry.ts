import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import type { CorrelationMetadata } from '../../shared/contracts/runtime-base.js';

export type AdaptiveToolCatalogSource =
  | 'core'
  | 'extended';

export type AdaptiveToolCatalogDecision =
  | 'active'
  | 'skipped';

export type AdaptiveToolTelemetryCorrelation = Partial<CorrelationMetadata>;

export interface AdaptiveToolDecisionTelemetry extends AdaptiveToolTelemetryCorrelation {
  timestamp: number;
  toolName: string;
  source: AdaptiveToolCatalogSource;
  decision: AdaptiveToolCatalogDecision;
  reason?: string;
  missingTokens?: CapabilityToken[];
  taskKind?: string | null;
  intent?: string | null;
}

export interface AdaptiveToolSnapshotTool {
  toolName: string;
  source: AdaptiveToolCatalogSource;
}

export interface AdaptiveToolSnapshotSkip {
  toolName: string;
  source: 'extended';
  reason: string;
  missingTokens?: CapabilityToken[];
}

export interface AdaptiveToolSnapshotCounts {
  core: number;
  extended: number;
  total: number;
}

export interface AdaptiveToolSnapshotTelemetry extends AdaptiveToolTelemetryCorrelation {
  timestamp: number;
  tools: AdaptiveToolSnapshotTool[];
  skipped: AdaptiveToolSnapshotSkip[];
  counts: AdaptiveToolSnapshotCounts;
  taskKind?: string | null;
  intent?: string | null;
}

export interface AdaptiveToolRuntimeState {
  generatedAt: number;
  coreTools: string[];
  extendedTools: string[];
  promotedToolsConfigured: string[];
  promotedToolsActive: string[];
  promotedToolsSkipped: AdaptiveToolSnapshotSkip[];
  activeTools: AdaptiveToolSnapshotTool[];
  lastSnapshot: AdaptiveToolSnapshotTelemetry | null;
}
