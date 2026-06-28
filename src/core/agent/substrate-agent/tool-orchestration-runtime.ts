import type { AgentTool } from '@mariozechner/pi-agent-core';
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
  AdaptiveLoadedExtendedToolState,
  AdaptiveToolActivationSource,
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotSkip,
  AdaptiveToolSnapshotTelemetry,
  AdaptiveToolSnapshotTool,
} from '../adaptive-tools-telemetry.js';
import {
  classifyExtendedToolForTurn as classifyDefaultExtendedToolForTurn,
  type ExtendedToolTurnClass,
} from '../extended-tool-autoload-policy.js';
import type { ToolCategory } from '../tool-registrar.js';
import type {
  ToolConcurrencyClass,
  ToolConcurrencyMeta,
  ToolExecutionEligibility,
  ToolInterruptibility,
  WirableTool,
} from '../tool-wiring-validator.js';
import type {
  AutoloadTurnOutcome,
  PromotedToolMutationResult,
} from './tool-runtime-contracts.js';
export type { PromotedToolMutationResult } from './tool-runtime-contracts.js';

export type PromotedToolMutationErrorCode =
  | 'invalid_name'
  | 'tool_not_extended'
  | 'duplicate'
  | 'max_slots'
  | 'background_only'
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
  skipped: AdaptiveToolSnapshotSkip[];
}

type LoadedToolSource = Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>;

const LOADED_TOOL_SOURCE_PRIORITY: Record<LoadedToolSource, number> = {
  autoload: 1,
  extended_loaded: 2,
  deferred: 3,
};

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
  toolName: string,
  category: ToolCategory,
): ToolExecutionEligibility {
  if (category === 'extended' && classifyDefaultExtendedToolForTurn(toolName) === 'background') {
    return {
      foreground: false,
      background: true,
    };
  }
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

export function persistPromotedExtendedToolNames(
  config: Pick<SubstrateConfig, 'runtimeHooks'>,
  next: readonly string[],
): string | null {
  const persist = config.runtimeHooks?.persistPromotedExtendedTools;
  if (!persist) return null;
  try {
    persist([...next]);
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

export function classifyExtendedToolForTurn(
  toolName: string,
  classifier: ((toolName: string) => ExtendedToolTurnClass) | null | undefined,
): ExtendedToolTurnClass {
  if (!classifier) {
    return classifyDefaultExtendedToolForTurn(toolName);
  }
  return classifier(toolName);
}

interface ResolvePromotedToolActivationParams {
  promotedTools: readonly string[];
  extendedTools: readonly AgentTool<any>[];
  resolveCapabilityAccess: () => CapabilityAccess;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
}

export function resolvePromotedToolActivation(
  params: ResolvePromotedToolActivationParams,
): PromotedToolResolution {
  const access = params.resolveCapabilityAccess();
  const activeNames = new Set<string>();
  const skipped: AdaptiveToolSnapshotSkip[] = [];
  for (const toolName of params.promotedTools) {
    const tool = getExtendedToolByName(params.extendedTools, toolName);
    if (!tool) {
      skipped.push({
        toolName,
        source: 'promoted',
        reason: 'not_registered',
      });
      continue;
    }
    if (params.classifyExtendedToolForTurn(tool.name) !== 'overlay') {
      skipped.push({
        toolName: tool.name,
        source: 'promoted',
        reason: 'background_only',
      });
      continue;
    }
    const eligibility = evaluateToolCapabilityEligibility(tool, {}, access);
    if (!eligibility.allowed) {
      skipped.push({
        toolName: tool.name,
        source: 'promoted',
        reason: 'capability_denied',
        ...(eligibility.missingTokens.length > 0 ? { missingTokens: eligibility.missingTokens } : {}),
      });
      continue;
    }
    activeNames.add(tool.name);
  }
  return {
    activeNames,
    skipped,
  };
}

export function trackLoadedExtendedTool(
  loadedExtended: Map<string, AdaptiveLoadedExtendedToolState>,
  toolName: string,
  source: LoadedToolSource,
): 'activated' | 'already_active' {
  const now = Date.now();
  const existing = loadedExtended.get(toolName);
  if (!existing) {
    loadedExtended.set(toolName, {
      toolName,
      source,
      activatedAt: now,
      lastActivatedAt: now,
    });
    return 'activated';
  }

  const shouldPromoteSource = LOADED_TOOL_SOURCE_PRIORITY[source] > LOADED_TOOL_SOURCE_PRIORITY[existing.source];
  loadedExtended.set(toolName, {
    ...existing,
    source: shouldPromoteSource ? source : existing.source,
    lastActivatedAt: now,
  });
  return 'already_active';
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
  loadedExtended: ReadonlyMap<string, AdaptiveLoadedExtendedToolState>;
  promotedResolution: PromotedToolResolution;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  additionalSkipped?: AdaptiveToolSnapshotSkip[];
}

export function resolveActiveTools(
  params: ResolveActiveToolsParams,
): ActiveToolResolution {
  const activeByName = new Map<string, { tool: AgentTool<any>; source: AdaptiveToolActivationSource }>();
  for (const tool of params.coreTools) {
    if (!activeByName.has(tool.name)) {
      activeByName.set(tool.name, {
        tool,
        source: 'core',
      });
    }
  }

  for (const tool of params.extendedTools) {
    if (params.classifyExtendedToolForTurn(tool.name) !== 'overlay') {
      continue;
    }
    const loaded = params.loadedExtended.get(tool.name);
    const source: AdaptiveToolActivationSource | null = params.promotedResolution.activeNames.has(tool.name)
      ? 'promoted'
      : (loaded?.source ?? null);
    if (!source) {
      continue;
    }
    if (!activeByName.has(tool.name)) {
      activeByName.set(tool.name, {
        tool,
        source,
      });
    }
  }

  const orderedActiveEntries = [...activeByName.values()]
    .sort((left, right) => left.tool.name.localeCompare(right.tool.name));

  const snapshotTools: AdaptiveToolSnapshotTool[] = orderedActiveEntries
    .map((entry) => ({
      toolName: entry.tool.name,
      source: entry.source,
    }));

  const counts: AdaptiveToolSnapshotTelemetry['counts'] = {
    core: 0,
    promoted: 0,
    extendedLoaded: 0,
    autoload: 0,
    deferred: 0,
    total: snapshotTools.length,
  };
  for (const entry of snapshotTools) {
    if (entry.source === 'core') counts.core += 1;
    else if (entry.source === 'promoted') counts.promoted += 1;
    else if (entry.source === 'extended_loaded') counts.extendedLoaded += 1;
    else if (entry.source === 'autoload') counts.autoload += 1;
    else counts.deferred += 1;
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
  autoloadOutcome: AutoloadTurnOutcome;
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
    intent: params.autoloadOutcome.intent,
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
    if (skip.source !== 'promoted') continue;
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
  loadedExtended: ReadonlyMap<string, AdaptiveLoadedExtendedToolState>;
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
    loadedExtendedTools: [...params.loadedExtended.values()].map(entry => ({
      ...entry,
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
  persistPromotedExtendedToolNames: (next: readonly string[]) => string | null;
  getExtendedToolByName: (toolName: string) => AgentTool<any> | null;
  classifyExtendedToolForTurn: (toolName: string) => ExtendedToolTurnClass;
  resolveCapabilityAccess: () => CapabilityAccess;
  applyActiveToolsToAgent: () => void;
}

export function addPromotedExtendedTool(
  toolName: string,
  runtime: PromotedToolMutationRuntime,
): PromotedToolMutationResult {
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
      message: `Tool "${normalizedName}" is already promoted.`,
      errorCode: 'duplicate',
    };
  }

  if (current.length >= PROMOTED_EXTENDED_TOOL_SLOTS_MAX) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Promoted tool slots are full (max ${PROMOTED_EXTENDED_TOOL_SLOTS_MAX}).`,
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
  if (runtime.classifyExtendedToolForTurn(tool.name) !== 'overlay') {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Tool "${normalizedName}" is background-only and cannot be promoted.`,
      errorCode: 'background_only',
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
  const persistError = runtime.persistPromotedExtendedToolNames(next);
  if (persistError) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Failed to persist promoted tools: ${persistError}`,
      errorCode: 'persist_failed',
    };
  }

  const promotedTools = runtime.setPromotedExtendedToolNames(next);
  runtime.applyActiveToolsToAgent();
  return {
    ok: true,
    changed: true,
    promotedTools,
    message: `Promoted tool "${normalizedName}".`,
  };
}

export function removePromotedExtendedTool(
  toolName: string,
  runtime: PromotedToolMutationRuntime,
): PromotedToolMutationResult {
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
      message: `Tool "${normalizedName}" is not currently promoted.`,
      errorCode: 'not_found',
    };
  }

  const next = current.filter(name => name !== normalizedName);
  const persistError = runtime.persistPromotedExtendedToolNames(next);
  if (persistError) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Failed to persist promoted tools: ${persistError}`,
      errorCode: 'persist_failed',
    };
  }

  const promotedTools = runtime.setPromotedExtendedToolNames(next);
  runtime.applyActiveToolsToAgent();
  return {
    ok: true,
    changed: true,
    promotedTools,
    message: `Removed promoted tool "${normalizedName}".`,
  };
}

export function swapPromotedExtendedTools(
  fromSlot: number,
  toSlot: number,
  runtime: PromotedToolMutationRuntime,
): PromotedToolMutationResult {
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

  const persistError = runtime.persistPromotedExtendedToolNames(next);
  if (persistError) {
    return {
      ok: false,
      changed: false,
      promotedTools: current,
      message: `Failed to persist promoted tools: ${persistError}`,
      errorCode: 'persist_failed',
    };
  }

  const promotedTools = runtime.setPromotedExtendedToolNames(next);
  runtime.applyActiveToolsToAgent();
  return {
    ok: true,
    changed: true,
    promotedTools,
    message: `Swapped promoted tool slots ${fromSlot} and ${toSlot}.`,
  };
}
