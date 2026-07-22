import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolSnapshotTelemetry,
} from '../../../core/agent/adaptive-tools-telemetry.js';
import type { EventBus } from '../../../shared/event-bus.js';
import { getCanonicalToolSurface } from '../../../core/agent/tool-surface/registry.js';
import type { AdaptiveToolsStateProvider } from '../admin-contract.js';
import type { AdminToolHealthProvider } from '../tool-health-provider.js';
import type {
  AdminAdaptiveToolTelemetryEvent,
  AdminAdaptiveToolsData,
  AdminAdaptiveToolsService,
  AdminToolFailureEvent,
  AdminToolInvocationEvent,
} from './types.js';
import {
  cloneRuntimeState,
  cloneServiceHealth,
  cloneToolCatalogSnapshot,
  deriveToolInventoryGroups,
  deriveToolHealthViews,
} from './adaptive-tools-runtime.js';

const DEFAULT_RECENT_TELEMETRY_LIMIT = 200;
const DEFAULT_RECENT_FAILURE_LIMIT = 50;
const DEFAULT_RECENT_INVOCATION_LIMIT = 100;
const SAFE_AUDIT_ACTION_PATTERN = /^[a-z][a-z0-9_]{0,79}$/u;

function isDeclaredToolAction(
  stateProvider: AdaptiveToolsStateProvider | null | undefined,
  toolName: string,
  action: string,
): boolean {
  const catalogActions = stateProvider
    ?.getToolCatalogSnapshot()
    .tools.find(tool => tool.name === toolName)
    ?.schema?.actions.map(candidate => candidate.name) ?? [];
  const canonicalActions = getCanonicalToolSurface(toolName)?.actions ?? [];
  return catalogActions.includes(action) || canonicalActions.includes(action);
}

function invocationCorrelationKey(channelId: string, toolCallId: string): string {
  return `${channelId}\u0000${toolCallId}`;
}

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
  private readonly invocationLimit: number;
  private readonly recentTelemetry: AdminAdaptiveToolTelemetryEvent[] = [];
  private readonly recentFailures: AdminToolFailureEvent[] = [];
  // Each invocation carries a monotonic sequence so newest-first ordering is a
  // total order even when two events share a millisecond timestamp. Without it
  // the sort falls back to insertion order only on a tie, so the visible order
  // silently flips whenever the wall clock ticks between two back-to-back
  // events (see psfn-framework-5gg3).
  private readonly recentInvocations: { entry: AdminToolInvocationEvent; sequence: number }[] = [];
  private invocationSequence = 0;
  private readonly pendingActions = new Map<string, { toolName: string; action: string }>();

  constructor(private readonly deps: {
    eventBus: EventBus;
    stateProvider?: AdaptiveToolsStateProvider | null;
    toolHealthProvider?: AdminToolHealthProvider | null;
    telemetryLimit?: number;
    failureLimit?: number;
    invocationLimit?: number;
  }) {
    const resolvedLimit = Number.isFinite(deps.telemetryLimit)
      ? Math.max(1, Math.floor(deps.telemetryLimit as number))
      : DEFAULT_RECENT_TELEMETRY_LIMIT;
    this.telemetryLimit = resolvedLimit;
    const resolvedFailureLimit = Number.isFinite(deps.failureLimit)
      ? Math.max(1, Math.floor(deps.failureLimit as number))
      : DEFAULT_RECENT_FAILURE_LIMIT;
    this.failureLimit = resolvedFailureLimit;
    const resolvedInvocationLimit = Number.isFinite(deps.invocationLimit)
      ? Math.max(1, Math.floor(deps.invocationLimit as number))
      : DEFAULT_RECENT_INVOCATION_LIMIT;
    this.invocationLimit = resolvedInvocationLimit;

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

    this.deps.eventBus.on('agent.toolcall.end', ({ channelId, toolCallId, toolName, arguments: toolArguments }) => {
      const candidateAction = typeof toolArguments.action === 'string'
        ? toolArguments.action.trim()
        : '';
      if (!SAFE_AUDIT_ACTION_PATTERN.test(candidateAction)) return;
      if (!isDeclaredToolAction(this.deps.stateProvider, toolName, candidateAction)) return;
      const action = candidateAction;
      this.pendingActions.set(invocationCorrelationKey(channelId, toolCallId), { toolName, action });
      if (this.pendingActions.size > this.invocationLimit) {
        const oldestKey = this.pendingActions.keys().next().value as string | undefined;
        if (oldestKey) this.pendingActions.delete(oldestKey);
      }
    });

    this.deps.eventBus.on('agent.tool.end', ({
      toolName,
      toolCallId,
      channelId,
      outcome,
      errorMessage,
      turnId,
      requestId,
    }) => {
      const correlationKey = invocationCorrelationKey(channelId, toolCallId);
      const pendingAction = this.pendingActions.get(correlationKey);
      this.pendingActions.delete(correlationKey);
      const action = pendingAction?.toolName === toolName ? pendingAction.action : undefined;
      this.pushInvocation({
        toolName,
        toolCallId,
        channelId,
        ...(action ? { action } : {}),
        outcome,
        status: outcome === 'success' ? 'ok' : 'error',
        timestamp: Date.now(),
        ...(turnId ? { turnId } : {}),
        ...(requestId ? { requestId } : {}),
      });
      if (outcome === 'execution_failure' && errorMessage?.trim()) {
        this.pushFailure({
          toolName,
          channelId,
          message: toolName === 'contact'
            ? 'Contact tool invocation failed.'
            : errorMessage.trim(),
          timestamp: Date.now(),
        });
      }
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
    const recentInvocations = this.recentInvocations
      .slice()
      .sort((left, right) => (
        right.entry.timestamp - left.entry.timestamp
        || right.sequence - left.sequence
      ))
      .map(item => ({ ...item.entry }));
    const toolHealth = deriveToolHealthViews({
      catalog,
      state,
      serviceHealth: healthSnapshot.services,
      recentFailures,
    });

    return {
      state: state ? cloneRuntimeState(state) : null,
      catalog: cloneToolCatalogSnapshot(catalog),
      serviceHealth: cloneServiceHealth(healthSnapshot),
      toolHealth,
      inventory: deriveToolInventoryGroups(toolHealth),
      recentInvocations,
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

  private pushInvocation(entry: AdminToolInvocationEvent): void {
    this.recentInvocations.push({ entry, sequence: this.invocationSequence++ });
    if (this.recentInvocations.length > this.invocationLimit) {
      this.recentInvocations.splice(0, this.recentInvocations.length - this.invocationLimit);
    }
  }
}
