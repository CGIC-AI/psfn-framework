import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { CapabilityAccess } from '../../capabilities/gate.js';
import type { CapabilityToken } from '../../capabilities/tokens.js';
import { resolveToolRequiredCapabilities } from '../../capabilities/requirements.js';
import type {
  CorrelationMetadata,
  SubstrateMessage,
} from '../../types.js';
import { textResultWithError } from '../../tools/results.js';
import type {
  AdaptiveToolActivationSource,
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
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

export interface ToolSearchResultEntry {
  name: string;
  description: string;
  scope: 'extended';
  turnClass: ExtendedToolTurnClass;
  status: 'active' | 'available' | 'background_only';
  activationHint: string;
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

function normalizeToolSearchQuery(query: unknown): string {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

function scoreToolSearchMatch(
  tool: AgentTool<any>,
  query: string,
): number {
  if (!query) return 0;

  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  const tokens = query.split(/\s+/).filter(Boolean);

  if (name === query) return 100;
  if (name.startsWith(query)) return 90;
  if (name.includes(query)) return 80;
  if (description.includes(query)) return 70;

  let tokenScore = 0;
  for (const token of tokens) {
    if (name.includes(token)) {
      tokenScore = Math.max(tokenScore, 60);
    }
    if (description.includes(token)) {
      tokenScore = Math.max(tokenScore, 50);
    }
  }

  return tokenScore;
}

function resolveToolSearchStatus(
  toolName: string,
  runtimeState: AdaptiveToolRuntimeState,
  turnClass: ExtendedToolTurnClass,
): ToolSearchResultEntry['status'] {
  if (runtimeState.activeTools.some(tool => tool.toolName === toolName)) {
    return 'active';
  }
  if (turnClass !== 'overlay') {
    return 'background_only';
  }
  return 'available';
}

function buildToolSearchActivationHint(status: ToolSearchResultEntry['status']): string {
  if (status === 'active') {
    return 'Already active in the current runtime.';
  }
  if (status === 'background_only') {
    return 'Discoverable, but not callable in-turn.';
  }
  return 'Use load_tools to activate this tool when you need it.';
}

function formatToolSearchLine(entry: ToolSearchResultEntry): string {
  return `- ${entry.name} [${entry.status}, ${entry.turnClass}] - ${entry.description} ${entry.activationHint}`;
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

interface SearchToolsToolRuntime {
  getExtendedTools: () => readonly AgentTool<any>[];
  getAdaptiveToolRuntimeState: () => AdaptiveToolRuntimeState;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
}

export function createToolSearchTool(runtime: SearchToolsToolRuntime): AgentTool<any> {
  return {
    name: 'tool_search',
    label: 'tool_search',
    description: 'Search the non-default tool catalog by name or description so you can choose the right tool family before activating it.',
    parameters: Type.Object({
      query: Type.Optional(
        Type.String({
          description: 'Optional search terms for the non-default tool catalog.',
        }),
      ),
      limit: Type.Optional(
        Type.Number({
          description: 'Optional maximum number of results to return.',
          minimum: 1,
          maximum: 20,
        }),
      ),
    }),
    execute: async (
      _toolCallId: string,
      executeParams: {
        query?: string;
        limit?: number;
      },
    ): Promise<AgentToolResult<{ isError?: boolean; toolSearch?: { query: string; totalMatches: number; matches: ToolSearchResultEntry[] } }>> => {
      const query = normalizeToolSearchQuery(executeParams.query);
      const maxResults = Number.isFinite(executeParams.limit)
        ? Math.max(1, Math.min(20, Math.floor(executeParams.limit ?? 0)))
        : 8;
      const runtimeState = runtime.getAdaptiveToolRuntimeState();
      const extendedTools = [...runtime.getExtendedTools()];
      const rankedMatches = extendedTools
        .map((tool) => {
          const turnClass = runtime.classifyExtendedToolForTurn(tool.name);
          const status = resolveToolSearchStatus(tool.name, runtimeState, turnClass);
          const score = scoreToolSearchMatch(tool, query);
          return {
            tool,
            turnClass,
            status,
            score,
          };
        })
        .filter((entry) => {
          if (!query) return true;
          return entry.score > 0;
        })
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          if (left.status !== right.status) {
            const weight: Record<ToolSearchResultEntry['status'], number> = {
              active: 0,
              available: 1,
              background_only: 2,
            };
            return weight[left.status] - weight[right.status];
          }
          if (left.turnClass !== right.turnClass) {
            return left.turnClass.localeCompare(right.turnClass);
          }
          return left.tool.name.localeCompare(right.tool.name);
        })
        .slice(0, maxResults)
        .map((entry) => ({
          name: entry.tool.name,
          description: entry.tool.description,
          scope: 'extended' as const,
          turnClass: entry.turnClass,
          status: entry.status,
          activationHint: buildToolSearchActivationHint(entry.status),
        }));

      const totalMatches = query
        ? extendedTools.filter(tool => scoreToolSearchMatch(tool, query) > 0).length
        : extendedTools.length;
      const contentLines = [
        query
          ? `Tool search results for "${query}" (${rankedMatches.length} of ${totalMatches} extended tools):`
          : `Tool search results for the non-default tool catalog (${rankedMatches.length} of ${totalMatches} extended tools):`,
        ...(rankedMatches.length > 0
          ? rankedMatches.map(formatToolSearchLine)
          : [query
            ? `No extended tools matched "${query}". Try broader search terms or omit the query to browse the full non-default catalog.`
            : 'No extended tools are currently registered.']),
        'Use tool_search to discover non-default tools, then use load_tools to activate overlay tools.',
      ];

      runtime.emitTelemetry('agent.tools.discovery', {
        timestamp: Date.now(),
        query: query || null,
        limit: maxResults,
        totalMatches,
        matchedTools: rankedMatches.map(match => ({
          name: match.name,
          status: match.status,
          turnClass: match.turnClass,
        })),
      });

      return {
        content: [{ type: 'text', text: contentLines.join('\n') }],
        details: {
          toolSearch: {
            query,
            totalMatches,
            matches: rankedMatches,
          },
        },
      };
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
