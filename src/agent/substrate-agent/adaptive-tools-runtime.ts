import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { CapabilityAccess } from '../../system/capabilities/gate.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { resolveToolRequiredCapabilities } from '../../system/capabilities/requirements.js';
import type { CorrelationMetadata, SubstrateMessage } from '../../shared/contracts/runtime.js';
import { textResultWithError } from '../../tools/results.js';
import type {
  AdaptiveToolActivationSource,
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolSnapshotSkip,
} from '../adaptive-tools-telemetry.js';
import {
  normalizeDeferredToolHandoffIntent,
  normalizeToolNameList,
  type DeferredToolHandoffIntent,
} from '../deferred-tool-handoff.js';
import {
  DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX,
  selectBoundedOverlayCandidates,
  type ExtendedToolAutoloadPolicy,
  type ExtendedToolTurnClass,
} from '../extended-tool-autoload-policy.js';

export interface ExtendedToolActivationResult {
  requestedTools: string[];
  activatedTools: string[];
  alreadyActiveTools: string[];
  missingTools: string[];
}

export interface ExtendedToolActivationOptions {
  source?: Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>;
  correlation?: CorrelationMetadata;
  taskKind?: string | null;
  intent?: string | null;
}

export interface AutoloadTurnOutcome {
  intent: string | null;
  skipped: AdaptiveToolSnapshotSkip[];
}

type AdaptiveDecisionPayload = Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>;

interface ActivateExtendedToolsParams {
  toolNames: readonly string[];
  options?: ExtendedToolActivationOptions;
  extendedTools: readonly AgentTool<any>[];
  trackLoadedExtendedTool: (
    toolName: string,
    source: Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>,
  ) => 'activated' | 'already_active';
  emitAdaptiveToolDecision: (payload: AdaptiveDecisionPayload) => void;
  withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
  applyActiveToolsToAgent: () => void;
}

export function activateExtendedToolsForTurn(params: ActivateExtendedToolsParams): ExtendedToolActivationResult {
  const requestedTools = normalizeToolNameList(params.toolNames);
  const byName = new Set(params.extendedTools.map(tool => tool.name));
  const activatedTools: string[] = [];
  const alreadyActiveTools: string[] = [];
  const missingTools: string[] = [];
  const source = params.options?.source ?? 'extended_loaded';
  const telemetryCorrelation = params.options?.correlation;
  const taskKind = params.options?.taskKind ?? null;
  const intent = params.options?.intent ?? null;

  for (const name of requestedTools) {
    if (!byName.has(name)) {
      missingTools.push(name);
      params.emitAdaptiveToolDecision({
        ...params.withAdaptiveCorrelation(telemetryCorrelation, 'agent.tools.adaptive.decision'),
        toolName: name,
        source,
        decision: 'skipped',
        reason: 'not_registered',
        taskKind,
        intent,
      });
      continue;
    }
    const status = params.trackLoadedExtendedTool(name, source);
    if (status === 'activated') {
      activatedTools.push(name);
    } else {
      alreadyActiveTools.push(name);
    }
    params.emitAdaptiveToolDecision({
      ...params.withAdaptiveCorrelation(telemetryCorrelation, 'agent.tools.adaptive.decision'),
      toolName: name,
      source,
      decision: status,
      reason: status === 'activated' ? 'explicit_activation' : 'already_loaded',
      taskKind,
      intent,
    });
  }

  if (activatedTools.length > 0) {
    params.applyActiveToolsToAgent();
  }

  return {
    requestedTools,
    activatedTools,
    alreadyActiveTools,
    missingTools,
  };
}

interface LoadToolsToolRuntime {
  getExtendedTools: () => readonly AgentTool<any>[];
  getExtendedToolAutoloadPolicy: () => ExtendedToolAutoloadPolicy | null;
  getActiveTurnCorrelation: () => CorrelationMetadata | null;
  getActiveTurnTaskKind: () => string | null;
  getActiveTurnIntent: () => string | null;
  activateExtendedTools: (
    toolNames: readonly string[],
    options?: ExtendedToolActivationOptions,
  ) => ExtendedToolActivationResult;
  resolveSessionChannelId: (channelId: string) => string;
  withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
  emitAdaptiveToolDecision: (payload: AdaptiveDecisionPayload) => void;
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
}

export function createLoadToolsTool(runtime: LoadToolsToolRuntime): AgentTool<any> {
  return {
    name: 'load_tools',
    label: 'load_tools',
    description: 'Load extended tool schemas by name. Call with tool names from the tool directory in your runtime context.',
    parameters: Type.Object({
      tools: Type.Array(Type.String(), { description: 'Names of extended tools to load' }),
      intendedAction: Type.Optional(
        Type.String({
          description:
            'Optional follow-up action to execute after this reply when tools were discovered late.',
        }),
      ),
      deferUntilTurnBoundary: Type.Optional(
        Type.Boolean({
          description:
            'Set true when this tool load was discovered late and the intended action should continue post-reply.',
        }),
      ),
      maxRetries: Type.Optional(
        Type.Number({
          description: 'Optional retry cap for deferred continuation (default: 2, max: 4).',
          minimum: 0,
          maximum: 4,
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      executeParams: {
        tools: string[];
        intendedAction?: string;
        deferUntilTurnBoundary?: boolean;
        maxRetries?: number;
      },
    ): Promise<AgentToolResult<{ isError?: boolean; deferredToolHandoff?: DeferredToolHandoffIntent }>> => {
      const requestedTools = normalizeToolNameList(executeParams.tools);
      const policy = runtime.getExtendedToolAutoloadPolicy();
      const maxPreloadCount = policy?.maxPreloadCount;
      const sameTurnMax = typeof maxPreloadCount === 'number' && Number.isFinite(maxPreloadCount)
        ? Math.max(0, Math.floor(maxPreloadCount))
        : DEFAULT_EXTENDED_TOOL_AUTOLOAD_MAX;
      const sameTurnSelection = selectBoundedOverlayCandidates(
        requestedTools,
        runtime.getExtendedTools().map(tool => tool.name),
        sameTurnMax,
      );
      const overlayEligible = sameTurnSelection.selected;
      const backgroundOnlySkipped = sameTurnSelection.skipped
        .filter(entry => entry.reason === 'not_overlay_eligible')
        .map(entry => entry.toolName);
      const budgetSkipped = sameTurnSelection.skipped
        .filter(entry => entry.reason === 'budget_exhausted')
        .map(entry => entry.toolName);
      const unavailableSkipped = sameTurnSelection.skipped
        .filter(entry => entry.reason === 'not_registered')
        .map(entry => entry.toolName);
      const invalidSkipped = sameTurnSelection.skipped
        .filter(entry => entry.reason === 'invalid_metadata')
        .map(entry => entry.toolName);
      const duplicateSkipped = sameTurnSelection.skipped
        .filter(entry => entry.reason === 'duplicate_candidate')
        .map(entry => entry.toolName);

      for (const entry of sameTurnSelection.skipped) {
        const reason = entry.reason === 'not_overlay_eligible'
          ? 'background_only'
          : entry.reason;
        runtime.emitAdaptiveToolDecision({
          ...runtime.withAdaptiveCorrelation(runtime.getActiveTurnCorrelation() ?? undefined, 'agent.tools.adaptive.decision'),
          toolName: entry.toolName,
          source: 'extended_loaded',
          decision: 'skipped',
          reason,
          taskKind: runtime.getActiveTurnTaskKind(),
          intent: runtime.getActiveTurnIntent(),
        });
      }

      const activation = runtime.activateExtendedTools(overlayEligible, {
        source: 'extended_loaded',
        correlation: runtime.getActiveTurnCorrelation() ?? undefined,
        taskKind: runtime.getActiveTurnTaskKind(),
        intent: runtime.getActiveTurnIntent(),
      });
      const activatedCount = activation.activatedTools.length + activation.alreadyActiveTools.length;
      if (activatedCount > 0 || sameTurnSelection.skipped.length > 0 || activation.missingTools.length > 0) {
        const details: { deferredToolHandoff?: DeferredToolHandoffIntent } = {};
        const contentLines: string[] = [];
        if (activation.activatedTools.length > 0) {
          contentLines.push(
            `Loaded ${activation.activatedTools.length} tools: ${activation.activatedTools.join(', ')}`,
          );
        }
        if (activation.alreadyActiveTools.length > 0) {
          contentLines.push(
            `Already active: ${activation.alreadyActiveTools.join(', ')}`,
          );
        }

        if (activation.missingTools.length > 0) {
          contentLines.push(`Missing tools: ${activation.missingTools.join(', ')}`);
        }
        if (unavailableSkipped.length > 0) {
          contentLines.push(`Unavailable tools: ${unavailableSkipped.join(', ')}`);
        }
        if (backgroundOnlySkipped.length > 0) {
          contentLines.push(
            `Background-only tools not activated in-turn: ${backgroundOnlySkipped.join(', ')}`,
          );
        }
        if (budgetSkipped.length > 0) {
          contentLines.push(
            `Skipped by same-turn overlay budget (${sameTurnSelection.maxCount}): ${budgetSkipped.join(', ')}`,
          );
        }
        if (invalidSkipped.length > 0) {
          contentLines.push(`Ignored invalid tool names: ${invalidSkipped.join(', ')}`);
        }
        if (duplicateSkipped.length > 0) {
          contentLines.push(`Ignored duplicate tool names: ${duplicateSkipped.join(', ')}`);
        }

        const handoffTools = [...new Set([
          ...activation.activatedTools,
          ...activation.alreadyActiveTools,
          ...backgroundOnlySkipped,
          ...budgetSkipped,
        ])];
        const activeCorrelation = runtime.getActiveTurnCorrelation();
        const deferredSessionId = activeCorrelation?.channelId
          ? runtime.resolveSessionChannelId(activeCorrelation.channelId)
          : undefined;
        const deferredToolHandoff = executeParams.deferUntilTurnBoundary
          ? normalizeDeferredToolHandoffIntent({
            toolNames: handoffTools,
            intendedAction: executeParams.intendedAction,
            maxRetries: executeParams.maxRetries,
            ...(deferredSessionId ? { sessionId: deferredSessionId } : {}),
          })
          : null;
        if (deferredToolHandoff) {
          details.deferredToolHandoff = deferredToolHandoff;
          contentLines.push('Queued deferred continuation intent for post-turn execution.');
          for (const toolName of deferredToolHandoff.toolNames) {
            runtime.emitAdaptiveToolDecision({
              ...runtime.withAdaptiveCorrelation(undefined, 'agent.tools.adaptive.decision'),
              toolName,
              source: 'deferred',
              decision: 'queued',
              reason: 'defer_until_turn_boundary',
            });
          }
        } else if (executeParams.deferUntilTurnBoundary) {
          contentLines.push('Deferred continuation skipped: provide a non-empty intendedAction.');
          for (const toolName of handoffTools) {
            runtime.emitAdaptiveToolDecision({
              ...runtime.withAdaptiveCorrelation(undefined, 'agent.tools.adaptive.decision'),
              toolName,
              source: 'deferred',
              decision: 'skipped',
              reason: 'missing_intended_action',
            });
          }
        }

        runtime.emitTelemetry('agent.tools.same_turn_activation', {
          ...runtime.withAdaptiveCorrelation(runtime.getActiveTurnCorrelation() ?? undefined, 'agent.tools.same_turn_activation'),
          timestamp: Date.now(),
          requestedTools,
          overlayEligible,
          activatedTools: activation.activatedTools,
          alreadyActiveTools: activation.alreadyActiveTools,
          missingTools: activation.missingTools,
          skippedBackgroundOnly: backgroundOnlySkipped,
          skippedBudget: budgetSkipped,
          skippedUnavailable: unavailableSkipped,
          skippedInvalid: invalidSkipped,
          skippedDuplicate: duplicateSkipped,
          sameTurnOverlaySelection: sameTurnSelection,
          taskKind: runtime.getActiveTurnTaskKind(),
          intent: runtime.getActiveTurnIntent(),
        });

        return {
          content: [{ type: 'text', text: contentLines.join('\n') }],
          details,
        };
      }
      return textResultWithError(
        `No matching tools found. Available: ${runtime.getExtendedTools().map(t => t.name).join(', ')}`,
        true,
      );
    },
  };
}

interface PreloadExtendedToolsForTurnParams {
  message: SubstrateMessage;
  taskKind: string | undefined;
  correlation: CorrelationMetadata;
  policy: ExtendedToolAutoloadPolicy | null;
  extendedTools: readonly AgentTool<any>[];
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  resolveCapabilityAccess: () => CapabilityAccess;
  trackLoadedExtendedTool: (
    toolName: string,
    source: 'autoload',
  ) => 'activated' | 'already_active';
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  emitAdaptiveToolDecision: (payload: AdaptiveDecisionPayload) => void;
  withCorrelationPurpose: (
    correlation: CorrelationMetadata,
    purpose: string,
  ) => CorrelationMetadata;
  withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
}

export function preloadExtendedToolsForTurn(params: PreloadExtendedToolsForTurnParams): AutoloadTurnOutcome {
  if (!params.policy || params.extendedTools.length === 0) {
    return {
      intent: null,
      skipped: [],
    };
  }

  const boundedMax = Number.isFinite(params.policy.maxPreloadCount)
    ? Math.max(0, Math.floor(params.policy.maxPreloadCount))
    : 0;
  const intent = params.policy.classifyIntent(params.message, params.taskKind);
  const candidateNames = params.policy.getCandidatesForIntent(intent).slice(0, boundedMax);
  const overlayCandidateNames = candidateNames.filter(
    toolName => params.classifyExtendedToolForTurn(toolName) === 'overlay',
  );
  const skippedBackgroundOnly = candidateNames.filter(
    toolName => params.classifyExtendedToolForTurn(toolName) !== 'overlay',
  );
  const overlaySelection = selectBoundedOverlayCandidates(
    candidateNames,
    params.extendedTools.map(tool => tool.name),
    boundedMax,
  );
  if (candidateNames.length === 0) {
    params.emitTelemetry('agent.tools.autoload', {
      channelId: params.message.channelId,
      intent,
      taskKind: params.taskKind ?? null,
      boundedMax,
      candidates: [],
      activated: [],
      alreadyActive: [],
      skippedDenied: [],
      unavailable: [],
      skippedBackgroundOnly: [],
      overlaySelection,
      ...params.withCorrelationPurpose(params.correlation, 'agent.tools.autoload'),
    });
    return {
      intent,
      skipped: [],
    };
  }

  const access = params.resolveCapabilityAccess();
  const catalog = new Map(params.extendedTools.map(tool => [tool.name, tool]));
  const activated: string[] = [];
  const alreadyActive: string[] = [];
  const unavailable: string[] = [];
  const skippedDenied: Array<{ toolName: string; missingTokens: CapabilityToken[] }> = [];
  const skipped: AdaptiveToolSnapshotSkip[] = [];

  for (const toolName of skippedBackgroundOnly) {
    skipped.push({
      toolName,
      source: 'autoload',
      reason: 'background_only',
    });
    params.emitTelemetry('agent.tools.autoload.skipped', {
      channelId: params.message.channelId,
      intent,
      taskKind: params.taskKind ?? null,
      toolName,
      reason: 'background_only',
      ...params.withCorrelationPurpose(params.correlation, 'agent.tools.autoload.skipped'),
    });
    params.emitAdaptiveToolDecision({
      ...params.withAdaptiveCorrelation(params.correlation, 'agent.tools.adaptive.decision'),
      toolName,
      source: 'autoload',
      decision: 'skipped',
      reason: 'background_only',
      taskKind: params.taskKind ?? null,
      intent,
    });
  }

  for (const toolName of overlayCandidateNames) {
    const tool = catalog.get(toolName);
    if (!tool) {
      unavailable.push(toolName);
      skipped.push({
        toolName,
        source: 'autoload',
        reason: 'not_registered',
      });
      params.emitTelemetry('agent.tools.autoload.skipped', {
        channelId: params.message.channelId,
        intent,
        taskKind: params.taskKind ?? null,
        toolName,
        reason: 'not_registered',
        ...params.withCorrelationPurpose(params.correlation, 'agent.tools.autoload.skipped'),
      });
      params.emitAdaptiveToolDecision({
        ...params.withAdaptiveCorrelation(params.correlation, 'agent.tools.adaptive.decision'),
        toolName,
        source: 'autoload',
        decision: 'skipped',
        reason: 'not_registered',
        taskKind: params.taskKind ?? null,
        intent,
      });
      continue;
    }

    const missingTokens = resolveToolRequiredCapabilities(tool, {})
      .filter(token => !access.has(token));
    if (missingTokens.length > 0) {
      skippedDenied.push({ toolName, missingTokens });
      skipped.push({
        toolName,
        source: 'autoload',
        reason: 'capability_denied',
        missingTokens,
      });
      params.emitTelemetry('agent.tools.autoload.skipped', {
        channelId: params.message.channelId,
        intent,
        taskKind: params.taskKind ?? null,
        toolName,
        reason: 'capability_denied',
        missingTokens,
        tier: access.getTier(),
        ...params.withCorrelationPurpose(params.correlation, 'agent.tools.autoload.skipped'),
      });
      params.emitAdaptiveToolDecision({
        ...params.withAdaptiveCorrelation(params.correlation, 'agent.tools.adaptive.decision'),
        toolName,
        source: 'autoload',
        decision: 'skipped',
        reason: 'capability_denied',
        missingTokens,
        taskKind: params.taskKind ?? null,
        intent,
      });
      continue;
    }

    const activationState = params.trackLoadedExtendedTool(tool.name, 'autoload');
    if (activationState === 'already_active') {
      alreadyActive.push(tool.name);
    } else {
      activated.push(tool.name);
    }
    params.emitAdaptiveToolDecision({
      ...params.withAdaptiveCorrelation(params.correlation, 'agent.tools.adaptive.decision'),
      toolName: tool.name,
      source: 'autoload',
      decision: activationState,
      reason: activationState === 'activated' ? 'autoload_candidate' : 'autoload_candidate_already_active',
      taskKind: params.taskKind ?? null,
      intent,
    });
  }

  params.emitTelemetry('agent.tools.autoload', {
    channelId: params.message.channelId,
    intent,
    taskKind: params.taskKind ?? null,
    boundedMax,
    candidates: candidateNames,
    overlayCandidates: overlayCandidateNames,
    activated,
    alreadyActive,
    skippedDenied,
    unavailable,
    skippedBackgroundOnly,
    overlaySelection,
    ...params.withCorrelationPurpose(params.correlation, 'agent.tools.autoload'),
  });

  return {
    intent,
    skipped,
  };
}
