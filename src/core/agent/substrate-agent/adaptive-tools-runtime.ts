import type { AgentTool, AgentToolResult } from '@mariozechner/pi-agent-core';
import { Type } from '@sinclair/typebox';
import type { CapabilityAccess } from '../../../system/capabilities/gate.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import {
  resolveToolRequiredCapabilities,
  withCapabilityRequirement,
} from '../../../system/capabilities/requirements.js';
import { buildAutonomousActionMemoryContext } from '../../../faculties/memory/types.js';
import type { MemoryWriter } from '../../../faculties/memory/writer.js';
import type {
  CorrelationMetadata,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { RuntimeServiceHealthStatus } from '../../../operator/tool-health/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
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
import type {
  AutoloadTurnOutcome,
  PromotedToolMutationResult,
} from './tool-runtime-contracts.js';
export type { AutoloadTurnOutcome } from './tool-runtime-contracts.js';

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

export interface ToolSearchResultEntry {
  name: string;
  description: string;
  scope: 'extended';
  turnClass: ExtendedToolTurnClass;
  status: 'active' | 'available' | 'background_only' | 'capability_denied';
  healthStatus?: RuntimeServiceHealthStatus;
  activationHint: string;
  missingTokens?: CapabilityToken[];
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
  tool: AgentTool<any>,
  runtimeState: AdaptiveToolRuntimeState,
  turnClass: ExtendedToolTurnClass,
  access: CapabilityAccess,
): Pick<ToolSearchResultEntry, 'status' | 'missingTokens'> {
  if (runtimeState.activeTools.some(entry => entry.toolName === tool.name)) {
    return { status: 'active' };
  }
  if (turnClass !== 'overlay') {
    return { status: 'background_only' };
  }

  const missingTokens = resolveToolRequiredCapabilities(tool, {})
    .filter(token => !access.has(token));
  if (missingTokens.length > 0) {
    return {
      status: 'capability_denied',
      missingTokens,
    };
  }

  return { status: 'available' };
}

function buildToolSearchActivationHint(
  entry: Pick<ToolSearchResultEntry, 'status' | 'missingTokens'>,
): string {
  const status = entry.status;
  if (status === 'active') {
    return 'Already active in the current runtime.';
  }
  if (status === 'background_only') {
    return 'Discoverable, but not callable in-turn.';
  }
  if (status === 'capability_denied') {
    return `Blocked by the current capability tier (missing: ${(entry.missingTokens ?? []).join(', ')}). Activate only when you need a real denied tool result.`;
  }
  return 'Use toolset with action="activate" to activate this tool when you need it.';
}

export function resolveToolHealthMarker(
  status: RuntimeServiceHealthStatus | undefined,
): 'o' | '!' | 'x' | null {
  switch (status) {
    case 'healthy':
      return 'o';
    case 'degraded':
      return '!';
    case 'unavailable':
    case 'not_applicable':
      return 'x';
    default:
      return null;
  }
}

export function formatToolNameWithHealth(
  name: string,
  status: RuntimeServiceHealthStatus | undefined,
): string {
  const marker = resolveToolHealthMarker(status);
  return marker ? `${name} (${marker})` : name;
}

export function formatToolHealthLegend(): string {
  return 'Health markers: o=healthy, !=degraded, x=unavailable.';
}

function formatToolSearchLine(entry: ToolSearchResultEntry): string {
  return `- ${formatToolNameWithHealth(entry.name, entry.healthStatus)} [${entry.status}, ${entry.turnClass}] - ${entry.description} ${entry.activationHint}`;
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

type ToolsetAction = 'list' | 'activate' | 'pin' | 'unpin';

interface ToolsetToolRuntime {
  getExtendedTools: () => readonly AgentTool<any>[];
  getExtendedToolAutoloadPolicy: () => ExtendedToolAutoloadPolicy | null;
  getAdaptiveToolRuntimeState: () => AdaptiveToolRuntimeState;
  getActiveTurnCorrelation: () => CorrelationMetadata | null;
  getActiveTurnTaskKind: () => string | null;
  getActiveTurnIntent: () => string | null;
  getPromotedExtendedToolsLimit: () => number;
  getPromotedExtendedTools: () => readonly string[];
  setPromotedExtendedTools: (next: readonly string[]) => string[];
  persistPromotedExtendedTools: (next: readonly string[]) => string | null;
  addPromotedExtendedTool: (toolName: string) => PromotedToolMutationResult;
  removePromotedExtendedTool: (toolName: string) => PromotedToolMutationResult;
  getMemoryWriter?: () => Pick<MemoryWriter, 'write'> | undefined;
  applyActiveToolsToAgent: () => void;
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

function toolsetResult(
  payload: Record<string, unknown>,
  options: {
    isError?: boolean;
    deferredToolHandoff?: DeferredToolHandoffIntent;
  } = {},
): AgentToolResult<{ isError?: boolean; deferredToolHandoff?: DeferredToolHandoffIntent }> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: {
      isError: options.isError || undefined,
      ...(options.deferredToolHandoff ? { deferredToolHandoff: options.deferredToolHandoff } : {}),
    },
  };
}

function formatPinnedToolList(toolNames: readonly string[]): string {
  if (toolNames.length === 0) return 'none';
  return toolNames.map(name => `"${name}"`).join(', ');
}

function buildToolsetPinMutationSummary(input: {
  action: 'pin' | 'unpin';
  toolName: string;
  after: readonly string[];
  reason?: string;
}): string {
  const actionText = input.action === 'pin'
    ? `Pinned extended tool "${input.toolName}".`
    : `Unpinned extended tool "${input.toolName}".`;
  const reasonText = input.reason?.trim()
    ? ` Reason: ${input.reason.trim()}.`
    : '';
  return `${actionText} Pinned tools now: ${formatPinnedToolList(input.after)}.${reasonText}`;
}

async function recordToolsetPinMutationMemory(input: {
  memoryWriter: Pick<MemoryWriter, 'write'>;
  action: 'pin' | 'unpin';
  toolName: string;
  before: readonly string[];
  after: readonly string[];
  reason?: string;
}): Promise<void> {
  const provenance = buildAutonomousActionMemoryContext({
    toolName: 'toolset',
    action: input.action,
    reason: input.reason,
    timestampMs: Date.now(),
  });
  await input.memoryWriter.write({
    text: buildToolsetPinMutationSummary({
      action: input.action,
      toolName: input.toolName,
      after: input.after,
      reason: input.reason,
    }),
    type: 'episodic',
    importance: 0.82,
    salience: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    retentionClass: 'durable',
    tags: [...provenance.tags, 'toolset', 'promoted_tools'],
    sourceRef: provenance.sourceRef,
    provenanceRefs: provenance.provenanceRefs,
    scopeRef: provenance.scopeRef,
    scopeTags: [...provenance.scopeTags, 'toolset', 'promoted_tools'],
  });
}

function normalizeToolsetAction(action: unknown): ToolsetAction | null {
  if (typeof action !== 'string') return null;
  const normalized = action.trim().toLowerCase();
  if (normalized === 'list' || normalized === 'activate' || normalized === 'pin' || normalized === 'unpin') {
    return normalized;
  }
  return null;
}

function toolsetCapabilityRequirement(params: Record<string, unknown>): CapabilityToken | null {
  const action = normalizeToolsetAction(params.action);
  if (action === 'list') return 'identity.read';
  if (action === 'pin' || action === 'unpin') return 'identity.write.runtime';
  return null;
}

async function maybeRecordToolsetMutationMemory(input: {
  runtime: ToolsetToolRuntime;
  action: 'pin' | 'unpin';
  toolName: string;
  before: readonly string[];
  after: readonly string[];
  reason?: string;
}): Promise<string | null> {
  const memoryWriter = input.runtime.getMemoryWriter?.();
  if (!memoryWriter) return null;
  try {
    await recordToolsetPinMutationMemory({
      memoryWriter,
      action: input.action,
      toolName: input.toolName,
      before: input.before,
      after: input.after,
      reason: input.reason,
    });
    return null;
  } catch (error) {
    const rollbackError = input.runtime.persistPromotedExtendedTools(input.before);
    input.runtime.setPromotedExtendedTools(input.before);
    input.runtime.applyActiveToolsToAgent();
    return `Failed to persist autonomous-action memory for toolset ${input.action}; rolled back change. ${toErrorMessage(error)}`
      + (rollbackError ? ` Rollback persistence failed: ${rollbackError}` : '');
  }
}

function createToolsetListPayload(runtime: ToolsetToolRuntime): Record<string, unknown> {
  const state = runtime.getAdaptiveToolRuntimeState();
  return {
    action: 'list',
    maxPinnedTools: runtime.getPromotedExtendedToolsLimit(),
    pinnedTools: [...state.promotedToolsConfigured],
    activePinnedTools: [...state.promotedToolsActive],
    activeTools: state.activeTools.map(entry => ({ ...entry })),
    loadedTools: state.loadedExtendedTools.map(entry => ({ ...entry })),
    availableExtendedTools: [...state.extendedTools],
    nextStep: 'Use tool_search to discover non-default tools, then use toolset action="activate" for this runtime or action="pin"/"unpin" across turns.',
  };
}

async function executeToolsetActivateAction(
  runtime: ToolsetToolRuntime,
  executeParams: {
    tools?: string[];
    intendedAction?: string;
    deferUntilTurnBoundary?: boolean;
    maxRetries?: number;
  },
): Promise<AgentToolResult<{ isError?: boolean; deferredToolHandoff?: DeferredToolHandoffIntent }>> {
  const requestedTools = normalizeToolNameList(executeParams.tools ?? []);
  if (requestedTools.length === 0) {
    return toolsetResult({
      action: 'activate',
      message: 'Provide at least one extended tool name in "tools".',
    }, { isError: true });
  }
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
    let deferredContinuationStatus = 'not_requested';
    if (deferredToolHandoff) {
      deferredContinuationStatus = 'queued';
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
      deferredContinuationStatus = 'skipped_missing_intended_action';
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

    return toolsetResult({
      action: 'activate',
      requestedTools,
      activatedTools: activation.activatedTools,
      alreadyActiveTools: activation.alreadyActiveTools,
      missingTools: activation.missingTools,
      unavailableTools: unavailableSkipped,
      backgroundOnlyTools: backgroundOnlySkipped,
      skippedBySameTurnBudget: budgetSkipped,
      ignoredInvalidToolNames: invalidSkipped,
      ignoredDuplicateToolNames: duplicateSkipped,
      deferredContinuationStatus,
      nextStep: 'Use toolset action="pin" if an overlay tool should stay active across turns.',
    }, {
      deferredToolHandoff: deferredToolHandoff ?? undefined,
    });
  }
  return toolsetResult({
    action: 'activate',
    message: `No matching tools found. Available: ${runtime.getExtendedTools().map(t => t.name).join(', ')}`,
  }, { isError: true });
}

export function createToolsetTool(runtime: ToolsetToolRuntime): AgentTool<any> {
  return withCapabilityRequirement({
    name: 'toolset',
    label: 'toolset',
    description:
      'List active non-default tools, activate overlay tools for the current runtime, and pin or unpin eligible tools across turns.',
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('activate'),
        Type.Literal('pin'),
        Type.Literal('unpin'),
      ], {
        description: 'Control action: list, activate, pin, or unpin.',
      }),
      tool: Type.Optional(Type.String({
        description: 'Single tool name for pin or unpin actions.',
      })),
      tools: Type.Optional(Type.Array(Type.Union([
        Type.String(),
        Type.Object({
          name: Type.String(),
        }),
      ]), {
        description: 'Tool names to activate for the current runtime. Accepts plain names or { name } entries.',
      })),
      reason: Type.Optional(Type.String({
        description: 'Optional reason for pin or unpin actions.',
      })),
      intendedAction: Type.Optional(
        Type.String({
          description:
            'Optional follow-up action to execute after this reply when tools were discovered late.',
        }),
      ),
      deferUntilTurnBoundary: Type.Optional(
        Type.Boolean({
          description:
            'Set true when activation was discovered late and the intended action should continue post-reply.',
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
        action: ToolsetAction;
        tool?: string;
        tools?: unknown[];
        reason?: string;
        intendedAction?: string;
        deferUntilTurnBoundary?: boolean;
        maxRetries?: number;
      },
    ): Promise<AgentToolResult<{ isError?: boolean; deferredToolHandoff?: DeferredToolHandoffIntent }>> => {
      const action = normalizeToolsetAction(executeParams.action);
      if (!action) {
        return toolsetResult({
          action: executeParams.action,
          message: 'Unknown toolset action. Use list, activate, pin, or unpin.',
        }, { isError: true });
      }

      if (action === 'list') {
        return toolsetResult(createToolsetListPayload(runtime));
      }

      if (action === 'activate') {
        return executeToolsetActivateAction(runtime, executeParams);
      }

      const toolName = typeof executeParams.tool === 'string' ? executeParams.tool.trim() : '';
      if (!toolName) {
        return toolsetResult({
          action,
          message: `Provide a non-empty "tool" for toolset action "${action}".`,
        }, { isError: true });
      }

      const before = [...runtime.getPromotedExtendedTools()];
      const result = action === 'pin'
        ? runtime.addPromotedExtendedTool(toolName)
        : runtime.removePromotedExtendedTool(toolName);
      if (result.ok && result.changed) {
        const memoryError = await maybeRecordToolsetMutationMemory({
          runtime,
          action,
          toolName,
          before,
          after: result.promotedTools,
          reason: executeParams.reason,
        });
        if (memoryError) {
          return toolsetResult({
            action,
            tool: toolName,
            message: memoryError,
            pinnedTools: before,
          }, { isError: true });
        }
      }

      return toolsetResult({
        action,
        tool: toolName,
        ok: result.ok,
        changed: result.changed,
        maxPinnedTools: runtime.getPromotedExtendedToolsLimit(),
        pinnedTools: result.promotedTools,
        message: result.message,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.requiredTokens ? { requiredTokens: result.requiredTokens } : {}),
        ...(result.missingTokens ? { missingTokens: result.missingTokens } : {}),
      }, {
        isError: !result.ok,
      });
    },
  }, toolsetCapabilityRequirement);
}

interface SearchToolsToolRuntime {
  getExtendedTools: () => readonly AgentTool<any>[];
  getAdaptiveToolRuntimeState: () => AdaptiveToolRuntimeState;
  getToolHealthStatusByName: () => ReadonlyMap<string, RuntimeServiceHealthStatus>;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  resolveCapabilityAccess: () => CapabilityAccess;
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
      const toolHealthStatusByName = runtime.getToolHealthStatusByName();
      const access = runtime.resolveCapabilityAccess();
      const extendedTools = [...runtime.getExtendedTools()];
      const rankedMatches = extendedTools
        .map((tool) => {
          const turnClass = runtime.classifyExtendedToolForTurn(tool.name);
          const status = resolveToolSearchStatus(tool, runtimeState, turnClass, access);
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
              capability_denied: 2,
              background_only: 3,
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
          status: entry.status.status,
          healthStatus: toolHealthStatusByName.get(entry.tool.name),
          activationHint: buildToolSearchActivationHint(entry.status),
          ...(entry.status.missingTokens ? { missingTokens: entry.status.missingTokens } : {}),
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
        'Use tool_search to discover non-default tools, then use toolset to activate or pin overlay tools.',
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
          ...(match.missingTokens ? { missingTokens: match.missingTokens } : {}),
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
