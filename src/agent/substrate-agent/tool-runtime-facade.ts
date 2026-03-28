import type { Agent, AgentTool } from '@mariozechner/pi-agent-core';
import { tagToolWithReversibility } from '../../system/capabilities/safeguards.js';
import type { CapabilityAccess } from '../../system/capabilities/gate.js';
import type {
  CorrelationMetadata,
  ObservabilityCallType,
  SubstrateConfig,
  SubstrateMessage,
} from '../../types.js';
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
  createLoadToolsTool,
  preloadExtendedToolsForTurn,
  type AutoloadTurnOutcome,
  type ExtendedToolActivationOptions,
  type ExtendedToolActivationResult,
} from './adaptive-tools-runtime.js';
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

  createLoadToolsTool(): AgentTool<any> {
    return createLoadToolsTool({
      getExtendedTools: () => this.extendedTools,
      getExtendedToolAutoloadPolicy: () => this.extendedToolAutoloadPolicy,
      getActiveTurnCorrelation: () => this.getActiveTurnCorrelation(),
      getActiveTurnTaskKind: () => this.getActiveTurnTaskKind(),
      getActiveTurnIntent: () => this.getActiveTurnIntent(),
      activateExtendedTools: (toolNames, options) => this.activateExtendedTools(toolNames, options),
      resolveSessionChannelId: (channelId) => this.resolveSessionChannelId(channelId),
      withAdaptiveCorrelation: (correlation, purpose) => this.withAdaptiveCorrelation(correlation, purpose),
      emitAdaptiveToolDecision: (payload) => this.emitAdaptiveToolDecision(payload),
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
    const resolution = this.resolveActiveTools(autoloadOutcome.skipped);
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

    if (mode === 'gateway' && gatewayClient) {
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
    const resolution = this.resolveActiveTools();
    applyActiveToolsToAgent({
      resolution,
      withCapabilityGates: tools => this.withCapabilityGates(tools),
      setAgentTools: tools => this.agent.setTools(tools),
    });
  }
}

export type {
  PromotedToolMutationErrorCode,
  PromotedToolMutationResult,
};
