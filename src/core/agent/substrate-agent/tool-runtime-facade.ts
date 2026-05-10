import type { Agent, AgentTool } from '@mariozechner/pi-agent-core';
import { tagToolWithReversibility } from '../../../system/capabilities/safeguards.js';
import type { CapabilityAccess } from '../../../system/capabilities/gate.js';
import type { CorrelationMetadata, ObservabilityCallType, SubstrateMessage } from '../../../shared/contracts/runtime.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { textResultWithError } from '../../tools/results.js';
import type { ToolCategory } from '../tool-registrar.js';
import type {
  AdaptiveLoadedExtendedToolState,
  AdaptiveToolActivationSource,
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotSkip,
  AdaptiveToolSnapshotTelemetry,
} from '../adaptive-tools-telemetry.js';
import {
  createDefaultExtendedToolAutoloadPolicy,
  type ExtendedToolAutoloadPolicy,
} from '../extended-tool-autoload-policy.js';
import {
  activateExtendedToolsForTurn,
  createToolsetTool,
  createToolSearchTool,
  preloadExtendedToolsForTurn,
  type AutoloadTurnOutcome,
  type ExtendedToolActivationOptions,
  type ExtendedToolActivationResult,
} from './adaptive-tools-runtime.js';
import type { MemoryWriter } from '../../../faculties/memory/writer.js';
import {
  addPromotedExtendedTool,
  applyActiveToolsToAgent,
  buildAdaptiveToolRuntimeState,
  buildAdaptiveToolSnapshot,
  classifyExtendedToolForTurn,
  emitAdaptiveToolSnapshotDecisions,
  getExtendedToolByName,
  getPromotedExtendedToolNames,
  getPromotedExtendedToolsLimit,
  persistPromotedExtendedToolNames,
  removePromotedExtendedTool,
  resolveActiveTools,
  resolvePromotedToolActivation,
  setPromotedExtendedToolNames,
  swapPromotedExtendedTools,
  trackLoadedExtendedTool,
  withToolConcurrencyMetadata,
  type ActiveToolResolution,
  type PromotedToolMutationErrorCode,
  type PromotedToolMutationResult,
  type PromotedToolResolution,
} from './tool-orchestration-runtime.js';
import {
  extractGatewayMethods,
  validateAndLogToolWiring,
  cloneToolWiringMeta,
  type GatewayToolMetadataCoverage,
  type RuntimeMode,
  type ValidateToolsOptions,
  type WirableTool,
} from '../tool-wiring-validator.js';
import type { RuntimeServiceHealthStatus } from '../../../operator/tool-health/types.js';
import type { RuntimeToolCatalogSnapshot } from '../tool-catalog.js';

interface ToolRuntimeFacadeOptions {
  config: SubstrateConfig;
  agent: Agent;
  resolveCapabilityAccess: () => CapabilityAccess;
  withCapabilityGates: (tools: AgentTool<any>[]) => AgentTool<any>[];
  withCorrelationPurpose: (
    correlation: CorrelationMetadata,
    purpose: string,
  ) => CorrelationMetadata;
  withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
  emitAdaptiveToolDecision: (
    payload: Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>,
  ) => void;
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  resolveSessionChannelId: (channelId: string) => string;
  getActiveTurnCorrelation: () => CorrelationMetadata | null;
  getActiveTurnTaskKind: () => string | null;
  getActiveTurnIntent: () => string | null;
}

interface MaintenanceCoreToolPolicy {
  readonly allowedActions: readonly string[];
  readonly resolveAction: (params: Record<string, unknown>) => string | null;
}

const MAINTENANCE_CORE_TOOL_POLICIES = new Map<string, MaintenanceCoreToolPolicy>([
  ['contact', {
    allowedActions: ['list', 'lookup'],
    resolveAction: resolveMaintenanceContactAction,
  }],
  ['identity', {
    allowedActions: ['list_layers', 'get_layer', 'diff_layer', 'history'],
    resolveAction: resolveMaintenanceIdentityAction,
  }],
  ['session', {
    allowedActions: ['list', 'search', 'grep'],
    resolveAction: resolveMaintenanceSessionAction,
  }],
  ['system', {
    allowedActions: ['read'],
    resolveAction: resolveMaintenanceSystemAction,
  }],
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMaintenanceToolRestrictedTaskKind(taskKind: string | null | undefined): boolean {
  return taskKind === 'heartbeat' || taskKind === 'reflection';
}

function resolveMaintenanceIdentityAction(params: Record<string, unknown>): string | null {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    return Object.keys(params).length === 0 ? 'list_layers' : null;
  }
  switch (rawAction) {
    case 'list_layers':
    case 'get_layer':
    case 'diff_layer':
    case 'history':
    case 'update_layer':
    case 'rollback_layer':
    case 'toggle_layer':
    case 'update_persona':
    case 'commit_stage':
    case 'cancel_stage':
      return rawAction;
    default:
      return null;
  }
}

function resolveMaintenanceSystemAction(params: Record<string, unknown>): string | null {
  const action = typeof params.action === 'string' ? params.action.trim() : '';
  switch (action) {
    case '':
    case 'read':
    case 'settings_get':
      return 'read';
    case 'restart':
    case 'self_restart':
      return 'restart';
    case 'rebuild':
    case 'self_rebuild':
      return 'rebuild';
    default:
      return null;
  }
}

function resolveMaintenanceSessionAction(params: Record<string, unknown>): string | null {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    const hasNonListParams = Object.entries(params).some(([key, value]) => (
      key !== 'action'
      && key !== 'limit'
      && value !== undefined
    ));
    return hasNonListParams ? null : 'list';
  }
  switch (rawAction) {
    case 'list':
    case 'session_list':
      return 'list';
    case 'new':
    case 'session_new':
      return 'new';
    case 'resume':
    case 'session_resume':
      return 'resume';
    case 'search':
    case 'session_search':
      return 'search';
    case 'grep':
    case 'session_grep':
      return 'grep';
    case 'start_focus':
    case 'focus_start':
      return 'start_focus';
    case 'complete_focus':
    case 'focus_complete':
      return 'complete_focus';
    default:
      return null;
  }
}

function resolveMaintenanceContactAction(params: Record<string, unknown>): string | null {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    const nonActionKeys = Object.entries(params)
      .filter(([key, value]) => key !== 'action' && value !== undefined)
      .map(([key]) => key);
    if (nonActionKeys.length === 0) {
      return 'list';
    }
    if (nonActionKeys.length === 1 && nonActionKeys[0] === 'contactId') {
      return 'lookup';
    }
    return null;
  }
  switch (rawAction) {
    case 'list':
    case 'contact_list':
      return 'list';
    case 'lookup':
    case 'contact_lookup':
      return 'lookup';
    case 'note':
    case 'contact_note':
      return 'note';
    case 'set_trust':
    case 'contact_set_trust':
      return 'set_trust';
    case 'link_identity':
    case 'contact_link_identity':
      return 'link_identity';
    case 'set_channel_privacy':
    case 'contact_set_channel_privacy':
      return 'set_channel_privacy';
    default:
      return null;
  }
}

export class ToolRuntimeFacade {
  private readonly config: SubstrateConfig;
  private readonly agent: Agent;
  private readonly resolveCapabilityAccess: () => CapabilityAccess;
  private readonly withCapabilityGates: (tools: AgentTool<any>[]) => AgentTool<any>[];
  private readonly withCorrelationPurpose: (
    correlation: CorrelationMetadata,
    purpose: string,
  ) => CorrelationMetadata;
  private readonly withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
  private readonly emitAdaptiveToolDecision: (
    payload: Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>,
  ) => void;
  private readonly emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  private readonly resolveSessionChannelId: (channelId: string) => string;
  private readonly getActiveTurnCorrelation: () => CorrelationMetadata | null;
  private readonly getActiveTurnTaskKind: () => string | null;
  private readonly getActiveTurnIntent: () => string | null;

  private coreTools: AgentTool<any>[] = [];
  private extendedTools: AgentTool<any>[] = [];
  private loadedExtended = new Map<string, AdaptiveLoadedExtendedToolState>();
  private extendedToolAutoloadPolicy: ExtendedToolAutoloadPolicy | null = createDefaultExtendedToolAutoloadPolicy();
  private lastAdaptiveToolSnapshot: AdaptiveToolSnapshotTelemetry | null = null;
  private getToolsetMemoryWriter: (() => Pick<MemoryWriter, 'write'> | undefined) | undefined;
  private toolHealthStatusByName = new Map<string, RuntimeServiceHealthStatus>();

  constructor(options: ToolRuntimeFacadeOptions) {
    this.config = options.config;
    this.agent = options.agent;
    this.resolveCapabilityAccess = options.resolveCapabilityAccess;
    this.withCapabilityGates = options.withCapabilityGates;
    this.withCorrelationPurpose = options.withCorrelationPurpose;
    this.withAdaptiveCorrelation = options.withAdaptiveCorrelation;
    this.emitAdaptiveToolDecision = options.emitAdaptiveToolDecision;
    this.emitTelemetry = options.emitTelemetry;
    this.resolveSessionChannelId = options.resolveSessionChannelId;
    this.getActiveTurnCorrelation = options.getActiveTurnCorrelation;
    this.getActiveTurnTaskKind = options.getActiveTurnTaskKind;
    this.getActiveTurnIntent = options.getActiveTurnIntent;
  }

  registerTool(tool: AgentTool<any>, category: ToolCategory = 'core'): void {
    const taggedTool = this.withToolConcurrencyMetadata(tagToolWithReversibility(tool), category);
    if (category === 'core') {
      this.coreTools.push(taggedTool);
      return;
    }
    this.extendedTools.push(taggedTool);
  }

  getPromotedExtendedToolsLimit(): number {
    return getPromotedExtendedToolsLimit();
  }

  getPromotedExtendedTools(): readonly string[] {
    return [...this.getPromotedExtendedToolNamesInternal()];
  }

  persistPromotedExtendedTools(next: readonly string[]): string | null {
    return this.persistPromotedExtendedToolNames(next);
  }

  addPromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    return addPromotedExtendedTool(toolName, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      classifyExtendedToolForTurn: (name) => this.classifyExtendedToolForTurn(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  removePromotedExtendedTool(toolName: string): PromotedToolMutationResult {
    return removePromotedExtendedTool(toolName, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      classifyExtendedToolForTurn: (name) => this.classifyExtendedToolForTurn(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  swapPromotedExtendedTools(fromSlot: number, toSlot: number): PromotedToolMutationResult {
    return swapPromotedExtendedTools(fromSlot, toSlot, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      classifyExtendedToolForTurn: (name) => this.classifyExtendedToolForTurn(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return {
      core: [...this.coreTools],
      extended: [...this.extendedTools],
    };
  }

  getToolCatalogSnapshot(): RuntimeToolCatalogSnapshot {
    const toSnapshotEntry = (tool: AgentTool<any>, scope: 'core' | 'extended') => {
      const wiringMeta = cloneToolWiringMeta((tool as WirableTool).wiringMeta);
      return {
        name: tool.name,
        description: tool.description,
        scope,
        ...(wiringMeta ? { wiringMeta } : {}),
      };
    };

    return {
      generatedAt: Date.now(),
      tools: [
        ...this.coreTools.map(tool => toSnapshotEntry(tool, 'core')),
        ...this.extendedTools.map(tool => toSnapshotEntry(tool, 'extended')),
      ],
    };
  }

  getAdaptiveToolRuntimeState(): AdaptiveToolRuntimeState {
    const promotedResolution = this.resolvePromotedToolActivation();
    const activeResolution = this.resolveActiveTools();

    return buildAdaptiveToolRuntimeState({
      coreTools: this.coreTools,
      extendedTools: this.extendedTools,
      loadedExtended: this.loadedExtended,
      promotedToolsConfigured: this.getPromotedExtendedToolNamesInternal(),
      promotedResolution,
      activeResolution,
      lastSnapshot: this.lastAdaptiveToolSnapshot,
    });
  }

  getToolHealthStatusByName(): ReadonlyMap<string, RuntimeServiceHealthStatus> {
    return this.toolHealthStatusByName;
  }

  setToolHealthStatusByName(next: ReadonlyMap<string, RuntimeServiceHealthStatus>): void {
    this.toolHealthStatusByName = new Map(next);
  }

  activateExtendedTools(
    toolNames: readonly string[],
    options: ExtendedToolActivationOptions = {},
  ): ExtendedToolActivationResult {
    return activateExtendedToolsForTurn({
      toolNames,
      options,
      extendedTools: this.extendedTools,
      trackLoadedExtendedTool: (toolName, source) => this.trackLoadedExtendedTool(toolName, source),
      emitAdaptiveToolDecision: (payload) => this.emitAdaptiveToolDecision(payload),
      withAdaptiveCorrelation: (correlation, purpose) => this.withAdaptiveCorrelation(correlation, purpose),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  setExtendedToolAutoloadPolicy(policy: ExtendedToolAutoloadPolicy | null): void {
    this.extendedToolAutoloadPolicy = policy;
  }

  setToolsetMemoryWriter(getMemoryWriter: () => Pick<MemoryWriter, 'write'> | undefined): void {
    this.getToolsetMemoryWriter = getMemoryWriter;
  }

  createToolsetTool(): AgentTool<any> {
    return createToolsetTool({
      getExtendedTools: () => this.extendedTools,
      getExtendedToolAutoloadPolicy: () => this.extendedToolAutoloadPolicy,
      getAdaptiveToolRuntimeState: () => this.getAdaptiveToolRuntimeState(),
      getActiveTurnCorrelation: () => this.getActiveTurnCorrelation(),
      getActiveTurnTaskKind: () => this.getActiveTurnTaskKind(),
      getActiveTurnIntent: () => this.getActiveTurnIntent(),
      getPromotedExtendedToolsLimit: () => this.getPromotedExtendedToolsLimit(),
      getPromotedExtendedTools: () => this.getPromotedExtendedTools(),
      setPromotedExtendedTools: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedTools: (next) => this.persistPromotedExtendedToolNames(next),
      addPromotedExtendedTool: (toolName) => this.addPromotedExtendedTool(toolName),
      removePromotedExtendedTool: (toolName) => this.removePromotedExtendedTool(toolName),
      getMemoryWriter: () => this.getToolsetMemoryWriter?.(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
      activateExtendedTools: (toolNames, options) => this.activateExtendedTools(toolNames, options),
      resolveSessionChannelId: (channelId) => this.resolveSessionChannelId(channelId),
      withAdaptiveCorrelation: (correlation, purpose) => this.withAdaptiveCorrelation(correlation, purpose),
      emitAdaptiveToolDecision: (payload) => this.emitAdaptiveToolDecision(payload),
      emitTelemetry: (event, payload) => this.emitTelemetry(event, payload),
    });
  }

  createToolSearchTool(): AgentTool<any> {
    return createToolSearchTool({
      getExtendedTools: () => this.extendedTools,
      getAdaptiveToolRuntimeState: () => this.getAdaptiveToolRuntimeState(),
      getToolHealthStatusByName: () => this.getToolHealthStatusByName(),
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      emitTelemetry: (event, payload) => this.emitTelemetry(event, payload),
    });
  }

  preloadExtendedToolsForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    correlation: CorrelationMetadata,
  ): AutoloadTurnOutcome {
    return preloadExtendedToolsForTurn({
      message,
      taskKind,
      correlation,
      policy: this.extendedToolAutoloadPolicy,
      extendedTools: this.extendedTools,
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      trackLoadedExtendedTool: (toolName, source) => this.trackLoadedExtendedTool(toolName, source),
      emitTelemetry: (event, payload) => this.emitTelemetry(event, payload),
      emitAdaptiveToolDecision: (payload) => this.emitAdaptiveToolDecision(payload),
      withCorrelationPurpose: (contextCorrelation, purpose) => this.withCorrelationPurpose(contextCorrelation, purpose),
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
    });
  }

  applyActiveToolsToAgentForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    callType: ObservabilityCallType,
    correlation: CorrelationMetadata,
    autoloadOutcome: AutoloadTurnOutcome,
  ): void {
    const resolution = this.applyMaintenanceCoreToolPolicy(
      this.resolveActiveTools(autoloadOutcome.skipped),
      taskKind,
      correlation,
    );
    applyActiveToolsToAgent({
      resolution,
      withCapabilityGates: tools => this.withCapabilityGates(tools),
      setAgentTools: tools => this.agent.setTools(tools),
    });

    const snapshot = buildAdaptiveToolSnapshot({
      message,
      taskKind,
      callType,
      correlation,
      autoloadOutcome,
      resolution,
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
    });
    this.lastAdaptiveToolSnapshot = snapshot;
    this.emitTelemetry('agent.tools.adaptive.snapshot', snapshot as unknown as Record<string, unknown>);

    emitAdaptiveToolSnapshotDecisions({
      snapshot,
      correlation,
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
      emitAdaptiveToolDecision: payload => this.emitAdaptiveToolDecision(payload),
    });
  }

  validateToolWiring(
    mode: RuntimeMode,
    gatewayClient?: object,
    requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage,
  ): void {
    const allTools = [...this.coreTools, ...this.extendedTools];
    const options: ValidateToolsOptions = {
      mode,
      tools: allTools,
      requiredGatewayMetadataCoverage,
      requireConcurrencyMetadata: true,
    };

    if (gatewayClient) {
      options.gatewayClientMethods = extractGatewayMethods(gatewayClient);
    }

    const disabledNames = validateAndLogToolWiring(options);
    if (disabledNames.length === 0) return;

    const disabledSet = new Set(disabledNames);
    this.coreTools = this.coreTools.filter(t => !disabledSet.has(t.name));
    this.extendedTools = this.extendedTools.filter(t => !disabledSet.has(t.name));
    for (const disabledName of disabledSet) {
      this.loadedExtended.delete(disabledName);
    }
    const filteredPromoted = this
      .getPromotedExtendedToolNamesInternal()
      .filter(name => !disabledSet.has(name));
    this.setPromotedExtendedToolNamesInternal(filteredPromoted);
  }

  getExtendedTools(): readonly AgentTool<any>[] {
    return this.extendedTools;
  }

  getLoadedExtendedTools(): ReadonlyMap<string, AdaptiveLoadedExtendedToolState> {
    return this.loadedExtended;
  }

  getCapabilityEligiblePromotedToolNames(): Set<string> {
    return this.resolvePromotedToolActivation().activeNames;
  }

  classifyExtendedToolForTurn(toolName: string) {
    return classifyExtendedToolForTurn(
      toolName,
      this.extendedToolAutoloadPolicy?.classifyToolForTurn ?? null,
    );
  }

  resolveActiveToolCounts(): AdaptiveToolSnapshotTelemetry['counts'] {
    return this.resolveActiveTools().counts;
  }

  private withToolConcurrencyMetadata(tool: AgentTool<any>, category: ToolCategory): AgentTool<any> {
    return withToolConcurrencyMetadata(tool, category);
  }

  private getPromotedExtendedToolNamesInternal(): string[] {
    return getPromotedExtendedToolNames(this.config);
  }

  private setPromotedExtendedToolNamesInternal(next: readonly string[]): string[] {
    return setPromotedExtendedToolNames(this.config, next);
  }

  setPromotedExtendedTools(next: readonly string[]): string[] {
    return this.setPromotedExtendedToolNamesInternal(next);
  }

  private persistPromotedExtendedToolNames(next: readonly string[]): string | null {
    return persistPromotedExtendedToolNames(this.config, next);
  }

  private getExtendedToolByName(name: string): AgentTool<any> | null {
    return getExtendedToolByName(this.extendedTools, name);
  }

  private resolvePromotedToolActivation(): PromotedToolResolution {
    return resolvePromotedToolActivation({
      promotedTools: this.getPromotedExtendedToolNamesInternal(),
      extendedTools: this.extendedTools,
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
    });
  }

  private trackLoadedExtendedTool(
    toolName: string,
    source: Extract<AdaptiveToolActivationSource, 'extended_loaded' | 'autoload' | 'deferred'>,
  ): 'activated' | 'already_active' {
    return trackLoadedExtendedTool(this.loadedExtended, toolName, source);
  }

  private resolveActiveTools(
    additionalSkipped: AdaptiveToolSnapshotSkip[] = [],
  ): ActiveToolResolution {
    return resolveActiveTools({
      coreTools: this.coreTools,
      extendedTools: this.extendedTools,
      loadedExtended: this.loadedExtended,
      promotedResolution: this.resolvePromotedToolActivation(),
      classifyExtendedToolForTurn: (toolName) => this.classifyExtendedToolForTurn(toolName),
      additionalSkipped,
    });
  }

  private applyActiveToolsToAgent(): void {
    const resolution = this.applyMaintenanceCoreToolPolicy(
      this.resolveActiveTools(),
      this.getActiveTurnTaskKind(),
      this.getActiveTurnCorrelation(),
    );
    applyActiveToolsToAgent({
      resolution,
      withCapabilityGates: tools => this.withCapabilityGates(tools),
      setAgentTools: tools => this.agent.setTools(tools),
    });
  }

  private applyMaintenanceCoreToolPolicy(
    resolution: ActiveToolResolution,
    taskKind: string | null | undefined,
    correlation: CorrelationMetadata | null,
  ): ActiveToolResolution {
    if (!isMaintenanceToolRestrictedTaskKind(taskKind)) {
      return resolution;
    }

    const sourceByToolName = new Map(
      resolution.snapshotTools.map((entry) => [entry.toolName, entry.source] as const),
    );
    const filteredTools: AgentTool<any>[] = [];
    const filteredSnapshotTools: AdaptiveToolSnapshotTool[] = [];

    for (const tool of resolution.tools) {
      const source = sourceByToolName.get(tool.name);
      if (source !== 'core') {
        filteredTools.push(tool);
        if (source) {
          filteredSnapshotTools.push({ toolName: tool.name, source });
        }
        continue;
      }

      const guardedTool = this.createMaintenanceGuardedCoreTool(tool, taskKind, correlation);
      if (!guardedTool) {
        this.emitTelemetry('agent.tools.core_guardrail.skipped', {
          ...this.withAdaptiveCorrelation(correlation ?? undefined, 'agent.tools.core_guardrail.skipped'),
          toolName: tool.name,
          taskKind,
          reason: 'maintenance_turn_allowlist',
        });
        continue;
      }

      filteredTools.push(guardedTool);
      filteredSnapshotTools.push({ toolName: guardedTool.name, source: 'core' });
    }

    const counts: AdaptiveToolSnapshotTelemetry['counts'] = {
      core: 0,
      promoted: 0,
      extendedLoaded: 0,
      autoload: 0,
      deferred: 0,
      total: filteredSnapshotTools.length,
    };
    for (const entry of filteredSnapshotTools) {
      if (entry.source === 'core') counts.core += 1;
      else if (entry.source === 'promoted') counts.promoted += 1;
      else if (entry.source === 'extended_loaded') counts.extendedLoaded += 1;
      else if (entry.source === 'autoload') counts.autoload += 1;
      else counts.deferred += 1;
    }

    return {
      tools: filteredTools,
      snapshotTools: filteredSnapshotTools,
      promotedSkipped: resolution.promotedSkipped.map(entry => ({
        ...entry,
        ...(entry.missingTokens ? { missingTokens: [...entry.missingTokens] } : {}),
      })),
      counts,
    };
  }

  private createMaintenanceGuardedCoreTool(
    tool: AgentTool<any>,
    taskKind: string,
    correlation: CorrelationMetadata | null,
  ): AgentTool<any> | null {
    const policy = MAINTENANCE_CORE_TOOL_POLICIES.get(tool.name);
    if (!policy) {
      return null;
    }

    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
        const normalizedParams = isPlainRecord(params) ? params : {};
        const requestedAction = policy.resolveAction(normalizedParams);
        if (!requestedAction || !policy.allowedActions.includes(requestedAction)) {
          this.emitTelemetry('agent.tools.core_guardrail.denied', {
            ...this.withAdaptiveCorrelation(correlation ?? undefined, 'agent.tools.core_guardrail.denied'),
            toolName: tool.name,
            taskKind,
            requestedAction: requestedAction ?? null,
            allowedActions: [...policy.allowedActions],
            reason: 'maintenance_turn_allowlist',
          });
          return textResultWithError(
            `${tool.name} is limited to read-only introspection during ${taskKind} turns. `
            + `Allowed actions: ${policy.allowedActions.join(', ')}.`,
            true,
          );
        }
        return tool.execute(toolCallId, params, signal);
      },
    };
  }
}

export type {
  PromotedToolMutationErrorCode,
  PromotedToolMutationResult,
};
