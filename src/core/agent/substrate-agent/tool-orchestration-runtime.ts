import type { AgentTool } from '../../../boundary/pi-agent/index.js';
import {
  evaluateToolCapabilityEligibility,
  type CapabilityAccess,
} from '../../../system/capabilities/gate.js';
import { PROMOTED_EXTENDED_TOOL_SLOTS_MAX, type SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import type { CorrelationMetadata, ObservabilityCallType, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import { toErrorMessage } from '../../../shared/utils/errors.js';
import {
  DEFAULT_BOUNDED_SUBAGENT_LAUNCH_MAX_PARALLEL,
  isBoundedSubagentLaunchToolName,
} from './bounded-subagent-contract.js';
import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotSkip,
  AdaptiveToolSnapshotTelemetry,
  AdaptiveToolSnapshotTool,
} from '../adaptive-tools-telemetry.js';
import { resolveToolPresentationRank } from '../tool-surface/registry.js';
import type { ToolUsageRanking } from '../tool-surface/usage-ranking.js';
import type { ToolCategory } from '../tool-registrar.js';
import type {
  ToolConcurrencyClass,
  ToolConcurrencyMeta,
  ToolExecutionEligibility,
  ToolInterruptibility,
  WirableTool,
} from '../tool-wiring-validator.js';
import type { PromotedToolMutationResult, ToolTurnOutcome } from './tool-runtime-contracts.js';
export type { PromotedToolMutationResult } from './tool-runtime-contracts.js';

export type PromotedToolMutationErrorCode =
  | 'invalid_name'
  | 'tool_not_extended'
  | 'duplicate'
  | 'max_slots'
  | 'capability_denied'
  | 'not_found'
  | 'invalid_slot'
  | 'persist_failed';

export interface ActiveToolResolution {
  tools: AgentTool<any>[];
  snapshotTools: AdaptiveToolSnapshotTool[];
  promotedSkipped: AdaptiveToolSnapshotSkip[];
  counts: AdaptiveToolSnapshotTelemetry['counts'];
}

export interface PromotedToolResolution {
  activeNames: Set<string>;
  orderedNames: string[];
  skipped: AdaptiveToolSnapshotSkip[];
}

export const DEFAULT_PARALLEL_READ_MAX = 3;

const PARALLEL_READ_ONLY_TOOL_NAMES = new Set([
  'repo_status',
  'repo_diff',
  'issue_ready',
  'issue_show',
  'settings_get',
  'skill_list',
  'skill_view',
  'prompt_layer_list',
  'prompt_layer_get',
  'north_star_list',
  'identity_diff',
]);

type AdaptiveDecisionPayload = Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>;

export function inferToolConcurrencyClass(toolName: string): ToolConcurrencyClass {
  if (toolName === 'subagent') return 'spawn_subagent';
  if (isBoundedSubagentLaunchToolName(toolName)) return 'spawn_subagent';
  if (PARALLEL_READ_ONLY_TOOL_NAMES.has(toolName)) return 'read_only';
  return 'exclusive';
}

export function inferToolInterruptibility(
  concurrencyClass: ToolConcurrencyClass,
): ToolInterruptibility {
  if (concurrencyClass === 'spawn_subagent') return 'non_interruptible';
  return 'cooperative';
}

export function inferToolEligibility(
  _toolName: string,
  _category: ToolCategory,
): ToolExecutionEligibility {
  return {
    foreground: true,
    background: true,
  };
}

export function withToolConcurrencyMetadata(
  tool: AgentTool<any>,
  category: ToolCategory,
): AgentTool<any> {
  const wirable = tool as WirableTool;
  const existingMeta = wirable.wiringMeta;
  const existingConcurrency = existingMeta?.concurrency as Partial<ToolConcurrencyMeta> | undefined;
  const inferredClass = inferToolConcurrencyClass(tool.name);
  const inferredEligibility = inferToolEligibility(tool.name, category);
  const resolvedClass = existingConcurrency?.class ?? inferredClass;
  const concurrency: ToolConcurrencyMeta = {
    class: resolvedClass,
    exclusivityKeyPolicy: existingConcurrency?.exclusivityKeyPolicy
      ?? (resolvedClass === 'exclusive' ? 'category_tool_name' : 'none'),
    ...(existingConcurrency?.exclusivityKey ? { exclusivityKey: existingConcurrency.exclusivityKey } : {}),
    ...(existingConcurrency?.maxParallel !== undefined ? { maxParallel: existingConcurrency.maxParallel } : {}),
    interruptibility: existingConcurrency?.interruptibility
      ?? inferToolInterruptibility(resolvedClass),
    eligibility: existingConcurrency?.eligibility
      ? {
        foreground: typeof existingConcurrency.eligibility.foreground === 'boolean'
          ? existingConcurrency.eligibility.foreground
          : inferredEligibility.foreground,
        background: typeof existingConcurrency.eligibility.background === 'boolean'
          ? existingConcurrency.eligibility.background
          : inferredEligibility.background,
      }
      : inferredEligibility,
  };

  if (concurrency.class === 'exclusive') {
    if (!concurrency.exclusivityKey || concurrency.exclusivityKey.trim().length === 0) {
      concurrency.exclusivityKey = `${category}:${tool.name}`;
      concurrency.exclusivityKeyPolicy = 'category_tool_name';
    } else if (
      concurrency.exclusivityKeyPolicy === 'none'
    ) {
      concurrency.exclusivityKeyPolicy = 'static_key';
    }
  } else {
    concurrency.exclusivityKeyPolicy = 'none';
    delete concurrency.exclusivityKey;
    if (concurrency.maxParallel === undefined) {
      concurrency.maxParallel = concurrency.class === 'spawn_subagent'
        ? DEFAULT_BOUNDED_SUBAGENT_LAUNCH_MAX_PARALLEL
        : DEFAULT_PARALLEL_READ_MAX;
    }
  }

  wirable.wiringMeta = {
    ...(existingMeta ?? {}),
    concurrency,
  };
  return wirable;
}

export function normalizePromotedExtendedToolNames(
  raw: readonly string[] | undefined,
): string[] {
  if (!Array.isArray(raw)) return [];
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim();
    if (!name || seen.has(name)) continue;
    normalized.push(name);
    seen.add(name);
    if (normalized.length >= PROMOTED_EXTENDED_TOOL_SLOTS_MAX) break;
  }
  return normalized;
}

export function toolNameListsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function getPromotedExtendedToolNames(
  config: Pick<SubstrateConfig, 'promotedExtendedTools'>,
): string[] {
  const current = normalizePromotedExtendedToolNames(config.promotedExtendedTools);
  const configured = config.promotedExtendedTools ?? [];
  if (!toolNameListsEqual(current, configured)) {
    config.promotedExtendedTools = current;
  }
  return current;
}

export function setPromotedExtendedToolNames(
  config: Pick<SubstrateConfig, 'promotedExtendedTools'>,
  next: readonly string[],
): string[] {
  const normalized = normalizePromotedExtendedToolNames(next);
  config.promotedExtendedTools = normalized;
  return normalized;
}

export async function persistPromotedExtendedToolNames(
  config: Pick<SubstrateConfig, 'runtimeHooks'>,
  next: readonly string[],
): Promise<string | null> {
  const persist = config.runtimeHooks?.persistPromotedExtendedTools;
  if (!persist) return null;
  try {
    await persist([...next]);
    return null;
  } catch (error) {
    return toErrorMessage(error);
  }
}

export function getExtendedToolByName(
  extendedTools: readonly AgentTool<any>[],
  name: string,
): AgentTool<any> | null {
  return extendedTools.find(tool => tool.name === name) ?? null;
}

interface ResolvePromotedToolActivationParams {
  promotedTools: readonly string[];
  extendedTools: readonly AgentTool<any>[];
  resolveCapabilityAccess: () => CapabilityAccess;
}

export function resolvePromotedToolActivation(
  params: ResolvePromotedToolActivationParams,
): PromotedToolResolution {
  const access = params.resolveCapabilityAccess();
  const activeNames = new Set<string>();
  const orderedNames: string[] = [];
  const skipped: AdaptiveToolSnapshotSkip[] = [];
  for (const toolName of params.promotedTools) {
    const tool = getExtendedToolByName(params.extendedTools, toolName);
    if (!tool) {
      skipped.push({
        toolName,
        source: 'extended',
        reason: 'not_registered',
      });
      continue;
    }
    const eligibility = evaluateToolCapabilityEligibility(tool, {}, access);
    if (!eligibility.allowed) {
      skipped.push({
        toolName: tool.name,
        source: 'extended',
        reason: 'capability_denied',
        ...(eligibility.missingTokens.length > 0 ? { missingTokens: eligibility.missingTokens } : {}),
      });
      continue;
    }
    activeNames.add(tool.name);
    orderedNames.push(tool.name);
  }
  return {
    activeNames,
    orderedNames,
    skipped,
  };
}

export function mergeAdaptiveSkips(
  ...groups: AdaptiveToolSnapshotSkip[][]
): AdaptiveToolSnapshotSkip[] {
  const deduped = new Map<string, AdaptiveToolSnapshotSkip>();
  for (const group of groups) {
    for (const entry of group) {
      const missingTokensKey = (entry.missingTokens ?? []).join(',');
      const key = `${entry.source}:${entry.toolName}:${entry.reason}:${missingTokensKey}`;
      if (deduped.has(key)) continue;
      deduped.set(key, {
        ...entry,
        ...(entry.missingTokens ? { missingTokens: [...entry.missingTokens] } : {}),
      });
    }
  }
  return [...deduped.values()];
}

interface ResolveActiveToolsParams {
  coreTools: readonly AgentTool<any>[];
  extendedTools: readonly AgentTool<any>[];
  promotedResolution: PromotedToolResolution;
  additionalSkipped?: AdaptiveToolSnapshotSkip[];
  /**
   * Durable-usage ordering signal (psfn-framework-b0yl.5). Applied only as a
   * tie-break INSIDE a presentation band — after explicit pins and after the
   * social/expressive-first domain rank — so it never overrides deliberate
   * ordering and never affects callability. Absent => alphabetical tie-break.
   */
  usageRanking?: ToolUsageRanking;
}

export function resolveActiveTools(
  params: ResolveActiveToolsParams,
): ActiveToolResolution {
  const activeByName = new Map<string, { tool: AgentTool<any>; source: 'core' | 'extended' }>();
  for (const tool of params.coreTools) {
    if (!activeByName.has(tool.name)) {
      activeByName.set(tool.name, {
        tool,
        source: 'core',
      });
    }
  }

  for (const tool of params.extendedTools) {
    if (!activeByName.has(tool.name)) {
      activeByName.set(tool.name, {
        tool,
        source: 'extended',
      });
    }
  }

  const pinnedIndex = new Map(
    params.promotedResolution.orderedNames.map((toolName, index) => [toolName, index] as const),
  );

  // Persisted pin preferences only affect presentation order. Every registered
  // extended tool remains present and callable whether pinned or not.
  const orderedActiveEntries = [...activeByName.values()]
    .sort((left, right) => {
      const leftPinned = pinnedIndex.get(left.tool.name);
      const rightPinned = pinnedIndex.get(right.tool.name);
      if (leftPinned !== undefined || rightPinned !== undefined) {
        if (leftPinned === undefined) return 1;
        if (rightPinned === undefined) return -1;
        if (leftPinned !== rightPinned) return leftPinned - rightPinned;
      }
      const rankDelta = resolveToolPresentationRank(left.tool.name)
        - resolveToolPresentationRank(right.tool.name);
      if (rankDelta !== 0) return rankDelta;
      // Within an identical presentation band, durable usage frequency breaks
      // the tie (most-used first) before falling back to alphabetical order.
      // This is the only place usage stats touch ordering; bands above are
      // untouched, so deliberate ranking and pins are preserved.
      if (params.usageRanking) {
        const usageDelta = params.usageRanking.compareWithinBand(left.tool.name, right.tool.name);
        if (usageDelta !== 0) return usageDelta;
      }
      return left.tool.name.localeCompare(right.tool.name);
    });

  const snapshotTools: AdaptiveToolSnapshotTool[] = orderedActiveEntries
    .map((entry) => ({
      toolName: entry.tool.name,
      source: entry.source,
    }));

  const counts: AdaptiveToolSnapshotTelemetry['counts'] = {
    core: 0,
    extended: 0,
    total: snapshotTools.length,
  };
  for (const entry of snapshotTools) {
    if (entry.source === 'core') counts.core += 1;
    else counts.extended += 1;
  }

  return {
    tools: orderedActiveEntries.map(entry => entry.tool),
    snapshotTools,
    promotedSkipped: mergeAdaptiveSkips(params.promotedResolution.skipped, params.additionalSkipped ?? []),
    counts,
  };
}

interface ApplyActiveToolsToAgentParams {
  resolution: ActiveToolResolution;
  withCapabilityGates: (tools: AgentTool<any>[]) => AgentTool<any>[];
  setAgentTools: (tools: AgentTool<any>[]) => void;
}

export function applyActiveToolsToAgent(
  params: ApplyActiveToolsToAgentParams,
): void {
  params.setAgentTools(params.withCapabilityGates(params.resolution.tools));
}

interface BuildAdaptiveToolSnapshotParams {
  message: SubstrateMessage;
  taskKind: string | undefined;
  callType: ObservabilityCallType;
  correlation: CorrelationMetadata;
  toolTurnOutcome: ToolTurnOutcome;
  resolution: ActiveToolResolution;
  withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
}

export function buildAdaptiveToolSnapshot(
  params: BuildAdaptiveToolSnapshotParams,
): AdaptiveToolSnapshotTelemetry {
  return {
    ...params.withAdaptiveCorrelation(params.correlation, 'agent.tools.adaptive.snapshot'),
    turnId: params.correlation.turnId,
    requestId: params.correlation.requestId,
    channelId: params.message.channelId,
    callType: params.callType,
    timestamp: Date.now(),
    tools: params.resolution.snapshotTools.map(tool => ({ ...tool })),
    skipped: params.resolution.promotedSkipped.map(skip => ({
      ...skip,
      ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
    })),
    counts: { ...params.resolution.counts },
    taskKind: params.taskKind ?? null,
    intent: params.toolTurnOutcome.intent,
  };
}

interface EmitAdaptiveToolSnapshotDecisionsParams {
  snapshot: AdaptiveToolSnapshotTelemetry;
  correlation: CorrelationMetadata;
  withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
  emitAdaptiveToolDecision: (payload: AdaptiveDecisionPayload) => void;
}

export function emitAdaptiveToolSnapshotDecisions(
  params: EmitAdaptiveToolSnapshotDecisionsParams,
): void {
  for (const tool of params.snapshot.tools) {
    params.emitAdaptiveToolDecision({
      ...params.withAdaptiveCorrelation(params.correlation, 'agent.tools.adaptive.decision'),
      toolName: tool.toolName,
      source: tool.source,
      decision: 'active',
      reason: 'turn_active_set',
      taskKind: params.snapshot.taskKind ?? null,
      intent: params.snapshot.intent ?? null,
    });
  }

  for (const skip of params.snapshot.skipped) {
    params.emitAdaptiveToolDecision({
      ...params.withAdaptiveCorrelation(params.correlation, 'agent.tools.adaptive.decision'),
      toolName: skip.toolName,
      source: skip.source,
      decision: 'skipped',
      reason: skip.reason,
      ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
      taskKind: params.snapshot.taskKind ?? null,
      intent: params.snapshot.intent ?? null,
    });
  }
}

export function cloneAdaptiveToolSnapshot(
  snapshot: AdaptiveToolSnapshotTelemetry | null,
): AdaptiveToolSnapshotTelemetry | null {
  if (!snapshot) return null;
  return {
    ...snapshot,
    tools: snapshot.tools.map(tool => ({ ...tool })),
    skipped: snapshot.skipped.map(skip => ({
      ...skip,
      ...(skip.missingTokens ? { missingTokens: [...skip.missingTokens] } : {}),
    })),
    counts: { ...snapshot.counts },
  };
}

interface BuildAdaptiveToolRuntimeStateParams {
  coreTools: readonly AgentTool<any>[];
  extendedTools: readonly AgentTool<any>[];
  promotedToolsConfigured: readonly string[];
  promotedResolution: PromotedToolResolution;
  activeResolution: ActiveToolResolution;
  lastSnapshot: AdaptiveToolSnapshotTelemetry | null;
}

export function buildAdaptiveToolRuntimeState(
  params: BuildAdaptiveToolRuntimeStateParams,
): AdaptiveToolRuntimeState {
  return {
    generatedAt: Date.now(),
    coreTools: params.coreTools.map(tool => tool.name),
    extendedTools: params.extendedTools.map(tool => tool.name),
    promotedToolsConfigured: [...params.promotedToolsConfigured],
    promotedToolsActive: [...params.promotedResolution.activeNames],
    promotedToolsSkipped: params.promotedResolution.skipped.map(entry => ({
      ...entry,
      ...(entry.missingTokens ? { missingTokens: [...entry.missingTokens] } : {}),
    })),
    activeTools: params.activeResolution.snapshotTools.map(entry => ({
      ...entry,
    })),
    lastSnapshot: cloneAdaptiveToolSnapshot(params.lastSnapshot),
  };
}

export function getPromotedExtendedToolsLimit(): number {
  return PROMOTED_EXTENDED_TOOL_SLOTS_MAX;
}

interface PromotedToolMutationRuntime {
  getPromotedExtendedToolNames: () => string[];
  setPromotedExtendedToolNames: (next: readonly string[]) => string[];
  persistPromotedExtendedToolNames: (next: readonly string[]) => Promise<string | null>;
  getExtendedToolByName: (toolName: string) => AgentTool<any> | null;
  resolveCapabilityAccess: () => CapabilityAccess;
  applyActiveToolsToAgent: () => void;
}

export async function addPromotedExtendedTool(
  toolName: string,
  runtime: PromotedToolMutationRuntime,
): Promise<PromotedToolMutationResult> {
  const normalizedName = toolName.trim();
  if (!normalizedName) {
    return {
      ok: false,
      changed: false,
      promotedTools: runtime.getPromotedExtendedToolNames(),
      message: 'Tool name cannot be empty.',
      errorCode: 'invalid_name',
    };
  }

  const current = runtime.getPromotedExtendedToolNames();
  if (current.includes(normalizedName)) {
    return {
      ok: true,
      changed: false,
      promotedTools: current,
      message: `Tool "${normalizedName}" is already pinned for presentation ordering.`,
      errorCode: 'duplicate',
    };
  }

  if (current.length >= PROMOTED_EXTENDED_TOOL_SLOTS_MAX) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Pinned tool-order slots are full (max ${PROMOTED_EXTENDED_TOOL_SLOTS_MAX}).`,
      errorCode: 'max_slots',
    };
  }

  const tool = runtime.getExtendedToolByName(normalizedName);
  if (!tool) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Tool "${normalizedName}" is not available in the extended catalog.`,
      errorCode: 'tool_not_extended',
    };
  }
  const access = runtime.resolveCapabilityAccess();
  const eligibility = evaluateToolCapabilityEligibility(tool, {}, access);
  if (!eligibility.allowed) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Tool "${normalizedName}" is not allowed for capability tier "${access.getTier()}".`,
      errorCode: 'capability_denied',
      requiredTokens: eligibility.requiredTokens,
      missingTokens: eligibility.missingTokens,
    };
  }

  const next = [...current, normalizedName];
  const persistError = await runtime.persistPromotedExtendedToolNames(next);
  if (persistError) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Failed to persist pinned tool ordering: ${persistError}`,
      errorCode: 'persist_failed',
    };
  }

  const promotedTools = runtime.setPromotedExtendedToolNames(next);
  runtime.applyActiveToolsToAgent();
  return {
    ok: true,
    changed: true,
    promotedTools,
    message: `Pinned "${normalizedName}" as a tool presentation-order preference.`,
  };
}

export async function removePromotedExtendedTool(
  toolName: string,
  runtime: PromotedToolMutationRuntime,
): Promise<PromotedToolMutationResult> {
  const normalizedName = toolName.trim();
  if (!normalizedName) {
    return {
      ok: false,
      changed: false,
      promotedTools: runtime.getPromotedExtendedToolNames(),
      message: 'Tool name cannot be empty.',
      errorCode: 'invalid_name',
    };
  }

  const current = runtime.getPromotedExtendedToolNames();
  if (!current.includes(normalizedName)) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Tool "${normalizedName}" is not currently pinned for presentation ordering.`,
      errorCode: 'not_found',
    };
  }

  const next = current.filter(name => name !== normalizedName);
  const persistError = await runtime.persistPromotedExtendedToolNames(next);
  if (persistError) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Failed to persist pinned tool ordering: ${persistError}`,
      errorCode: 'persist_failed',
    };
  }

  const promotedTools = runtime.setPromotedExtendedToolNames(next);
  runtime.applyActiveToolsToAgent();
  return {
    ok: true,
    changed: true,
    promotedTools,
    message: `Removed the presentation-order pin for "${normalizedName}".`,
  };
}

export async function swapPromotedExtendedTools(
  fromSlot: number,
  toSlot: number,
  runtime: PromotedToolMutationRuntime,
): Promise<PromotedToolMutationResult> {
  const current = runtime.getPromotedExtendedToolNames();
  if (
    !Number.isInteger(fromSlot)
    || !Number.isInteger(toSlot)
    || fromSlot < 1
    || toSlot < 1
    || fromSlot > current.length
    || toSlot > current.length
  ) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Slots must be integers between 1 and ${current.length}.`,
      errorCode: 'invalid_slot',
    };
  }

  if (fromSlot === toSlot) {
    return {
      ok: true,
      changed: false,
      promotedTools: current,
      message: 'Swap slots are identical; no change made.',
    };
  }

  const fromIndex = fromSlot - 1;
  const toIndex = toSlot - 1;
  const next = [...current];
  const fromTool = next[fromIndex];
  const toTool = next[toIndex];
  if (!fromTool || !toTool) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Slots must be integers between 1 and ${current.length}.`,
      errorCode: 'invalid_slot',
    };
  }
  next[fromIndex] = toTool;
  next[toIndex] = fromTool;

  const persistError = await runtime.persistPromotedExtendedToolNames(next);
  if (persistError) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Failed to persist pinned tool ordering: ${persistError}`,
      errorCode: 'persist_failed',
    };
  }

  const promotedTools = runtime.setPromotedExtendedToolNames(next);
  runtime.applyActiveToolsToAgent();
  return {
    ok: true,
    changed: true,
    promotedTools,
    message: `Swapped pinned tool-order slots ${fromSlot} and ${toSlot}.`,
  };
}
