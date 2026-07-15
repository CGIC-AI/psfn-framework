import type { AgentTool, AgentToolResult, SubstrateAgentTool } from '../../../boundary/pi-agent/index.js';
import { Type } from '@sinclair/typebox';
import type { CapabilityAccess } from '../../../system/capabilities/gate.js';
import type { CapabilityToken } from '../../../system/capabilities/tokens.js';
import {
  resolveToolRequiredCapabilities,
  withCapabilityRequirement,
} from '../../../system/capabilities/requirements.js';
import { buildAutonomousActionMemoryContext } from '../../../faculties/memory/types.js';
import type { MemoryWriter } from '../../../faculties/memory/writer.js';
import type { RuntimeServiceHealthStatus } from '../../../operator/tool-health/types.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import type { AdaptiveToolRuntimeState } from '../adaptive-tools-telemetry.js';
import {
  buildRuntimeToolCatalogEntry,
  buildRuntimeToolListingEntry,
  type RuntimeToolCatalogEntry,
  type RuntimeToolListingEntry,
} from '../tool-catalog.js';
import { suggestToolsForIntent } from '../tool-suggestion.js';
import {
  getRetiredToolAlias,
  isRetiredFirstPartyToolAlias,
} from '../tool-surface/registry.js';
import { CANONICAL_TOOL_SURFACE_DESCRIPTIONS } from '../tool-surface/descriptions.js';
import type { PromotedToolMutationResult } from './tool-runtime-contracts.js';

export interface ToolDocumentationSearchEntry extends RuntimeToolCatalogEntry {
  parameters: unknown;
  capabilityStatus: 'authorized' | 'denied';
  healthStatus?: RuntimeServiceHealthStatus;
  missingTokens?: CapabilityToken[];
}

function normalizeToolSearchQuery(query: unknown): string {
  return typeof query === 'string' ? query.trim().toLowerCase() : '';
}

function scoreToolSearchMatch(tool: AgentTool<any>, query: string): number {
  if (!query) return 0;
  const name = tool.name.toLowerCase();
  const description = tool.description.toLowerCase();
  const parameterText = JSON.stringify(tool.parameters).toLowerCase();
  const tokens = query.split(/\s+/u).filter(Boolean);

  if (name === query) return 100;
  if (name.startsWith(query)) return 90;
  if (name.includes(query)) return 80;
  if (description.includes(query)) return 70;
  if (parameterText.includes(query)) return 65;

  let score = 0;
  for (const token of tokens) {
    if (name.includes(token)) score = Math.max(score, 60);
    if (description.includes(token)) score = Math.max(score, 50);
    if (parameterText.includes(token)) score = Math.max(score, 45);
  }
  return score;
}

function filterCanonicalDiscoverableTools(tools: readonly AgentTool<any>[]): AgentTool<any>[] {
  return tools.filter(tool => !isRetiredFirstPartyToolAlias(tool.name));
}

function filterCanonicalToolNames(toolNames: readonly string[]): string[] {
  return toolNames.filter(toolName => !isRetiredFirstPartyToolAlias(toolName));
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

interface SearchToolsToolRuntime {
  getCoreTools: () => readonly AgentTool<any>[];
  getExtendedTools: () => readonly AgentTool<any>[];
  getToolHealthStatusByName: () => ReadonlyMap<string, RuntimeServiceHealthStatus>;
  resolveCapabilityAccess: () => CapabilityAccess;
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
}

function buildDocumentationEntry(input: {
  tool: AgentTool<any>;
  scope: 'core' | 'extended';
  access: CapabilityAccess;
  healthStatus?: RuntimeServiceHealthStatus;
}): ToolDocumentationSearchEntry {
  const requiredTokens = resolveToolRequiredCapabilities(input.tool, {});
  const missingTokens = requiredTokens.filter(token => !input.access.has(token));
  return {
    ...buildRuntimeToolCatalogEntry(input.tool, input.scope),
    parameters: input.tool.parameters,
    capabilityStatus: missingTokens.length > 0 ? 'denied' : 'authorized',
    ...(input.healthStatus ? { healthStatus: input.healthStatus } : {}),
    ...(missingTokens.length > 0 ? { missingTokens } : {}),
  };
}

export function createToolSearchTool(runtime: SearchToolsToolRuntime): SubstrateAgentTool {
  return {
    name: 'tool_search',
    label: 'tool_search',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.tool_search,
    parameters: Type.Object({
      query: Type.Optional(Type.String({
        description: 'Optional tool name, purpose, action, or parameter term. Omit to browse documentation for the full catalog.',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Maximum documentation entries to return.',
        minimum: 1,
        maximum: 20,
      })),
    }),
    execute: async (
      _toolCallId: string,
      executeParams: { query?: string; limit?: number },
    ): Promise<AgentToolResult<{
      toolSearch?: {
        query: string;
        totalMatches: number;
        documentationOnly: true;
        matches: ToolDocumentationSearchEntry[];
      };
    }>> => {
      const query = normalizeToolSearchQuery(executeParams.query);
      const maxResults = Number.isFinite(executeParams.limit)
        ? Math.max(1, Math.min(20, Math.floor(executeParams.limit ?? 0)))
        : 8;
      const access = runtime.resolveCapabilityAccess();
      const healthByName = runtime.getToolHealthStatusByName();
      const catalog = [
        ...filterCanonicalDiscoverableTools(runtime.getCoreTools())
          .map(tool => ({ tool, scope: 'core' as const })),
        ...filterCanonicalDiscoverableTools(runtime.getExtendedTools())
          .map(tool => ({ tool, scope: 'extended' as const })),
      ];
      const matching = catalog
        .map(entry => ({ ...entry, score: scoreToolSearchMatch(entry.tool, query) }))
        .filter(entry => !query || entry.score > 0)
        .sort((left, right) => {
          if (right.score !== left.score) return right.score - left.score;
          if (left.scope !== right.scope) return left.scope.localeCompare(right.scope);
          return left.tool.name.localeCompare(right.tool.name);
        });
      const matches = matching.slice(0, maxResults).map(entry => buildDocumentationEntry({
        tool: entry.tool,
        scope: entry.scope,
        access,
        healthStatus: healthByName.get(entry.tool.name),
      }));

      runtime.emitTelemetry('agent.tools.documentation_search', {
        timestamp: Date.now(),
        query: query || null,
        limit: maxResults,
        totalMatches: matching.length,
        matchedTools: matches.map(match => match.name),
      });

      const content = matches.length > 0
        ? JSON.stringify({
            documentationOnly: true,
            callabilityChanged: false,
            query,
            totalMatches: matching.length,
            tools: matches,
          }, null, 2)
        : `No tool documentation matched "${query}". Try a canonical tool name, action, parameter, or broader purpose.`;
      return {
        content: [{ type: 'text', text: content }],
        details: {
          toolSearch: {
            query,
            totalMatches: matching.length,
            documentationOnly: true,
            matches,
          },
        },
      };
    },
  };
}

type ToolsetAction = 'list' | 'pin' | 'unpin' | 'describe' | 'suggest';

interface ToolsetToolRuntime {
  getCoreTools: () => readonly AgentTool<any>[];
  getExtendedTools: () => readonly AgentTool<any>[];
  getAdaptiveToolRuntimeState: () => AdaptiveToolRuntimeState;
  resolveCapabilityAccess: () => CapabilityAccess;
  getPromotedExtendedToolsLimit: () => number;
  getPromotedExtendedTools: () => readonly string[];
  setPromotedExtendedTools: (next: readonly string[]) => string[];
  persistPromotedExtendedTools: (next: readonly string[]) => string | null;
  addPromotedExtendedTool: (toolName: string) => PromotedToolMutationResult;
  removePromotedExtendedTool: (toolName: string) => PromotedToolMutationResult;
  getMemoryWriter?: () => Pick<MemoryWriter, 'write'> | undefined;
  applyActiveToolsToAgent: () => void;
}

function toolsetResult(
  payload: Record<string, unknown>,
  isError = false,
): AgentToolResult<{ isError?: boolean }> {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    details: { isError: isError || undefined },
  };
}

function formatPinnedToolList(toolNames: readonly string[]): string {
  return toolNames.length === 0 ? 'none' : toolNames.map(name => `"${name}"`).join(', ');
}

function buildToolsetPinMutationSummary(input: {
  action: 'pin' | 'unpin';
  toolName: string;
  after: readonly string[];
  reason?: string;
}): string {
  const actionText = input.action === 'pin'
    ? `Pinned extended tool "${input.toolName}" for presentation ordering.`
    : `Unpinned extended tool "${input.toolName}" from presentation ordering.`;
  const reasonText = input.reason?.trim() ? ` Reason: ${input.reason.trim()}.` : '';
  return `${actionText} Pinned order now: ${formatPinnedToolList(input.after)}.${reasonText}`;
}

async function recordToolsetPinMutationMemory(input: {
  memoryWriter: Pick<MemoryWriter, 'write'>;
  action: 'pin' | 'unpin';
  toolName: string;
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
    text: buildToolsetPinMutationSummary(input),
    type: 'episodic',
    importance: 0.82,
    salience: 0.8,
    confidence: 0.9,
    emotionalValence: 0,
    retentionClass: 'durable',
    tags: [...provenance.tags, 'toolset', 'pinned_tool_order'],
    sourceRef: provenance.sourceRef,
    provenanceRefs: provenance.provenanceRefs,
    scopeRef: provenance.scopeRef,
    scopeTags: [...provenance.scopeTags, 'toolset', 'pinned_tool_order'],
  });
}

function normalizeToolsetAction(action: unknown): ToolsetAction | null {
  if (typeof action !== 'string') return null;
  const normalized = action.trim().toLowerCase();
  if (
    normalized === 'list'
    || normalized === 'pin'
    || normalized === 'unpin'
    || normalized === 'describe'
    || normalized === 'suggest'
  ) {
    return normalized;
  }
  return null;
}

function toolsetCapabilityRequirement(params: Record<string, unknown>): CapabilityToken | null {
  const action = normalizeToolsetAction(params.action);
  if (action === 'list' || action === 'describe' || action === 'suggest') return 'identity.read';
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
  const listingByName = new Map<string, RuntimeToolListingEntry>();
  for (const tool of runtime.getCoreTools()) {
    listingByName.set(tool.name, buildRuntimeToolListingEntry(tool, 'core'));
  }
  for (const tool of filterCanonicalDiscoverableTools(runtime.getExtendedTools())) {
    listingByName.set(tool.name, buildRuntimeToolListingEntry(tool, 'extended'));
  }
  const activeTools = state.activeTools
    .filter(entry => !isRetiredFirstPartyToolAlias(entry.toolName))
    .map(entry => ({
      ...entry,
      ...(listingByName.get(entry.toolName) ?? {}),
    }));
  return {
    action: 'list',
    allRegisteredToolsCallableWithoutActivation: true,
    maxPinnedTools: runtime.getPromotedExtendedToolsLimit(),
    pinnedToolOrder: filterCanonicalToolNames(state.promotedToolsConfigured),
    appliedPinnedToolOrder: filterCanonicalToolNames(state.promotedToolsActive),
    activeTools,
    nextStep: 'Call any listed tool directly. Use tool_search or toolset action="describe" only when you need more documentation; pin/unpin changes ordering only.',
  };
}

function createToolsetSuggestPayload(
  runtime: ToolsetToolRuntime,
  input: { intent?: string; limit?: number },
): Record<string, unknown> {
  const catalog: RuntimeToolCatalogEntry[] = [
    ...runtime.getCoreTools().map(tool => buildRuntimeToolCatalogEntry(tool, 'core')),
    ...filterCanonicalDiscoverableTools(runtime.getExtendedTools())
      .map(tool => buildRuntimeToolCatalogEntry(tool, 'extended')),
  ];
  const result = suggestToolsForIntent({
    intent: input.intent ?? '',
    limit: input.limit,
    catalog,
    runtimeState: runtime.getAdaptiveToolRuntimeState(),
    access: runtime.resolveCapabilityAccess(),
  });
  return {
    action: 'suggest',
    ...result,
    nextStep: result.recommendations.length > 0
      ? 'Call the chosen authorized tool directly; suggestions never grant capabilities or change callability.'
      : 'Use tool_search or toolset action="describe" to inspect tool documentation.',
  };
}

function createToolsetDescribePayload(
  runtime: ToolsetToolRuntime,
  toolName?: string,
): Record<string, unknown> {
  const normalizedToolName = typeof toolName === 'string' ? toolName.trim() : '';
  const retired = normalizedToolName ? getRetiredToolAlias(normalizedToolName) : undefined;
  if (retired) {
    return {
      action: 'describe',
      total: 0,
      tools: [],
      message: `Tool "${normalizedToolName}" is retired; use "${retired.canonicalName}"${retired.replacementAction ? ` action="${retired.replacementAction}"` : ''}.`,
    };
  }
  const catalog = [
    ...runtime.getCoreTools().map(tool => buildRuntimeToolCatalogEntry(tool, 'core')),
    ...filterCanonicalDiscoverableTools(runtime.getExtendedTools())
      .map(tool => buildRuntimeToolCatalogEntry(tool, 'extended')),
  ]
    .filter(entry => !normalizedToolName || entry.name === normalizedToolName)
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    action: 'describe',
    total: catalog.length,
    tools: catalog,
    callabilityChanged: false,
    nextStep: 'Call canonical tool names directly. Documentation lookup does not load or activate tools.',
  };
}

export function createToolsetTool(runtime: ToolsetToolRuntime): SubstrateAgentTool {
  return withCapabilityRequirement({
    name: 'toolset',
    label: 'toolset',
    description: CANONICAL_TOOL_SURFACE_DESCRIPTIONS.toolset,
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal('list'),
        Type.Literal('suggest'),
        Type.Literal('describe'),
        Type.Literal('pin'),
        Type.Literal('unpin'),
      ], {
        description: 'Control action: list, suggest, describe, pin, or unpin.',
      }),
      intent: Type.Optional(Type.String({
        description: 'Natural-language intent to rank advisory tool/action suggestions for action=suggest.',
      })),
      limit: Type.Optional(Type.Number({
        description: 'Maximum suggestions for action=suggest.',
        minimum: 1,
        maximum: 12,
      })),
      tool: Type.Optional(Type.String({
        description: 'Canonical extended tool name for describe, pin, or unpin.',
      })),
      reason: Type.Optional(Type.String({
        description: 'Optional reason for changing the persisted presentation order.',
      })),
    }),
    execute: async (
      _toolCallId: string,
      rawParams: unknown,
    ): Promise<AgentToolResult<{ isError?: boolean }>> => {
      const executeParams = rawParams as {
        action: ToolsetAction;
        intent?: string;
        limit?: number;
        tool?: string;
        reason?: string;
      };
      const action = normalizeToolsetAction(executeParams.action);
      if (!action) {
        return toolsetResult({
          action: executeParams.action,
          message: 'Unknown toolset action. Use list, suggest, describe, pin, or unpin.',
        }, true);
      }
      if (action === 'list') return toolsetResult(createToolsetListPayload(runtime));
      if (action === 'suggest') return toolsetResult(createToolsetSuggestPayload(runtime, executeParams));
      if (action === 'describe') return toolsetResult(createToolsetDescribePayload(runtime, executeParams.tool));

      const toolName = typeof executeParams.tool === 'string' ? executeParams.tool.trim() : '';
      if (!toolName) {
        return toolsetResult({
          action,
          message: `Provide a non-empty "tool" for toolset action "${action}".`,
        }, true);
      }
      if (isRetiredFirstPartyToolAlias(toolName)) {
        return toolsetResult({
          action,
          ok: false,
          changed: false,
          message: 'Retired first-party aliases cannot be pinned or unpinned. Use a canonical extended tool name.',
        }, true);
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
          return toolsetResult({ action, tool: toolName, message: memoryError, pinnedToolOrder: before }, true);
        }
      }
      return toolsetResult({
        action,
        tool: toolName,
        ok: result.ok,
        changed: result.changed,
        orderingOnly: true,
        maxPinnedTools: runtime.getPromotedExtendedToolsLimit(),
        pinnedToolOrder: result.promotedTools,
        message: result.message,
        ...(result.errorCode ? { errorCode: result.errorCode } : {}),
        ...(result.requiredTokens ? { requiredTokens: result.requiredTokens } : {}),
        ...(result.missingTokens ? { missingTokens: result.missingTokens } : {}),
      }, !result.ok);
    },
  }, toolsetCapabilityRequirement);
}
