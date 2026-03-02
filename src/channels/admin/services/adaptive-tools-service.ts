import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotTelemetry,
} from '../../../agent/adaptive-tools-telemetry.js';
import type { EventBus } from '../../../event-bus.js';
import type { AdaptiveToolsStateProvider } from '../types.js';
import type {
  AdminAdaptiveToolTelemetryEvent,
  AdminAdaptiveToolsData,
  AdminAdaptiveToolsService,
} from './types.js';

const DEFAULT_RECENT_TELEMETRY_LIMIT = 200;

function cloneDecisionTelemetry(payload: AdaptiveToolDecisionTelemetry): AdaptiveToolDecisionTelemetry {
  return {
    ...payload,
    ...(payload.missingTokens ? { missingTokens: [...payload.missingTokens] } : {}),
  };
}

function cloneSnapshotTelemetry(payload: AdaptiveToolSnapshotTelemetry): AdaptiveToolSnapshotTelemetry {
  return {
    ...payload,
    tools: payload.tools.map(tool => ({ ...tool })),
    skipped: payload.skipped.map(skip => ({
      ...skip,
      ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
    })),
    counts: { ...payload.counts },
  };
}

function cloneRuntimeState(state: AdaptiveToolRuntimeState): AdaptiveToolRuntimeState {
  return {
    ...state,
    coreTools: [...state.coreTools],
    extendedTools: [...state.extendedTools],
    promotedToolsConfigured: [...state.promotedToolsConfigured],
    promotedToolsActive: [...state.promotedToolsActive],
    promotedToolsSkipped: state.promotedToolsSkipped.map(entry => ({
      ...entry,
      ...(entry.missingTokens ? { missingTokens: [...entry.missingTokens] } : {}),
    })),
    loadedExtendedTools: state.loadedExtendedTools.map(entry => ({ ...entry })),
    activeTools: state.activeTools.map(entry => ({ ...entry })),
    lastSnapshot: state.lastSnapshot ? cloneSnapshotTelemetry(state.lastSnapshot) : null,
  };
}

export class AdminAdaptiveToolsDataService implements AdminAdaptiveToolsService {
  private readonly telemetryLimit: number;
  private readonly recentTelemetry: AdminAdaptiveToolTelemetryEvent[] = [];

  constructor(private readonly deps: {
    eventBus: EventBus;
    stateProvider?: AdaptiveToolsStateProvider | null;
    telemetryLimit?: number;
  }) {
    const resolvedLimit = Number.isFinite(deps.telemetryLimit)
      ? Math.max(1, Math.floor(deps.telemetryLimit as number))
      : DEFAULT_RECENT_TELEMETRY_LIMIT;
    this.telemetryLimit = resolvedLimit;

    this.deps.eventBus.on('agent.tools.adaptive.decision', (payload) => {
      this.pushTelemetry({
        type: 'decision',
        timestamp: Date.now(),
        payload: cloneDecisionTelemetry(payload),
      });
    });

    this.deps.eventBus.on('agent.tools.adaptive.snapshot', (payload) => {
      this.pushTelemetry({
        type: 'snapshot',
        timestamp: Date.now(),
        payload: cloneSnapshotTelemetry(payload),
      });
    });
  }

  getAdaptiveToolsData(): AdminAdaptiveToolsData {
    const state = this.deps.stateProvider?.getAdaptiveToolRuntimeState() ?? null;
    return {
      state: state ? cloneRuntimeState(state) : null,
      recentTelemetry: this.recentTelemetry.map((entry) => (
        entry.type === 'decision'
          ? {
            ...entry,
            payload: cloneDecisionTelemetry(entry.payload),
          }
          : {
            ...entry,
            payload: cloneSnapshotTelemetry(entry.payload),
          }
      )),
    };
  }

  private pushTelemetry(entry: AdminAdaptiveToolTelemetryEvent): void {
    this.recentTelemetry.push(entry);
    if (this.recentTelemetry.length > this.telemetryLimit) {
      this.recentTelemetry.splice(0, this.recentTelemetry.length - this.telemetryLimit);
    }
  }
}
