import { AsyncLocalStorage } from 'node:async_hooks';
import type { Agent, AgentTool } from '../../../boundary/pi-agent/index.js';
import { tagToolWithReversibility } from '../../../system/capabilities/safeguards.js';
import { assertToolsHaveDeclaredCapabilityPolicies } from '../../../system/capabilities/requirements.js';
import type { CapabilityAccess } from '../../../system/capabilities/gate.js';
import type {
  CorrelationMetadata,
  IcpAutonomyCandidateOrigin,
  ObservabilityCallType,
  SubstrateMessage,
} from '../../../shared/contracts/runtime.js';
import type { IntakeEnvelopeSnapshot } from '../../../shared/contracts/intake-envelope.js';
import { isRecord } from '../../../shared/utils/types.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import { textResultWithError } from '../../tools/results.js';
import type { ToolCategory } from '../tool-registrar.js';
import type {
  AdaptiveToolDecisionTelemetry,
  AdaptiveToolRuntimeState,
  AdaptiveToolSnapshotSkip,
  AdaptiveToolSnapshotTool,
  AdaptiveToolSnapshotTelemetry,
} from '../adaptive-tools-telemetry.js';
import {
  createToolsetTool,
  createToolSearchTool,
} from './adaptive-tools-runtime.js';
import type { MemoryWriter } from '../../../faculties/memory/writer.js';
import {
  addPromotedExtendedTool,
  applyActiveToolsToAgent,
  buildAdaptiveToolRuntimeState,
  buildAdaptiveToolSnapshot,
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
  withToolConcurrencyMetadata,
  type ActiveToolResolution,
  type PromotedToolMutationErrorCode,
  type PromotedToolMutationResult,
  type PromotedToolResolution,
} from './tool-orchestration-runtime.js';
import type { ToolTurnOutcome } from './tool-runtime-contracts.js';
import { classifyTurnIntent } from '../tool-turn-intent.js';
import {
  extractGatewayMethods,
  validateAndLogToolWiring,
  cloneToolWiringMeta,
  type GatewayToolMetadataCoverage,
  type ToolWiringValidationMode,
  type ValidateToolsOptions,
  type WirableTool,
} from '../tool-wiring-validator.js';
import {
  assertNoRetiredFirstPartyToolAliases,
  getCanonicalToolSurface,
  getRetiredToolAlias,
} from '../tool-surface/registry.js';
import {
  getCanonicalToolSurfaceDescriptionForActions,
  isCanonicalToolSurfaceDescription,
} from '../tool-surface/descriptions.js';
import { assertPolicyToolHydration } from '../tool-surface/hydration.js';
import type { ToolUsageRanking } from '../tool-surface/usage-ranking.js';
import { createComponentLogger } from '../../../shared/logger.js';
import type { RuntimeServiceHealthStatus } from '../../../operator/tool-health/types.js';
import {
  buildRuntimeToolCatalogEntry,
  type RuntimeToolCatalogSnapshot,
} from '../tool-catalog.js';
import { resolveIcpAutonomyCandidateSchedulerOrigin } from '../../icp/candidate-scheduler-origin.js';
import { getRequestContext } from '../../../primitives/llm/request-context.js';
import { createIcpCandidateScopedNotifyTool } from './icp-candidate-notify-tool.js';

const log = createComponentLogger('tool-runtime-facade');

interface ToolRuntimeFacadeOptions {
  config: SubstrateConfig;
  agent: Agent;
  resolveCapabilityAccess: () => CapabilityAccess;
  withCapabilityGates: (tools: AgentTool<any>[]) => AgentTool<any>[];
  withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
  emitAdaptiveToolDecision: (
    payload: Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>,
  ) => void;
  emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  getActiveTurnCorrelation: () => CorrelationMetadata | null;
  getActiveTurnTaskKind: () => string | null;
}

interface MaintenanceToolPolicy {
  // When present, the tool survives a maintenance-restricted turn but its
  // actions are constrained to this allowlist. When absent, the tool passes
  // through unrestricted (used for expressive tools whose whole point is a
  // single spontaneous action).
  readonly allowedActions?: readonly string[];
  readonly resolveAction?: (params: Record<string, unknown>) => string | null;
  // Turn classes on which this tool survives at all. Defaults to every
  // maintenance-restricted class (heartbeat, reflection, maintenance). Narrow
  // it to scope a tool to specific self-directed turn classes.
  readonly allowedTaskKinds?: readonly string[];
}

interface ToolTurnContext {
  readonly message: SubstrateMessage;
  readonly candidateOrigin?: IcpAutonomyCandidateOrigin;
  candidateScopeActive?: boolean;
  activeTools?: AgentTool<any>[];
  correlation?: CorrelationMetadata;
  taskKind?: string | null;
  intent?: string | null;
  candidateNotifyTool?: AgentTool<any>;
  adaptiveSnapshot?: AdaptiveToolSnapshotTelemetry;
}

const CANDIDATE_TOOL_MUTATION_DENIAL =
  'Trusted ICP candidate turns cannot mutate or widen their exact notify tool surface.';

// Image-tools img2 audit / img1 follow-up: maintenance-restricted turns (heartbeat,
// reflection, maintenance) drop every core tool not listed here. The expressive
// image tools live in core (img1), so without an explicit policy they would be
// dropped from these turns entirely -- killing spontaneous inline self-portraits
// during self-directed thinking. Decision, deliberate per turn class:
//   - heartbeat  -> expressive tools available (unrestricted). Heartbeat is the
//                   self-directed "free-time-flavoured" cognition turn where the
//                   companion decides to reach out; inline generation belongs
//                   here. (free-time/outreach lanes already allow them: their
//                   channels carry no maintenance-restricted taskKind.)
//   - reflection -> NOT available. Silent introspection over memory/self-model;
//                   no outward image expression or heavyweight analysis loop.
//   - maintenance-> NOT available. Pure ops/housekeeping.
const MAINTENANCE_EXPRESSIVE_TASK_KINDS = ['heartbeat'] as const;
const PRIVATE_REFLECTION_TASK_KINDS = ['reflection'] as const;

const MAINTENANCE_TOOL_POLICIES = new Map<string, MaintenanceToolPolicy>([
  ['contact', {
    allowedActions: ['list', 'lookup'],
    resolveAction: resolveMaintenanceContactAction,
  }],
  ['identity', {
    allowedActions: ['list_layers', 'get_layer', 'diff_layer', 'history'],
    resolveAction: resolveMaintenanceIdentityAction,
  }],
  ['memory', {
    allowedActions: ['search', 'episode_search', 'timeline', 'get'],
    resolveAction: resolveMaintenanceMemoryAction,
    allowedTaskKinds: PRIVATE_REFLECTION_TASK_KINDS,
  }],
  ['session', {
    allowedActions: ['list', 'search', 'grep'],
    resolveAction: resolveMaintenanceSessionAction,
  }],
  ['self_status', {
    allowedActions: ['capabilities', 'snapshot', 'diagnose', 'logs'],
    resolveAction: resolveMaintenanceSelfStatusAction,
  }],
  ['system', {
    allowedActions: ['read'],
    resolveAction: resolveMaintenanceSystemAction,
  }],
  ['generate_image', {
    allowedTaskKinds: MAINTENANCE_EXPRESSIVE_TASK_KINDS,
  }],
  ['selfie_create', {
    allowedTaskKinds: MAINTENANCE_EXPRESSIVE_TASK_KINDS,
  }],
]);

const SATELLITE_VISUAL_TOOL_NAMES = new Set([
  'generate_image',
  'selfie_create',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isMaintenanceToolRestrictedTaskKind(taskKind: string | null | undefined): boolean {
  return taskKind === 'heartbeat' || taskKind === 'reflection' || taskKind === 'maintenance';
}

function isRoutineIntentForAnalysisWorkbench(intent: string | null | undefined): boolean {
  return intent === 'memory' || intent === 'ops' || intent === 'reflection';
}

function hasAnalysisWorkbenchEligibleInput(message: SubstrateMessage): boolean {
  const contentExplicitlyRequestsAnalysis = /\banalysis_workbench\b/i.test(message.content)
    || /\blarge[-\s]context\b/i.test(message.content)
    || /\blarge\s+(file|files|codebase|codebases|log|logs|transcript|transcripts|dataset|datasets|evidence\s+set|evidence)\b/i.test(message.content)
    || /\bmulti[-\s]stage\s+analysis\b/i.test(message.content);
  const hasParsedAttachment = message.attachments?.some(
    attachment => typeof attachment.parsedTextPath === 'string'
      && attachment.parsedTextPath.trim().length > 0,
  ) ?? false;

  return contentExplicitlyRequestsAnalysis || hasParsedAttachment;
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
      return 'list';
    case 'new':
      return 'new';
    case 'resume':
      return 'resume';
    case 'search':
      return 'search';
    case 'grep':
      return 'grep';
    case 'start_focus':
      return 'start_focus';
    case 'complete_focus':
      return 'complete_focus';
    default:
      return null;
  }
}

function resolveMaintenanceMemoryAction(params: Record<string, unknown>): string | null {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  return rawAction === 'search'
    || rawAction === 'episode_search'
    || rawAction === 'timeline'
    || rawAction === 'get'
    ? rawAction
    : null;
}

function resolveMaintenanceSelfStatusAction(params: Record<string, unknown>): string | null {
  const rawAction = typeof params.action === 'string' ? params.action.trim() : '';
  if (!rawAction) {
    return 'snapshot';
  }
  return rawAction === 'capabilities'
    || rawAction === 'snapshot'
    || rawAction === 'diagnose'
    || rawAction === 'logs'
    ? rawAction
    : null;
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
      return 'list';
    case 'lookup':
      return 'lookup';
    case 'note':
      return 'note';
    case 'set_trust':
      return 'set_trust';
    case 'link_identity':
      return 'link_identity';
    case 'set_channel_privacy':
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
  private readonly withAdaptiveCorrelation: (
    correlation: CorrelationMetadata | undefined,
    purpose: string,
  ) => Partial<CorrelationMetadata>;
  private readonly emitAdaptiveToolDecision: (
    payload: Omit<AdaptiveToolDecisionTelemetry, 'timestamp'>,
  ) => void;
  private readonly emitTelemetry: (event: string, payload: Record<string, unknown>) => void;
  private readonly getActiveTurnCorrelation: () => CorrelationMetadata | null;
  private readonly getActiveTurnTaskKind: () => string | null;

  private coreTools: AgentTool<any>[] = [];
  private extendedTools: AgentTool<any>[] = [];
  private readonly toolTurnContext = new AsyncLocalStorage<ToolTurnContext>();
  private readonly candidateNotifyDelegateContext = new AsyncLocalStorage<ToolTurnContext>();
  private lastAdaptiveToolSnapshot: AdaptiveToolSnapshotTelemetry | null = null;
  // Durable-usage ordering signal (psfn-framework-b0yl.5), refreshed by the
  // periodic tool-usage evaluator. Presentation-only: it never gates callability
  // and only breaks ties inside a presentation band.
  private toolUsageRanking: ToolUsageRanking | null = null;
  private getToolsetMemoryWriter: (() => Pick<MemoryWriter, 'write'> | undefined) | undefined;
  private toolHealthStatusByName = new Map<string, RuntimeServiceHealthStatus>();

  constructor(options: ToolRuntimeFacadeOptions) {
    this.config = options.config;
    this.agent = options.agent;
    this.resolveCapabilityAccess = options.resolveCapabilityAccess;
    this.withCapabilityGates = options.withCapabilityGates;
    this.withAdaptiveCorrelation = options.withAdaptiveCorrelation;
    this.emitAdaptiveToolDecision = options.emitAdaptiveToolDecision;
    this.emitTelemetry = options.emitTelemetry;
    this.getActiveTurnCorrelation = options.getActiveTurnCorrelation;
    this.getActiveTurnTaskKind = options.getActiveTurnTaskKind;
  }

  registerTool(tool: AgentTool<any>, category: ToolCategory = 'core'): void {
    assertNoRetiredFirstPartyToolAliases([tool.name], `${category} tool registration`);
    const canonicalSurface = getCanonicalToolSurface(tool.name);
    const policyHydration = (tool as WirableTool).wiringMeta?.policyHydration;
    if (policyHydration) {
      assertPolicyToolHydration(
        { core: category === 'core' ? [tool] : [], extended: category === 'extended' ? [tool] : [] },
        [{ toolName: tool.name, enabled: true, ...policyHydration }],
      );
    }
    const scopedDescription = policyHydration
      ? getCanonicalToolSurfaceDescriptionForActions(tool.name, policyHydration.allowedActions)
      : undefined;
    const describedTool = scopedDescription
      ? { ...tool, description: scopedDescription }
      : canonicalSurface
      && !isCanonicalToolSurfaceDescription(tool.name, tool.description)
      ? { ...tool, description: canonicalSurface.description }
      : tool;
    const taggedTool = this.withCandidateExecutionGuard(
      this.withToolConcurrencyMetadata(tagToolWithReversibility(describedTool), category),
    );
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
    if (this.isCandidateTurn()) return [];
    return [...this.getPromotedExtendedToolNamesInternal()];
  }

  persistPromotedExtendedTools(next: readonly string[]): Promise<string | null> {
    return this.persistPromotedExtendedToolNames(next);
  }

  async addPromotedExtendedTool(toolName: string): Promise<PromotedToolMutationResult> {
    if (this.isCandidateTurn()) return this.candidateToolMutationDenied(toolName);
    return addPromotedExtendedTool(toolName, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  async removePromotedExtendedTool(toolName: string): Promise<PromotedToolMutationResult> {
    if (this.isCandidateTurn()) return this.candidateToolMutationDenied(toolName);
    return removePromotedExtendedTool(toolName, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  async swapPromotedExtendedTools(fromSlot: number, toSlot: number): Promise<PromotedToolMutationResult> {
    if (this.isCandidateTurn()) return this.candidateToolMutationDenied(`${fromSlot}:${toSlot}`);
    return swapPromotedExtendedTools(fromSlot, toSlot, {
      getPromotedExtendedToolNames: () => this.getPromotedExtendedToolNamesInternal(),
      setPromotedExtendedToolNames: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedToolNames: (next) => this.persistPromotedExtendedToolNames(next),
      getExtendedToolByName: (name) => this.getExtendedToolByName(name),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return {
      core: [...this.getCoreToolsForCurrentTurn()],
      extended: [...this.getExtendedToolsForCurrentTurn()],
    };
  }

  getToolCatalogSnapshot(): RuntimeToolCatalogSnapshot {
    const toSnapshotEntry = (tool: AgentTool<any>, scope: 'core' | 'extended') => {
      const wiringMeta = cloneToolWiringMeta((tool as WirableTool).wiringMeta);
      return buildRuntimeToolCatalogEntry(tool, scope, wiringMeta);
    };

    return {
      generatedAt: Date.now(),
      tools: [
        ...this.getCoreToolsForCurrentTurn().map(tool => toSnapshotEntry(tool, 'core')),
        ...this.getExtendedToolsForCurrentTurn().map(tool => toSnapshotEntry(tool, 'extended')),
      ],
    };
  }

  /**
   * Refresh the durable-usage ordering signal (psfn-framework-b0yl.5). The
   * static agent tool list is re-applied immediately so ordering updates without
   * waiting for the next turn. Presentation-only: callability is unchanged.
   */
  setToolUsageRanking(ranking: ToolUsageRanking | null): void {
    this.toolUsageRanking = ranking;
    if (!this.getCandidateTurnContext()) {
      this.applyActiveToolsToAgent();
    }
  }

  getAdaptiveToolRuntimeState(): AdaptiveToolRuntimeState {
    const candidateContext = this.getCandidateTurnContext();
    if (candidateContext) {
      const candidateTools = this.getCandidateTools(candidateContext);
      return buildAdaptiveToolRuntimeState({
        coreTools: [],
        extendedTools: candidateTools,
        promotedToolsConfigured: [],
        promotedResolution: { activeNames: new Set(), orderedNames: [], skipped: [] },
        activeResolution: this.resolveCandidateActiveTools(candidateContext),
        lastSnapshot: candidateContext.adaptiveSnapshot ?? null,
      });
    }
    const promotedResolution = this.resolvePromotedToolActivation();
    const activeResolution = this.resolveActiveTools();

    return buildAdaptiveToolRuntimeState({
      coreTools: this.coreTools,
      extendedTools: this.extendedTools,
      promotedToolsConfigured: this.getPromotedExtendedToolNamesInternal(),
      promotedResolution,
      activeResolution,
      lastSnapshot: this.toolTurnContext.getStore()?.adaptiveSnapshot ?? this.lastAdaptiveToolSnapshot,
    });
  }

  getToolHealthStatusByName(): ReadonlyMap<string, RuntimeServiceHealthStatus> {
    const candidateContext = this.getCandidateTurnContext();
    if (candidateContext) {
      if (candidateContext.candidateScopeActive !== true) return new Map();
      const notifyHealth = this.toolHealthStatusByName.get('notify');
      return notifyHealth ? new Map([['notify', notifyHealth]]) : new Map();
    }
    return this.toolHealthStatusByName;
  }

  setToolHealthStatusByName(next: ReadonlyMap<string, RuntimeServiceHealthStatus>): void {
    this.toolHealthStatusByName = new Map(next);
  }

  async runWithTurnToolContext<T>(
    message: SubstrateMessage,
    run: () => Promise<T>,
  ): Promise<T> {
    const active = this.toolTurnContext.getStore();
    if (active) {
      if (active.message !== message) {
        throw new Error('Agent turn tool context cannot be reused by a different message');
      }
      return run();
    }
    return this.toolTurnContext.run({
      message,
    }, run);
  }

  async runWithIcpAutonomyCandidateNotifyScope<T>(
    message: SubstrateMessage,
    run: () => Promise<T>,
  ): Promise<T> {
    if (this.toolTurnContext.getStore()) {
      throw new Error('Trusted ICP candidate notify scope requires a fresh turn owner');
    }
    const candidateOrigin = resolveIcpAutonomyCandidateSchedulerOrigin(message);
    if (!candidateOrigin) {
      throw new Error('Trusted ICP candidate notify scope requires its canonical scheduler turn');
    }
    const access = this.resolveCapabilityAccess();
    if (!access.has('external.companion')) {
      throw new Error('Trusted ICP candidate notify scope is not capability authorized');
    }
    const toolName = 'notify';
    const tool = this.extendedTools.find(candidate => candidate.name === toolName);
    if (!tool) {
      throw new Error('Trusted ICP candidate notify tool is not registered as extended');
    }
    const context: ToolTurnContext = {
      message,
      candidateOrigin,
      candidateScopeActive: true,
      taskKind: candidateOrigin.continuationTaskKind ?? null,
      intent: 'ops',
    };
    return this.toolTurnContext.run(context, async () => {
      try {
        return await run();
      } finally {
        context.candidateScopeActive = false;
        context.activeTools = [];
        context.correlation = undefined;
        context.adaptiveSnapshot = undefined;
      }
    });
  }

  resolveOwnedTurnTools(): readonly AgentTool<any>[] | undefined {
    const context = this.toolTurnContext.getStore();
    if (context?.activeTools) return [...context.activeTools];
    return context?.candidateOrigin ? [this.getCandidateNotifyTool(context)] : undefined;
  }

  getActiveTurnTools(): readonly AgentTool<any>[] {
    return this.resolveOwnedTurnTools() ?? [...this.agent.state.tools];
  }

  /**
   * Intake provenance owned by the exact async-local turn context. Reading it
   * here avoids cross-turn leakage when ordinary turns overlap.
   */
  getActiveTurnIntakeEnvelopes(): readonly IntakeEnvelopeSnapshot[] {
    return this.toolTurnContext.getStore()?.message.routing?.intakeEnvelopes ?? [];
  }

  setToolsetMemoryWriter(getMemoryWriter: () => Pick<MemoryWriter, 'write'> | undefined): void {
    this.getToolsetMemoryWriter = getMemoryWriter;
  }

  createToolsetTool(): AgentTool<any> {
    const toolset = createToolsetTool({
      getCoreTools: () => this.getCoreToolsForCurrentTurn(),
      getExtendedTools: () => this.getExtendedToolsForCurrentTurn(),
      getAdaptiveToolRuntimeState: () => this.getAdaptiveToolRuntimeState(),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      getPromotedExtendedToolsLimit: () => this.getPromotedExtendedToolsLimit(),
      getPromotedExtendedTools: () => this.getPromotedExtendedTools(),
      setPromotedExtendedTools: (next) => this.setPromotedExtendedToolNamesInternal(next),
      persistPromotedExtendedTools: (next) => this.persistPromotedExtendedToolNames(next),
      addPromotedExtendedTool: (toolName) => this.addPromotedExtendedTool(toolName),
      removePromotedExtendedTool: (toolName) => this.removePromotedExtendedTool(toolName),
      getMemoryWriter: () => this.getToolsetMemoryWriter?.(),
      applyActiveToolsToAgent: () => this.applyActiveToolsToAgent(),
    });
    return {
      ...toolset,
      execute: async (toolCallId, params, signal) => {
        if (this.isCandidateTurn() && (!isRecord(params) || params.action !== 'describe')) {
          return textResultWithError(CANDIDATE_TOOL_MUTATION_DENIAL, true);
        }
        return toolset.execute(toolCallId, params, signal);
      },
    };
  }

  createToolSearchTool(): AgentTool<any> {
    return createToolSearchTool({
      getCoreTools: () => this.getCoreToolsForCurrentTurn(),
      getExtendedTools: () => this.getExtendedToolsForCurrentTurn(),
      getToolHealthStatusByName: () => this.getToolHealthStatusByName(),
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      emitTelemetry: (event, payload) => this.emitTelemetry(event, payload),
    });
  }

  resolveToolTurnOutcome(
    message: SubstrateMessage,
    taskKind: string | undefined,
  ): ToolTurnOutcome {
    if (this.isCandidateTurn()) {
      return { intent: 'ops' };
    }
    return { intent: classifyTurnIntent(message, taskKind) };
  }

  applyActiveToolsToAgentForTurn(
    message: SubstrateMessage,
    taskKind: string | undefined,
    callType: ObservabilityCallType,
    correlation: CorrelationMetadata,
    toolTurnOutcome: ToolTurnOutcome,
  ): void {
    this.bindToolTurnContext(message, taskKind, correlation, toolTurnOutcome.intent);
    const candidateContext = this.getCandidateTurnContext();
    const policyResolution = candidateContext
      ? this.resolveCandidateActiveTools(candidateContext)
      : this.resolvePolicyConstrainedTools(message, taskKind, toolTurnOutcome.intent, correlation);
    applyActiveToolsToAgent({
      resolution: policyResolution,
      withCapabilityGates: tools => this.withCapabilityGates(tools),
      setAgentTools: tools => this.setActiveTools(tools),
    });

    const snapshot = buildAdaptiveToolSnapshot({
      message,
      taskKind,
      callType,
      correlation,
      toolTurnOutcome,
      resolution: policyResolution,
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
    });
    const turnContext = this.toolTurnContext.getStore();
    if (turnContext) {
      turnContext.adaptiveSnapshot = snapshot;
    }
    if (!candidateContext) {
      this.lastAdaptiveToolSnapshot = snapshot;
    }
    this.emitTelemetry('agent.tools.adaptive.snapshot', snapshot as unknown as Record<string, unknown>);

    emitAdaptiveToolSnapshotDecisions({
      snapshot,
      correlation,
      withAdaptiveCorrelation: (contextCorrelation, purpose) => this.withAdaptiveCorrelation(contextCorrelation, purpose),
      emitAdaptiveToolDecision: payload => this.emitAdaptiveToolDecision(payload),
    });
  }

  validateToolWiring(
    mode: ToolWiringValidationMode,
    gatewayClient?: object,
    requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage,
  ): void {
    const allTools = [...this.coreTools, ...this.extendedTools];
    assertToolsHaveDeclaredCapabilityPolicies(allTools);
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
    if (disabledNames.length > 0) {
      const disabledSet = new Set(disabledNames);
      this.coreTools = this.coreTools.filter(t => !disabledSet.has(t.name));
      this.extendedTools = this.extendedTools.filter(t => !disabledSet.has(t.name));
      const filteredPromoted = this
        .getPromotedExtendedToolNamesInternal()
        .filter(name => !disabledSet.has(name));
      this.setPromotedExtendedToolNamesInternal(filteredPromoted);
    }
    this.auditStoredPromotedToolNames();
  }

  // Stored promoted-tool state can reference names that no longer resolve
  // (retired tool names after a rename, tools that became core, or tools
  // removed entirely). Startup must not crash on stale entries, but it must
  // say loudly why each one is being ignored so operators can clean up.
  private auditStoredPromotedToolNames(): void {
    const extendedNames = new Set(this.extendedTools.map(tool => tool.name));
    const coreNames = new Set(this.coreTools.map(tool => tool.name));
    for (const name of this.getPromotedExtendedToolNamesInternal()) {
      if (extendedNames.has(name)) continue;
      const retired = getRetiredToolAlias(name);
      if (retired) {
        log.warn(
          `Stored promoted tool "${name}" is retired; "${retired.canonicalName}" replaces it. `
          + 'The stale ordering preference is ignored — unpin it via toolset action="unpin".',
          { toolName: name, canonicalName: retired.canonicalName },
        );
      } else if (coreNames.has(name)) {
        log.warn(
          `Stored promoted tool "${name}" is now a core tool and always active. `
          + 'The ordering preference is redundant and ignored — unpin it via toolset action="unpin".',
          { toolName: name },
        );
      } else {
        log.warn(
          `Stored promoted tool "${name}" is not a registered extended tool in this runtime. `
          + 'The ordering preference is ignored — unpin it via toolset action="unpin".',
          { toolName: name },
        );
      }
    }
  }

  getExtendedTools(): readonly AgentTool<any>[] {
    return this.getExtendedToolsForCurrentTurn();
  }

  getCapabilityEligiblePromotedToolNames(): Set<string> {
    return this.resolvePromotedToolActivation().activeNames;
  }

  resolveActiveToolCounts(): AdaptiveToolSnapshotTelemetry['counts'] {
    return this.resolveActiveTools().counts;
  }

  private withToolConcurrencyMetadata(tool: AgentTool<any>, category: ToolCategory): AgentTool<any> {
    return withToolConcurrencyMetadata(tool, category);
  }

  private withCandidateExecutionGuard(tool: AgentTool<any>): AgentTool<any> {
    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
        const context = this.getCandidateTurnContext();
        if (!context) return tool.execute(toolCallId, params, signal);
        const authorizedNotifyDelegate = tool.name === 'notify'
          && this.candidateNotifyDelegateContext.getStore() === context;
        if (authorizedNotifyDelegate) return tool.execute(toolCallId, params, signal);
        return textResultWithError(
          `${tool.name}: unavailable during the exact ICP candidate notify turn.`,
          true,
        );
      },
    };
  }

  private getCandidateTurnContext(): ToolTurnContext | undefined {
    const context = this.toolTurnContext.getStore();
    return context?.candidateOrigin ? context : undefined;
  }

  private isCandidateTurn(): boolean {
    return this.getCandidateTurnContext() !== undefined;
  }

  private candidateToolMutationDenied(toolName: string): PromotedToolMutationResult {
    return {
      ok: false,
      changed: false,
      promotedTools: [],
      message: `${CANDIDATE_TOOL_MUTATION_DENIAL} Requested: ${toolName}.`,
      errorCode: 'capability_denied',
    };
  }

  private getCoreToolsForCurrentTurn(): AgentTool<any>[] {
    return this.isCandidateTurn() ? [] : [...this.coreTools];
  }

  private resolveCandidateActiveTools(context: ToolTurnContext): ActiveToolResolution {
    if (context.candidateScopeActive !== true) {
      return {
        tools: [],
        snapshotTools: [],
        promotedSkipped: [],
        counts: {
          core: 0,
          extended: 0,
          total: 0,
        },
      };
    }
    return {
      tools: [this.getCandidateNotifyTool(context)],
      snapshotTools: [{ toolName: 'notify', source: 'extended' }],
      promotedSkipped: [],
      counts: {
        core: 0,
        extended: 1,
        total: 1,
      },
    };
  }

  private getPromotedExtendedToolNamesInternal(): string[] {
    return getPromotedExtendedToolNames(this.config);
  }

  private setPromotedExtendedToolNamesInternal(next: readonly string[]): string[] {
    if (this.isCandidateTurn()) return [];
    return setPromotedExtendedToolNames(this.config, next);
  }

  setPromotedExtendedTools(next: readonly string[]): string[] {
    return this.setPromotedExtendedToolNamesInternal(next);
  }

  private async persistPromotedExtendedToolNames(next: readonly string[]): Promise<string | null> {
    if (this.isCandidateTurn()) return CANDIDATE_TOOL_MUTATION_DENIAL;
    return persistPromotedExtendedToolNames(this.config, next);
  }

  private getExtendedToolByName(name: string): AgentTool<any> | null {
    return getExtendedToolByName(this.extendedTools, name);
  }

  private resolvePromotedToolActivation(): PromotedToolResolution {
    if (this.isCandidateTurn()) return { activeNames: new Set(), orderedNames: [], skipped: [] };
    return resolvePromotedToolActivation({
      promotedTools: this.getPromotedExtendedToolNamesInternal(),
      extendedTools: this.extendedTools,
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
    });
  }

  private resolveActiveTools(
    additionalSkipped: AdaptiveToolSnapshotSkip[] = [],
  ): ActiveToolResolution {
    const candidateContext = this.getCandidateTurnContext();
    if (candidateContext) return this.resolveCandidateActiveTools(candidateContext);
    const resolution = resolveActiveTools({
      coreTools: this.coreTools,
      extendedTools: this.extendedTools,
      promotedResolution: this.resolvePromotedToolActivation(),
      additionalSkipped,
      ...(this.toolUsageRanking ? { usageRanking: this.toolUsageRanking } : {}),
    });
    return resolution;
  }

  private getExtendedToolsForCurrentTurn(): AgentTool<any>[] {
    const context = this.getCandidateTurnContext();
    return context ? this.getCandidateTools(context) : [...this.extendedTools];
  }

  private getCandidateTools(context: ToolTurnContext): AgentTool<any>[] {
    return context.candidateScopeActive === true ? [this.getCandidateNotifyTool(context)] : [];
  }

  private getCandidateNotifyTool(context: ToolTurnContext): AgentTool<any> {
    if (context.candidateNotifyTool) return context.candidateNotifyTool;
    const notifyTool = this.extendedTools.find(tool => tool.name === 'notify');
    if (!notifyTool) {
      throw new Error('Trusted ICP candidate notify tool is no longer registered as extended');
    }
    const authorizedNotifyDelegate = {
      ...notifyTool,
      execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => (
        this.candidateNotifyDelegateContext.run(
          context,
          () => notifyTool.execute(toolCallId, params, signal),
        )
      ),
    } as AgentTool<any>;
    context.candidateNotifyTool = createIcpCandidateScopedNotifyTool({
      notifyTool: authorizedNotifyDelegate,
      authorizeExecution: () => this.isCandidateNotifyExecutionAuthorized(context),
    });
    return context.candidateNotifyTool;
  }

  private isCandidateNotifyExecutionAuthorized(context: ToolTurnContext): boolean {
    if (this.toolTurnContext.getStore() !== context
      || context.candidateScopeActive !== true
      || !context.candidateOrigin
      || !context.correlation) {
      return false;
    }
    let liveOrigin: IcpAutonomyCandidateOrigin | null;
    try {
      liveOrigin = resolveIcpAutonomyCandidateSchedulerOrigin(context.message);
    } catch {
      return false;
    }
    if (!liveOrigin
      || liveOrigin.candidateId !== context.candidateOrigin.candidateId
      || liveOrigin.rootInitiationId !== context.candidateOrigin.rootInitiationId
      || liveOrigin.source !== context.candidateOrigin.source
      || liveOrigin.provenanceRef !== context.candidateOrigin.provenanceRef
      || liveOrigin.continuationTaskKind !== context.candidateOrigin.continuationTaskKind) {
      return false;
    }
    const requestContext = getRequestContext();
    if (!requestContext
      || requestContext.turnId !== context.correlation.turnId
      || requestContext.requestId !== context.correlation.requestId
      || requestContext.channelId !== context.correlation.channelId
      || requestContext.callType !== context.correlation.callType) {
      return false;
    }
    return this.resolveCapabilityAccess().has('external.companion')
      && this.extendedTools.some(tool => tool.name === 'notify');
  }

  private bindToolTurnContext(
    message: SubstrateMessage,
    taskKind: string | undefined,
    correlation: CorrelationMetadata,
    intent: string | null,
  ): void {
    const context = this.toolTurnContext.getStore();
    if (!context) return;
    if (context.message !== message || correlation.channelId !== message.channelId) {
      throw new Error('Agent turn tool context lost its exact message/channel owner binding');
    }
    if (context.candidateOrigin
      && context.candidateOrigin.continuationTaskKind !== taskKind) {
      throw new Error('ICP candidate turn tool context lost its task-kind owner binding');
    }
    if (context.correlation
      && (context.correlation.turnId !== correlation.turnId
        || context.correlation.requestId !== correlation.requestId
        || context.correlation.channelId !== correlation.channelId)) {
      throw new Error('Agent turn tool context cannot be rebound to another request');
    }
    context.correlation = correlation;
    context.taskKind = taskKind ?? null;
    context.intent = intent;
  }

  private setActiveTools(tools: AgentTool<any>[]): void {
    const context = this.toolTurnContext.getStore();
    if (context) {
      context.activeTools = [...tools];
      return;
    }
    this.agent.state.tools = tools;
  }

  private applyActiveToolsToAgent(): void {
    const context = this.toolTurnContext.getStore();
    const correlation = context?.correlation ?? this.getActiveTurnCorrelation();
    const taskKind = context?.taskKind ?? this.getActiveTurnTaskKind();
    const resolution = context
      ? this.resolvePolicyConstrainedTools(context.message, taskKind, context.intent, correlation)
      : this.resolveActiveTools();
    applyActiveToolsToAgent({
      resolution,
      withCapabilityGates: tools => this.withCapabilityGates(tools),
      setAgentTools: tools => this.setActiveTools(tools),
    });
  }

  private resolvePolicyConstrainedTools(
    message: SubstrateMessage,
    taskKind: string | null | undefined,
    intent: string | null | undefined,
    correlation: CorrelationMetadata | null,
  ): ActiveToolResolution {
    return this.applySatelliteCapabilityToolPolicy(
      this.applyRoutineIntentCoreToolPolicy(
        this.applyMaintenanceCoreToolPolicy(
          this.resolveActiveTools(),
          taskKind,
          correlation,
        ),
        message,
        taskKind,
        intent,
        correlation,
      ),
      message,
      correlation,
    );
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
      const guardedTool = source
        ? this.createMaintenanceGuardedTool(tool, taskKind ?? '', correlation, source)
        : null;
      if (!guardedTool || !source) {
        this.emitTelemetry('agent.tools.core_guardrail.skipped', {
          ...this.withAdaptiveCorrelation(correlation ?? undefined, 'agent.tools.core_guardrail.skipped'),
          toolName: tool.name,
          source: source ?? null,
          taskKind,
          reason: 'maintenance_turn_allowlist',
        });
        continue;
      }

      filteredTools.push(guardedTool);
      filteredSnapshotTools.push({ toolName: guardedTool.name, source });
    }

    const counts: AdaptiveToolSnapshotTelemetry['counts'] = {
      core: 0,
      extended: 0,
      total: filteredSnapshotTools.length,
    };
    for (const entry of filteredSnapshotTools) {
      if (entry.source === 'core') counts.core += 1;
      else counts.extended += 1;
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

  private applyRoutineIntentCoreToolPolicy(
    resolution: ActiveToolResolution,
    message: SubstrateMessage,
    taskKind: string | null | undefined,
    intent: string | null | undefined,
    correlation: CorrelationMetadata | null,
  ): ActiveToolResolution {
    if (!isRoutineIntentForAnalysisWorkbench(intent) || hasAnalysisWorkbenchEligibleInput(message)) {
      return resolution;
    }

    const sourceByToolName = new Map(
      resolution.snapshotTools.map((entry) => [entry.toolName, entry.source] as const),
    );
    const filteredTools: AgentTool<any>[] = [];
    const filteredSnapshotTools: AdaptiveToolSnapshotTool[] = [];
    let removed = false;

    for (const tool of resolution.tools) {
      const source = sourceByToolName.get(tool.name);
      if (tool.name === 'analysis_workbench' && source === 'core') {
        removed = true;
        this.emitTelemetry('agent.tools.core_guardrail.skipped', {
          ...this.withAdaptiveCorrelation(correlation ?? undefined, 'agent.tools.core_guardrail.skipped'),
          toolName: tool.name,
          taskKind: taskKind ?? null,
          intent,
          reason: 'routine_intent_direct_tool_path',
        });
        continue;
      }

      filteredTools.push(tool);
      if (source) {
        filteredSnapshotTools.push({ toolName: tool.name, source });
      }
    }

    if (!removed) {
      return resolution;
    }

    const counts: AdaptiveToolSnapshotTelemetry['counts'] = {
      core: 0,
      extended: 0,
      total: filteredSnapshotTools.length,
    };
    for (const entry of filteredSnapshotTools) {
      if (entry.source === 'core') counts.core += 1;
      else counts.extended += 1;
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

  private applySatelliteCapabilityToolPolicy(
    resolution: ActiveToolResolution,
    message: SubstrateMessage,
    correlation: CorrelationMetadata | null,
  ): ActiveToolResolution {
    const satellite = message.routing?.satellite;
    if (!satellite) return resolution;

    const effective = new Set(satellite.capabilities.effective);
    const visualAllowed = effective.has('vision') || effective.has('image_upload') || effective.has('avatar');
    const avatarAllowed = effective.has('avatar') || effective.has('avatar_expression') || effective.has('avatar_action');
    const sourceByToolName = new Map(
      resolution.snapshotTools.map((entry) => [entry.toolName, entry.source] as const),
    );
    const filteredTools: AgentTool<any>[] = [];
    const filteredSnapshotTools: AdaptiveToolSnapshotTool[] = [];
    let removed = false;

    for (const tool of resolution.tools) {
      const source = sourceByToolName.get(tool.name);
      const shouldBlockVisualTool = SATELLITE_VISUAL_TOOL_NAMES.has(tool.name) && !visualAllowed;
      const shouldBlockAvatarTool = tool.name.includes('avatar') && !avatarAllowed;
      if (shouldBlockVisualTool || shouldBlockAvatarTool) {
        removed = true;
        this.emitTelemetry('agent.tools.core_guardrail.skipped', {
          ...this.withAdaptiveCorrelation(correlation ?? undefined, 'agent.tools.core_guardrail.skipped'),
          toolName: tool.name,
          satelliteId: satellite.satelliteId,
          endpointId: satellite.endpointId,
          claimType: satellite.claimType,
          effectiveCapabilities: satellite.capabilities.effective,
          reason: 'satellite_capability_denied',
        });
        continue;
      }

      filteredTools.push(tool);
      if (source) {
        filteredSnapshotTools.push({ toolName: tool.name, source });
      }
    }

    if (!removed) {
      return resolution;
    }

    const counts: AdaptiveToolSnapshotTelemetry['counts'] = {
      core: 0,
      extended: 0,
      total: filteredSnapshotTools.length,
    };
    for (const entry of filteredSnapshotTools) {
      if (entry.source === 'core') counts.core += 1;
      else counts.extended += 1;
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

  private createMaintenanceGuardedTool(
    tool: AgentTool<any>,
    taskKind: string,
    correlation: CorrelationMetadata | null,
    source: AdaptiveToolSnapshotTool['source'],
  ): AgentTool<any> | null {
    const policy = MAINTENANCE_TOOL_POLICIES.get(tool.name);
    if (!policy) {
      return null;
    }

    // Turn-class scoping: a tool with allowedTaskKinds survives only on those
    // classes (expressive tools are heartbeat-only); otherwise it survives all
    // maintenance-restricted classes.
    if (policy.allowedTaskKinds && !policy.allowedTaskKinds.includes(taskKind)) {
      return null;
    }

    // No action allowlist => unrestricted pass-through on allowed turn classes.
    if (!policy.allowedActions || !policy.resolveAction) {
      return tool;
    }

    const { allowedActions, resolveAction } = policy;
    return {
      ...tool,
      execute: async (toolCallId, params, signal) => {
        const normalizedParams = isPlainRecord(params) ? params : {};
        const requestedAction = resolveAction(normalizedParams);
        if (!requestedAction || !allowedActions.includes(requestedAction)) {
          const companionMessage = `${tool.name} is limited to read-only introspection during ${taskKind} turns. `
            + `Allowed actions: ${allowedActions.join(', ')}.`;
          this.emitTelemetry('agent.tools.core_guardrail.denied', {
            ...this.withAdaptiveCorrelation(correlation ?? undefined, 'agent.tools.core_guardrail.denied'),
            toolName: tool.name,
            source,
            taskKind,
            requestedAction: requestedAction ?? null,
            allowedActions: [...allowedActions],
            reason: 'maintenance_turn_allowlist',
          });
          return textResultWithError(
            companionMessage,
            true,
            {
              errorClass: 'permission_denied',
              companionMessage,
              rawDiagnostic: {
                toolName: tool.name,
                source,
                taskKind,
                requestedAction: requestedAction ?? null,
                allowedActions: [...allowedActions],
                reason: 'maintenance_turn_allowlist',
              },
            },
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
