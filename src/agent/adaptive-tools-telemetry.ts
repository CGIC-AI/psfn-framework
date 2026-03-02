import type { CapabilityToken } from '../capabilities/tokens.js';
import type { ObservabilityCallType } from '../types.js';

export type AdaptiveToolActivationSource =
  | 'core'
  | 'promoted'
  | 'extended_loaded'
  | 'autoload'
  | 'deferred';

export type AdaptiveToolActivationDecision =
  | 'active'
  | 'activated'
  | 'already_active'
  | 'skipped'
  | 'queued'
  | 'executed'
  | 'failed';

export interface AdaptiveToolTelemetryCorrelation {
  turnId?: string;
  requestId?: string;
  channelId?: string;
  callType?: ObservabilityCallType;
  purpose?: string;
}

export interface AdaptiveToolDecisionTelemetry extends AdaptiveToolTelemetryCorrelation {
  timestamp: number;
  toolName: string;
  source: AdaptiveToolActivationSource;
  decision: AdaptiveToolActivationDecision;
  reason?: string;
  missingTokens?: CapabilityToken[];
  taskKind?: string | null;
  intent?: string | null;
}

export interface AdaptiveToolSnapshotTool {
  toolName: string;
  source: AdaptiveToolActivationSource;
}

export interface AdaptiveToolSnapshotSkip {
  toolName: string;
  source: Exclude<AdaptiveToolActivationSource, 'core'>;
  reason: string;
  missingTokens?: CapabilityToken[];
}

export interface AdaptiveToolSnapshotCounts {
  core: number;
  promoted: number;
  extendedLoaded: number;
  autoload: number;
  deferred: number;
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

export interface AdaptiveLoadedExtendedToolState {
  toolName: string;
  source: Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>;
  activatedAt: number;
  lastActivatedAt: number;
}

export interface AdaptiveToolRuntimeState {
  generatedAt: number;
  coreTools: string[];
  extendedTools: string[];
  promotedToolsConfigured: string[];
  promotedToolsActive: string[];
  promotedToolsSkipped: AdaptiveToolSnapshotSkip[];
  loadedExtendedTools: AdaptiveLoadedExtendedToolState[];
  activeTools: AdaptiveToolSnapshotTool[];
  lastSnapshot: AdaptiveToolSnapshotTelemetry | null;
}
