import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolSnapshotTelemetry,
} from '../../../agent/adaptive-tools-telemetry.js';
import type { EventBus } from '../../../event-bus.js';
import type { AdaptiveToolsStateProvider } from '../types.js';
import type { AdminToolHealthProvider } from '../tool-health-provider.js';
import type {
  AdminAdaptiveToolTelemetryEvent,
  AdminAdaptiveToolsData,
  AdminAdaptiveToolsService,
  AdminToolFailureEvent,
} from './types.js';
import {
  cloneRuntimeState,
  cloneServiceHealth,
  cloneToolCatalogSnapshot,
  deriveToolHealthViews,
} from './adaptive-tools-runtime.js';

const DEFAULT_RECENT_TELEMETRY_LIMIT = 200;
const DEFAULT_RECENT_FAILURE_LIMIT = 50;

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

export class AdminAdaptiveToolsDataService implements AdminAdaptiveToolsService {
  private readonly telemetryLimit: number;
  private readonly failureLimit: number;
  private readonly recentTelemetry: AdminAdaptiveToolTelemetryEvent[] = [];
  private readonly recentFailures: AdminToolFailureEvent[] = [];

  constructor(private readonly deps: {
    eventBus: EventBus;
    stateProvider?: AdaptiveToolsStateProvider | null;
    toolHealthProvider?: AdminToolHealthProvider | null;
    telemetryLimit?: number;
    failureLimit?: number;
  }) {
    const resolvedLimit = Number.isFinite(deps.telemetryLimit)
      ? Math.max(1, Math.floor(deps.telemetryLimit as number))
      : DEFAULT_RECENT_TELEMETRY_LIMIT;
    this.telemetryLimit = resolvedLimit;
    const resolvedFailureLimit = Number.isFinite(deps.failureLimit)
      ? Math.max(1, Math.floor(deps.failureLimit as number))
      : DEFAULT_RECENT_FAILURE_LIMIT;
    this.failureLimit = resolvedFailureLimit;

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

    this.deps.eventBus.on('agent.tool.end', ({ toolName, channelId, isError, errorMessage }) => {
      if (!isError || !errorMessage?.trim()) return;
      this.pushFailure({
        toolName,
        channelId,
        message: errorMessage.trim(),
        timestamp: Date.now(),
      });
    });
  }

  async getAdaptiveToolsData(): Promise<AdminAdaptiveToolsData> {
    const state = this.deps.stateProvider?.getAdaptiveToolRuntimeState() ?? null;
    const catalog = this.deps.stateProvider?.getToolCatalogSnapshot() ?? null;
    const healthSnapshot = await this.deps.toolHealthProvider?.getRuntimeServiceHealth()
      ?? { checkedAt: Date.now(), services: [] };
    const recentFailures = this.recentFailures
      .slice()
      .sort((left, right) => right.timestamp - left.timestamp)
      .map(entry => ({ ...entry }));

    return {
      state: state ? cloneRuntimeState(state) : null,
      catalog: cloneToolCatalogSnapshot(catalog),
      serviceHealth: cloneServiceHealth(healthSnapshot),
      toolHealth: deriveToolHealthViews({
        catalog,
        state,
        serviceHealth: healthSnapshot.services,
        recentFailures,
      }),
      recentFailures,
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

  private pushFailure(entry: AdminToolFailureEvent): void {
    this.recentFailures.push(entry);
    if (this.recentFailures.length > this.failureLimit) {
      this.recentFailures.splice(0, this.recentFailures.length - this.failureLimit);
    }
  }
}
