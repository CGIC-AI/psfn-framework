// ── Shared Runtime Wiring ──
// Common primitives used by both single-process runtime and gateway agent mode.

import type {
  CapabilityTier,
  CompositionalPolicyConfig,
  PostTurnActionCandidate,
  SubstrateConfig,
  SubstrateMessage,
} from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { Scheduler } from '../scheduler/scheduler.js';
import { createComponentLogger } from '../logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import {
  createDefaultExtendedToolAutoloadPolicy,
  type ExtendedToolAutoloadPolicy,
} from '../agent/extended-tool-autoload-policy.js';
import type {
  ExtendedToolActivationOptions,
  ExtendedToolActivationResult,
  PostTurnActionInferer,
} from '../agent/substrate-agent.js';
import { DEFAULT_REPL_CONFIG, type REPLConfig } from '../repl/types.js';
import type { MessageSender } from '../lifecycle/notifications.js';
import type { LLMProvider } from '../agent/contracts.js';
import {
  createPromotedToolsAddTool,
  createPromotedToolsListTool,
  createPromotedToolsRemoveTool,
  createPromotedToolsSwapTool,
  createSettingsGetTool,
  type PromotedExtendedToolsManager,
} from '../settings-tools.js';
import { wireFilesystemRuntime, type FilesystemRuntimeTarget } from '../filesystem/runtime-wiring.js';
import type { SessionManager } from '../session/manager.js';
import type { CoreMemoryStore } from '../core-memory/store.js';
import { createSessionListTool, createSessionNewTool, createSessionResumeTool } from '../tools/session.js';
import { createSessionGrepTool, createSessionSearchTool } from '../tools/session-search.js';
import { resolveSessionsDir } from '../persistence/layout.js';
import { createCompleteFocusTool, createStartFocusTool } from '../tools/focus.js';
import { PromptLayerStore } from '../identity/prompt-store.js';
import { PromptComposer } from '../identity/prompt-composer.js';
import { PromptRegistryStore } from '../identity/prompt-registry.js';
import { runDeliberation } from '../llm/deliberation.js';
import type { DeliberationResult } from '../llm/deliberation.js';
import {
  createPersonaUpdateTool,
  type PersonaUpdateToolOptions,
  type CharacterCardVersionStore,
} from '../identity/card-versioning.js';
import { buildCharacterPromptTemplateVariables } from '../identity/loader.js';
import {
  createPromptLayerListTool,
  createPromptLayerGetTool,
  createIdentityDiffTool,
  createIdentityChangelogTool,
  createPromptLayerUpdateTool,
  createPromptLayerRollbackTool,
  createPromptLayerToggleTool,
  type PromptLayerUpdateToolOptions,
} from '../identity/prompt-tools.js';
import { NorthStarStore } from '../north-star/store.js';
import {
  createNorthStarCreateTool,
  createNorthStarDeleteTool,
  createNorthStarListTool,
  createNorthStarReorderTool,
  createNorthStarUpdateTool,
} from '../north-star/tools.js';
import { HeartbeatPolicyStore } from '../scheduler/heartbeat-policy.js';
import {
  createHeartbeatGetPolicyTool,
  createHeartbeatRunTemplateTool,
  createHeartbeatUpdatePolicyTool,
  createScheduleTaskTool,
} from '../scheduler/heartbeat-tools.js';
import type { ReflectionTemplate } from '../scheduler/heartbeat-policy.js';
import type { MemoryWriter } from '../memory/writer.js';
import { ValuesJournalStore } from '../values/store.js';
import type { ValuesDeliberationMetadata } from '../values/store.js';
import {
  createValuesAddTool,
  createValuesListTool,
  createValuesUpdateTool,
} from '../values/tools.js';
import {
  resolveHeartbeatPolicyPath,
  resolveLegacyValuesJournalPath,
  resolveNorthStarPath,
  resolvePromptHistoryPath,
  resolvePromptLayersPath,
  resolvePromptRegistryHistoryPath,
  resolvePromptRegistryPath,
  resolveReflectionDailyJournalsDir,
  resolveReflectionJournalPath,
  resolveReflectionProcessLogsDir,
  resolveValuesJournalPath,
} from '../persistence/layout.js';
import { ReflectionJournalStore } from '../notes/reflection-journal.js';
import {
  buildReflectionProcessId,
  ReflectionDailyJournalStore,
  ReflectionProcessLogStore,
} from '../notes/reflection-substrate.js';
import type { PostTurnActionRuntime } from './post-turn-actions.js';
import { isBusyTurnError } from '../lifecycle/turn-contention.js';
import {
  buildDeferredToolHandoffMessage,
  DEFERRED_TOOL_HANDOFF_ACTION_KIND,
  normalizeDeferredToolHandoffPayload,
  type DeferredToolHandoffPayload,
} from '../agent/deferred-tool-handoff.js';
import {
  inferComposedDeferredPostTurnActions,
  inferDeferredPostTurnActions as inferDeferredPostTurnActionsFromMessages,
} from './deferred-post-turn-inference.js';
import { evaluateCompositionalPolicyForChannelId } from '../compositional/policy.js';
import {
  SleeptimeMemoryAgent,
  SLEEPTIME_MEMORY_ACTION_KIND,
} from '../memory/sleeptime-agent.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import {
  IntentionAppraisal,
  INTENTION_FOLLOW_UP_ACTION_KIND,
  INTENTION_REMINDER_ACTION_KIND,
  decisionsToPostTurnActionCandidates,
  isBackgroundAppraisalChannel,
  normalizeIntentionFollowUpActionPayload,
  normalizeIntentionReminderActionPayload,
  sessionEntriesToIntentionMessages,
  toInferredPostTurnActions,
  type ActiveConcernSnapshot,
  type IntentionActionDecision,
} from '../intention/appraisal.js';
import { MotivationBridge } from '../intention/motivation.js';
import {
  buildInternalStateSnapshotRef,
  cloneInternalState,
  serializeInternalState,
  type InternalState,
} from '../self-model/state.js';

const log = createComponentLogger('SharedWiring');
const DEFERRED_HEARTBEAT_ACTION_KIND = 'heartbeat.run_template';

interface ReflectionMetacognitiveFlag {
  flag: string;
  confidence: number;
  evidence?: string;
}

interface ReflectionInternalStateContext {
  internalState: InternalState;
  internalStateSnapshotRef: string;
  metacognitiveFlags: ReflectionMetacognitiveFlag[];
}

interface HeartbeatAgentResponse {
  content: string;
  metadata?: {
    internalState?: InternalState;
    internalStateSnapshotRef?: string;
    metacognitiveFlags?: unknown;
  };
}

interface HeartbeatAgent {
  handleMessage(message: SubstrateMessage): Promise<HeartbeatAgentResponse>;
  followUp?(message: SubstrateMessage): void;
  activateExtendedTools?(
    toolNames: readonly string[],
    options?: ExtendedToolActivationOptions,
  ): ExtendedToolActivationResult;
  waitForIdle?(): Promise<void>;
  registerPostTurnActionInferer?(inferer: PostTurnActionInferer): () => void;
  getCurrentInternalState?(): InternalState | null;
  getCurrentInternalStateSnapshotRef?(): string | null;
  getCurrentMetacognitiveFlags?(): unknown;
}

interface HeartbeatRuntimeOptions {
  eventBus?: EventBus;
  llmProvider?: LLMProvider;
  capabilityTier?: CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
  characterPromptVariablesProvider?: () => Record<string, string>;
  memoryWriter?: Pick<MemoryWriter, 'write'>;
  sessionManager?: Pick<SessionManager, 'resolveSessionChannelId' | 'getRecentMessages'>;
  emotionState?: { getState(): EmotionStateSnapshot };
  contactStore?: {
    getEmotionalSnapshot?(id: string): EmotionalSnapshot | undefined;
    getById?(id: string): { trustLevel?: string } | undefined;
  };
  getActiveConcerns?: (input: {
    channelId: string;
    canonicalContactKey?: string;
  }) => Promise<readonly ActiveConcernSnapshot[]> | readonly ActiveConcernSnapshot[];
  getRecentResolvedConcerns?: (input: {
    channelId: string;
    canonicalContactKey?: string;
  }) => Promise<readonly ActiveConcernSnapshot[]> | readonly ActiveConcernSnapshot[];
  onIntentionConcernDecision?: (input: {
    decision: IntentionActionDecision;
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
  }) => Promise<void> | void;
  onIntentionFollowUpDecision?: (input: {
    decision: IntentionActionDecision;
    channelId: string;
    channelType: SubstrateMessage['channelType'];
    canonicalContactKey?: string;
    sourceMessageId: string;
  }) => Promise<string | undefined> | string | undefined;
  onIntentionFollowUpActivated?: (input: {
    pendingFollowUpId: string;
    activationReason?: string;
  }) => Promise<void> | void;
  onIntentionReminderDecision?: (input: {
    decision: IntentionActionDecision;
    channelId: string;
    channelType: SubstrateMessage['channelType'];
    canonicalContactKey?: string;
    sourceMessageId: string;
  }) => Promise<string | undefined> | string | undefined;
  onIntentionReminderTriggered?: (input: {
    reminderId: string;
  }) => Promise<{
    reminderId: string;
    content: string;
    channelId: string;
    channelType: SubstrateMessage['channelType'];
    authorId: string;
    authorName: string;
    nextDueAt?: string;
  } | undefined> | {
    reminderId: string;
    content: string;
    channelId: string;
    channelType: SubstrateMessage['channelType'];
    authorId: string;
    authorName: string;
    nextDueAt?: string;
  } | undefined;
  onBehavioralPatternOutcome?: (input: {
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
    emotionSnapshot: EmotionStateSnapshot;
    observedAtMs?: number;
  }) => Promise<void> | void;
  coreMemoryStore?: Pick<CoreMemoryStore, 'getSnapshot' | 'rethink'>;
  sleeptimeCadenceTurns?: number;
  intentionAppraisalEnabled?: boolean;
  postTurnActions?: PostTurnActionRuntime;
  vaultAutoPublisher?: { publishReflection(input: {
    templateId: string;
    templateName: string;
    reflection: string;
    mode: 'agent' | 'deliberation';
    createdAt: Date;
  }): Promise<void> };
}

function hasPromotedToolsManager(
  target: ToolRegistrarTarget,
): target is ToolRegistrarTarget & PromotedExtendedToolsManager {
  return (
    typeof (target as Partial<PromotedExtendedToolsManager>).getPromotedExtendedToolsLimit === 'function'
    && typeof (target as Partial<PromotedExtendedToolsManager>).getPromotedExtendedTools === 'function'
    && typeof (target as Partial<PromotedExtendedToolsManager>).addPromotedExtendedTool === 'function'
    && typeof (target as Partial<PromotedExtendedToolsManager>).removePromotedExtendedTool === 'function'
    && typeof (target as Partial<PromotedExtendedToolsManager>).swapPromotedExtendedTools === 'function'
  );
}

export interface PromptRuntimeTarget extends ToolRegistrarTarget {
  promptComposer: PromptComposer | null;
}

export type CharacterCardRuntimeTarget = ToolRegistrarTarget;

export function buildCharacterPromptVariablesProvider(
  cardStore: Pick<CharacterCardVersionStore, 'getCurrent'>,
): () => Record<string, string> {
  return () => buildCharacterPromptTemplateVariables(cardStore.getCurrent().card);
}

export interface ExtendedToolAutoloadRuntimeTarget {
  setExtendedToolAutoloadPolicy: (policy: ExtendedToolAutoloadPolicy | null) => void;
}

export type FilesystemToolRuntimeTarget = ToolRegistrarTarget & FilesystemRuntimeTarget;

export function wireExtendedToolAutoloadPolicy(
  target: ExtendedToolAutoloadRuntimeTarget,
  policy: ExtendedToolAutoloadPolicy = createDefaultExtendedToolAutoloadPolicy(),
): void {
  target.setExtendedToolAutoloadPolicy(policy);
}

/**
 * Wire prompt stack storage, composition, and tools.
 * Shared across runtime.ts and agent-main.ts to keep behavior in sync.
 */
export function wirePromptRuntime(
  target: PromptRuntimeTarget,
  dataDir: string,
  baseSystemPrompt: string,
  options: PromptLayerUpdateToolOptions = {},
): PromptLayerStore {
  const promptStore = new PromptLayerStore(
    resolvePromptLayersPath(dataDir),
    resolvePromptHistoryPath(dataDir),
  );
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(dataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(dataDir)],
  });
  const northStarStore = new NorthStarStore(resolveNorthStarPath(dataDir));
  promptStore.seedFromCharacterCard(baseSystemPrompt);

  target.promptComposer = new PromptComposer(promptStore, undefined, undefined, {
    enableConstitution: true,
    companionValuesLayerProvider: () => valuesJournal.buildCompanionDerivedLayer(),
    northStarLayerProvider: () => northStarStore.buildPromptLayer(),
  });
  target.registerTool(createPromptLayerListTool(promptStore), 'core');
  target.registerTool(createPromptLayerGetTool(promptStore), 'core');
  target.registerTool(createIdentityDiffTool(promptStore), 'core');
  target.registerTool(createNorthStarListTool(northStarStore), 'core');
  target.registerTool(createIdentityChangelogTool(promptStore), 'extended');
  target.registerTool(createPromptLayerUpdateTool(promptStore, options), 'extended');
  target.registerTool(createPromptLayerRollbackTool(promptStore, options), 'extended');
  target.registerTool(createPromptLayerToggleTool(promptStore), 'extended');
  target.registerTool(createNorthStarCreateTool(northStarStore), 'extended');
  target.registerTool(createNorthStarUpdateTool(northStarStore), 'extended');
  target.registerTool(createNorthStarDeleteTool(northStarStore), 'extended');
  target.registerTool(createNorthStarReorderTool(northStarStore), 'extended');

  log.info(`Prompt stack enabled (${promptStore.count} layers)`);
  return promptStore;
}

export function wireCharacterCardRuntime(
  target: CharacterCardRuntimeTarget,
  cardStore: CharacterCardVersionStore,
  options: PersonaUpdateToolOptions = {},
): void {
  target.registerTool(createPersonaUpdateTool(cardStore, options), 'extended');
  const snapshot = cardStore.getCurrent();
  log.info(`Persona tooling enabled (v${snapshot.version})`);
}

/**
 * Wire static prompt registry used by runtime LLM call-sites
 * (extraction, compaction summary, and other keyed prompts).
 */
export function wireStaticPromptRegistry(dataDir: string): PromptRegistryStore {
  const promptRegistry = new PromptRegistryStore(
    resolvePromptRegistryPath(dataDir),
    resolvePromptRegistryHistoryPath(dataDir),
  );
  log.info(`Static prompt registry enabled (${promptRegistry.list().length} prompts)`);
  return promptRegistry;
}

/**
 * Build REPL config with runtime settings overrides.
 * Shared across runtime.ts and agent-main.ts to keep think tool budgets aligned.
 */
export function buildReplConfig(config: SubstrateConfig): REPLConfig {
  const replConfig: REPLConfig = {
    ...DEFAULT_REPL_CONFIG,
    budget: { ...DEFAULT_REPL_CONFIG.budget },
  };
  if (config.thinkMaxTokens !== undefined) replConfig.budget.maxTokens = config.thinkMaxTokens;
  if (config.thinkMaxWallTimeMs !== undefined) replConfig.budget.maxWallTimeMs = config.thinkMaxWallTimeMs;
  if (config.thinkMaxSubQueries !== undefined) replConfig.budget.maxSubQueries = config.thinkMaxSubQueries;
  return replConfig;
}

/**
 * Wire runtime settings introspection tool (read-only).
 * Shared across runtime.ts and agent-main.ts.
 */
export function wireSettingsRuntime(
  target: ToolRegistrarTarget,
  config: SubstrateConfig,
): void {
  target.registerTool(createSettingsGetTool(config), 'core');
  if (!hasPromotedToolsManager(target)) {
    return;
  }
  target.registerTool(createPromotedToolsListTool(target), 'extended');
  target.registerTool(createPromotedToolsAddTool(target), 'extended');
  target.registerTool(createPromotedToolsRemoveTool(target), 'extended');
  target.registerTool(createPromotedToolsSwapTool(target), 'extended');
}

export function wireSessionToolsRuntime(
  target: ToolRegistrarTarget,
  sessionManager: SessionManager,
  dataDir: string,
  llmProvider: LLMProvider,
): void {
  target.registerTool(createSessionSearchTool(sessionManager, llmProvider), 'core');
  target.registerTool(createSessionGrepTool({
    sessionsDir: resolveSessionsDir(dataDir),
  }), 'core');
  target.registerTool(createSessionNewTool({
    dataDir,
    setActiveSession: (sessionId) => sessionManager.setActiveContextSession(sessionId),
    seedSession: (sessionId) => {
      sessionManager.appendSystemNote(
        sessionId,
        'Session initialized via session_new.',
      );
    },
  }), 'extended');
  target.registerTool(createSessionListTool(sessionManager, { dataDir }), 'core');
  target.registerTool(createSessionResumeTool(sessionManager, { dataDir }), 'extended');
  target.registerTool(createStartFocusTool(sessionManager), 'extended');
  target.registerTool(createCompleteFocusTool(sessionManager, llmProvider), 'extended');
}

export function wireFilesystemToolsRuntime(
  target: FilesystemToolRuntimeTarget,
  workspacePath: string,
): void {
  wireFilesystemRuntime(target, workspacePath);
}

/**
 * Wire the multi-template heartbeat/reflection system.
 * Registers policy-driven reflection tasks and agent tools for managing them.
 */
export function wireHeartbeatRuntime(
  target: ToolRegistrarTarget,
  scheduler: Scheduler,
  agentLoop: HeartbeatAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
  runtimeOptions: HeartbeatRuntimeOptions = {},
): void {
  const DEFERRED_REFLECTION_TASK_PREFIX = 'reflection:deferred:';
  const MIN_SCHEDULED_TEMPLATE_GAP_MS = 60_000;
  const TEMPLATE_EXECUTION_BURST_WINDOW_MS = 60_000;
  const TEMPLATE_EXECUTION_BURST_LIMIT = 4;
  const TEMPLATE_EXECUTION_COOLDOWN_MS = 10 * 60_000;
  const store = new HeartbeatPolicyStore(resolveHeartbeatPolicyPath(dataDir));
  const valuesJournal = new ValuesJournalStore(resolveValuesJournalPath(dataDir), {
    legacyFilePaths: [resolveLegacyValuesJournalPath(dataDir)],
  });
  const reflectionJournal = new ReflectionJournalStore(resolveReflectionJournalPath(dataDir));
  const reflectionDailyJournal = new ReflectionDailyJournalStore(resolveReflectionDailyJournalsDir(dataDir));
  const reflectionProcessLog = new ReflectionProcessLogStore(resolveReflectionProcessLogsDir(dataDir));
  const policy = store.load();
  const pendingDeferredTemplates = new Set<string>();
  const lastScheduledRunAt = new Map<string, number>();
  const templateExecutionHistory = new Map<string, number[]>();
  const templateExecutionCooldownUntil = new Map<string, number>();
  const deferredToolHandoffPayloads = new Map<string, DeferredToolHandoffPayload>();
  const deferredToolHandoffExecutionState = new Map<string, { activated: boolean; executed: boolean }>();
  const telemetryEventBus = runtimeOptions.eventBus;
  const shouldUseCompositionalAppraisal = (channelId: string): boolean => (
    evaluateCompositionalPolicyForChannelId({
      policy: runtimeOptions.compositionalPolicy,
      capabilityTier: runtimeOptions.capabilityTier,
      channelId,
      purpose: 'appraisal',
    }).allowed
  );
  const sleeptimeAgent = (
    runtimeOptions.postTurnActions
    && runtimeOptions.llmProvider
    && runtimeOptions.memoryWriter
    && runtimeOptions.sessionManager
    && runtimeOptions.coreMemoryStore
  )
    ? new SleeptimeMemoryAgent({
      llmProvider: runtimeOptions.llmProvider,
      sessionManager: runtimeOptions.sessionManager,
      coreMemoryStore: runtimeOptions.coreMemoryStore,
      memoryWriter: runtimeOptions.memoryWriter,
      cadenceTurns: runtimeOptions.sleeptimeCadenceTurns,
    })
    : null;
  const intentionAppraisalEnabled = runtimeOptions.intentionAppraisalEnabled !== false;
  const intentionAppraisal = (
    intentionAppraisalEnabled
    && runtimeOptions.postTurnActions
    && runtimeOptions.llmProvider
    && telemetryEventBus
  )
    ? new IntentionAppraisal({
      llmProvider: runtimeOptions.llmProvider,
      ...(runtimeOptions.characterPromptVariablesProvider
        ? { characterPromptVariablesProvider: runtimeOptions.characterPromptVariablesProvider }
        : {}),
      onEvaluationError: (error, context) => {
        log.warn('Intention appraisal failed closed', {
          sessionId: context.sessionId,
          trigger: context.trigger,
          error: String(error),
        });
      },
    })
    : null;
  const intentionSessionsInFlight = new Set<string>();
  const motivationBridge = intentionAppraisal ? new MotivationBridge() : null;

  type HeartbeatExecutionSource = 'manual' | 'scheduled' | 'deferred_scheduler' | 'deferred_post_turn';

  class HeartbeatTemplateLoopGuardError extends Error {
    readonly templateId: string;
    readonly source: HeartbeatExecutionSource;
    readonly cooldownUntil: number;

    constructor(
      templateId: string,
      source: HeartbeatExecutionSource,
      cooldownUntil: number,
      message: string,
    ) {
      super(message);
      this.name = 'HeartbeatTemplateLoopGuardError';
      this.templateId = templateId;
      this.source = source;
      this.cooldownUntil = cooldownUntil;
    }
  }

  const isHeartbeatTemplateLoopGuardError = (
    error: unknown,
  ): error is HeartbeatTemplateLoopGuardError => (
    error instanceof HeartbeatTemplateLoopGuardError
  );

  const assertTemplateExecutionAllowed = (
    templateId: string,
    source: HeartbeatExecutionSource,
  ): void => {
    if (source === 'manual') {
      return;
    }

    const now = Date.now();
    const cooldownUntil = templateExecutionCooldownUntil.get(templateId);
    if (typeof cooldownUntil === 'number' && cooldownUntil > now) {
      throw new HeartbeatTemplateLoopGuardError(
        templateId,
        source,
        cooldownUntil,
        `Template "${templateId}" is temporarily suppressed by rapid-fire loop guard`,
      );
    }

    const recentRuns = (templateExecutionHistory.get(templateId) ?? [])
      .filter((timestamp) => now - timestamp <= TEMPLATE_EXECUTION_BURST_WINDOW_MS);
    recentRuns.push(now);
    templateExecutionHistory.set(templateId, recentRuns);

    if (recentRuns.length <= TEMPLATE_EXECUTION_BURST_LIMIT) {
      return;
    }

    const nextCooldownUntil = now + TEMPLATE_EXECUTION_COOLDOWN_MS;
    templateExecutionCooldownUntil.set(templateId, nextCooldownUntil);
    log.error('Suppressing reflection template due to rapid-fire loop guard', {
      templateId,
      source,
      burstCount: recentRuns.length,
      windowMs: TEMPLATE_EXECUTION_BURST_WINDOW_MS,
      cooldownUntil: new Date(nextCooldownUntil).toISOString(),
    });
    throw new HeartbeatTemplateLoopGuardError(
      templateId,
      source,
      nextCooldownUntil,
      `Template "${templateId}" exceeded rapid-fire burst limits`,
    );
  };

  const emitDeferredToolHandoffTelemetry = (
    payload: {
      actionId: string;
      dedupeKey: string;
      channelId: string;
      sourceMessageId: string;
      toolNames: string[];
      intendedAction: string;
      phase: 'queued' | 'activated' | 'executed' | 'failed';
      attempt?: number;
      maxAttempts?: number;
      error?: string;
    },
  ): void => {
    if (!telemetryEventBus) return;
    telemetryEventBus.emit('agent.tool_handoff.telemetry', {
      ...payload,
      timestamp: Date.now(),
    }).catch((error) => {
      log.warn('Deferred tool-handoff telemetry emit failed', {
        actionId: payload.actionId,
        phase: payload.phase,
        error: String(error),
      });
    });
    const adaptiveDecision = payload.phase === 'queued'
      ? 'queued'
      : payload.phase === 'executed'
        ? 'executed'
        : payload.phase === 'failed'
          ? 'failed'
          : null;
    if (!adaptiveDecision) return;
    for (const toolName of payload.toolNames) {
      telemetryEventBus.emit('agent.tools.adaptive.decision', {
        turnId: payload.sourceMessageId || payload.actionId,
        requestId: payload.actionId,
        channelId: payload.channelId,
        callType: 'tool',
        purpose: 'agent.tools.adaptive.decision',
        timestamp: Date.now(),
        toolName,
        source: 'deferred',
        decision: adaptiveDecision,
        reason: payload.phase === 'failed'
          ? 'deferred_tool_handoff_failed'
          : 'deferred_tool_handoff',
        taskKind: 'deferred_tool_handoff',
        intent: 'deferred_tool_handoff',
      }).catch((error) => {
        log.warn('Deferred adaptive tool telemetry emit failed', {
          actionId: payload.actionId,
          toolName,
          phase: payload.phase,
          error: String(error),
        });
      });
    }
  };

  let latestMetacognitiveFlags: ReflectionMetacognitiveFlag[] = [];

  const normalizeMetacognitiveFlags = (
    value: unknown,
    context: string,
  ): ReflectionMetacognitiveFlag[] => {
    if (value === undefined || value === null) {
      return [];
    }
    if (!Array.isArray(value)) {
      throw new Error(`${context} must be an array when provided`);
    }
    return value.map((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        throw new Error(`${context}[${String(index)}] must be an object`);
      }
      const flagRaw = (entry as { flag?: unknown }).flag;
      if (typeof flagRaw !== 'string' || flagRaw.trim().length === 0) {
        throw new Error(`${context}[${String(index)}].flag must be a non-empty string`);
      }
      const confidenceRaw = (entry as { confidence?: unknown }).confidence;
      if (typeof confidenceRaw !== 'number' || !Number.isFinite(confidenceRaw) || confidenceRaw < 0 || confidenceRaw > 1) {
        throw new Error(`${context}[${String(index)}].confidence must be a finite number in [0, 1]`);
      }
      const evidenceRaw = (entry as { evidence?: unknown }).evidence;
      if (evidenceRaw !== undefined && (typeof evidenceRaw !== 'string' || evidenceRaw.trim().length === 0)) {
        throw new Error(`${context}[${String(index)}].evidence must be a non-empty string when provided`);
      }
      return {
        flag: flagRaw.trim(),
        confidence: Number(confidenceRaw.toFixed(4)),
        ...(typeof evidenceRaw === 'string' ? { evidence: evidenceRaw.trim() } : {}),
      };
    });
  };

  const normalizeSnapshotRef = (value: unknown, fieldName: string): string | null => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`${fieldName} must be a non-empty string when provided`);
    }
    return value.trim();
  };

  const resolveInternalStateContext = (
    template: ReflectionTemplate,
  ): ReflectionInternalStateContext | null => {
    if (!template.internalStateInput) {
      return null;
    }

    const currentInternalState = agentLoop.getCurrentInternalState?.();
    if (!currentInternalState) {
      throw new Error(`Template "${template.id}" requires InternalState input, but no InternalState snapshot is available`);
    }

    const normalizedState = cloneInternalState(currentInternalState);
    const snapshotRef = normalizeSnapshotRef(
      agentLoop.getCurrentInternalStateSnapshotRef?.(),
      'getCurrentInternalStateSnapshotRef result',
    ) ?? buildInternalStateSnapshotRef(normalizedState);
    const rawMetacognitiveFlags = agentLoop.getCurrentMetacognitiveFlags?.();
    const metacognitiveFlags = rawMetacognitiveFlags !== undefined
      ? normalizeMetacognitiveFlags(rawMetacognitiveFlags, 'getCurrentMetacognitiveFlags result')
      : latestMetacognitiveFlags;
    latestMetacognitiveFlags = metacognitiveFlags;

    return {
      internalState: normalizedState,
      internalStateSnapshotRef: snapshotRef,
      metacognitiveFlags,
    };
  };

  const formatNarrativePromptInput = (
    prompt: string,
    context: ReflectionInternalStateContext | null,
    appearanceContext?: string,
  ): string => {
    const sections: string[] = [prompt];
    if (context) {
      const concerns = context.internalState.attention.activeConcerns
        .slice(0, 12)
        .map((concern) => `[${concern.priority}|${concern.source}] ${concern.text}`);
      const concernSection = concerns.length > 0
        ? concerns.map((concern) => `- ${concern}`).join('\n')
        : '- none';
      const metacognitiveSection = context.metacognitiveFlags.length > 0
        ? context.metacognitiveFlags
          .map((flag) => `- ${flag.flag} (confidence=${flag.confidence.toFixed(2)})${flag.evidence ? ` evidence: ${flag.evidence}` : ''}`)
          .join('\n')
        : '- none exposed';

      sections.push(
        [
          '[Internal State Input]',
          `snapshot_ref: ${context.internalStateSnapshotRef}`,
          `serialized_internal_state: ${serializeInternalState(context.internalState)}`,
          '[Recent Metacognitive Flags]',
          metacognitiveSection,
          '[Active Concerns]',
          concernSection,
        ].join('\n'),
      );
    }
    if (appearanceContext) {
      sections.push(`Appearance context:\n${appearanceContext}`);
    }
    return sections.join('\n\n');
  };

  const captureResponseInternalStateContext = (
    response: HeartbeatAgentResponse,
  ): ReflectionInternalStateContext | null => {
    const metadata = response.metadata;
    if (!metadata) {
      return null;
    }

    if (metadata.internalState === undefined && metadata.internalStateSnapshotRef === undefined && metadata.metacognitiveFlags === undefined) {
      return null;
    }

    if (metadata.internalState === undefined) {
      throw new Error('Heartbeat response metadata.internalState is required when snapshot metadata is provided');
    }

    const internalState = cloneInternalState(metadata.internalState);
    const snapshotRef = normalizeSnapshotRef(
      metadata.internalStateSnapshotRef,
      'metadata.internalStateSnapshotRef',
    ) ?? buildInternalStateSnapshotRef(internalState);
    const metacognitiveFlags = normalizeMetacognitiveFlags(
      metadata.metacognitiveFlags,
      'metadata.metacognitiveFlags',
    );
    latestMetacognitiveFlags = metacognitiveFlags;
    return {
      internalState,
      internalStateSnapshotRef: snapshotRef,
      metacognitiveFlags,
    };
  };

  const toDeliberationMetadata = (
    result: DeliberationResult,
  ): ValuesDeliberationMetadata => ({
    sessionId: result.sessionId,
    stopReason: result.stopReason,
    rounds: result.rounds.length,
    totalInputTokens: result.totalInputTokens,
    totalOutputTokens: result.totalOutputTokens,
    totalTokens: result.totalTokens,
    estimatedCostUsd: result.estimatedCostUsd,
    durationMs: result.durationMs,
  });

  const persistDeliberationMemory = async (
    template: ReflectionTemplate,
    reflection: string,
    metadata: ValuesDeliberationMetadata,
  ): Promise<void> => {
    if (!runtimeOptions.memoryWriter) return;
    await runtimeOptions.memoryWriter.write({
      text: reflection,
      type: 'reflection',
      importance: 0.72,
      confidence: 0.78,
      emotionalValence: 0,
      sourceRef:
        `source:heartbeat|template:${template.id}|mode:deliberation`
        + `|session:${metadata.sessionId}|tokens:${metadata.totalTokens}`
        + `|cost_usd:${metadata.estimatedCostUsd.toFixed(6)}`,
      tags: [
        'heartbeat',
        'reflection',
        'deliberation',
        template.id,
        `stop:${metadata.stopReason}`,
      ],
    });
  };

  const shouldUseDeliberation = (template: ReflectionTemplate): boolean => {
    if (template.mode !== 'deliberation') return false;
    return Boolean(runtimeOptions.llmProvider);
  };

  const resolveDeliberationAppearanceContext = (): string | undefined => {
    const provider = runtimeOptions.characterPromptVariablesProvider;
    if (!provider) return undefined;
    try {
      const variables = provider();
      const candidates = [
        variables['character.visual_description'],
        variables.visual_description,
        variables.extensions_visual_description,
      ];
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const trimmed = candidate.trim();
        if (trimmed.length > 0) {
          return trimmed;
        }
      }
    } catch (error) {
      log.warn('Failed to resolve appearance context for deliberation heartbeat', {
        error: String(error),
      });
    }
    return undefined;
  };

  const runTemplateDeliberation = async (
    template: ReflectionTemplate,
    prompt: string,
  ): Promise<{ reflection: string; metadata: ValuesDeliberationMetadata }> => {
    const llmProvider = runtimeOptions.llmProvider;
    if (!llmProvider) {
      throw new Error('Deliberation mode requested without llmProvider');
    }
    const result = await runDeliberation(
      llmProvider,
      prompt,
      {
        ...(template.deliberation?.voices ? { voices: template.deliberation.voices } : {}),
        caps: {
          ...(template.deliberation?.maxRounds !== undefined
            ? { maxRounds: template.deliberation.maxRounds }
            : {}),
          ...(template.deliberation?.maxTotalTokens !== undefined
            ? { maxTotalTokens: template.deliberation.maxTotalTokens }
            : {}),
          ...(template.deliberation?.maxWallTimeMs !== undefined
            ? { maxWallTimeMs: template.deliberation.maxWallTimeMs }
            : {}),
        },
        cost: {
          ...(template.deliberation?.inputUsdPerMillionTokens !== undefined
            ? { inputUsdPerMillionTokens: template.deliberation.inputUsdPerMillionTokens }
            : {}),
          ...(template.deliberation?.outputUsdPerMillionTokens !== undefined
            ? { outputUsdPerMillionTokens: template.deliberation.outputUsdPerMillionTokens }
            : {}),
        },
      },
    );
    return {
      reflection: result.output,
      metadata: toDeliberationMetadata(result),
    };
  };

  const executeTemplate = async (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean } = {},
    source: HeartbeatExecutionSource = 'scheduled',
  ): Promise<{ templateId: string; templateName: string; reflection: string }> => {
    assertTemplateExecutionAllowed(template.id, source);

    const reflectionChannelId = `internal:reflection:${template.id}`;
    const internalStateContext = resolveInternalStateContext(template);
    const appearanceContext = shouldUseDeliberation(template) ? resolveDeliberationAppearanceContext() : undefined;
    const reflectionPrompt = formatNarrativePromptInput(template.prompt, internalStateContext, appearanceContext);
    const reflectionCreatedAt = new Date(Date.now()).toISOString();
    let reflectionText = '';
    let deliberationMetadata: ValuesDeliberationMetadata | undefined;
    let reflectionMode: 'agent' | 'deliberation' = 'agent';
    let persistenceContext = internalStateContext;
    let reflectionProcessId: string | undefined;

    if (shouldUseDeliberation(template)) {
      const processId = buildReflectionProcessId(`${template.id}-${source}`);
      reflectionProcessId = processId;
      try {
        reflectionProcessLog.append({
          processId,
          processLabel: `${template.name} deliberation`,
          processType: 'reflection_deliberation',
          stage: 'started',
          executionSource: source,
          createdAt: reflectionCreatedAt,
          templateId: template.id,
          templateName: template.name,
          channelId: reflectionChannelId,
          prompt: reflectionPrompt,
          tags: [template.id, 'reflection', 'deliberation'],
        });
      } catch (error) {
        log.warn(`Reflection "${template.id}" process-start log persistence skipped`, {
          error: String(error),
        });
      }

      try {
        const deliberationResult = await runTemplateDeliberation(template, reflectionPrompt);
        reflectionText = deliberationResult.reflection;
        deliberationMetadata = deliberationResult.metadata;
        reflectionMode = 'deliberation';

        try {
          reflectionProcessLog.append({
            processId,
            processLabel: `${template.name} deliberation`,
            processType: 'reflection_deliberation',
            stage: 'completed',
            executionSource: source,
            createdAt: new Date(Date.now()).toISOString(),
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            prompt: reflectionPrompt,
            reflection: reflectionText,
            deliberation: deliberationMetadata,
            tags: [template.id, 'reflection', 'deliberation'],
          });
        } catch (error) {
          log.warn(`Reflection "${template.id}" process log persistence skipped`, {
            error: String(error),
          });
        }

        try {
          await persistDeliberationMemory(template, reflectionText, deliberationMetadata);
        } catch (error) {
          log.warn(`Reflection "${template.id}" memory persistence skipped`, {
            error: String(error),
          });
        }
      } catch (error) {
        try {
          reflectionProcessLog.append({
            processId,
            processLabel: `${template.name} deliberation`,
            processType: 'reflection_deliberation',
            stage: 'failed',
            executionSource: source,
            createdAt: new Date(Date.now()).toISOString(),
            templateId: template.id,
            templateName: template.name,
            channelId: reflectionChannelId,
            prompt: reflectionPrompt,
            error: String(error),
            tags: [template.id, 'reflection', 'deliberation'],
          });
        } catch (processLogError) {
          log.warn(`Reflection "${template.id}" process-failure log persistence skipped`, {
            error: String(processLogError),
          });
        }
        throw error;
      }
    } else {
      const response = await agentLoop.handleMessage({
        id: `reflection-${template.id}-${Date.now()}`,
        channelId: reflectionChannelId,
        channelType: 'terminal',
        authorId: 'scheduler',
        authorName: template.name,
        content: reflectionPrompt,
        timestamp: new Date(),
      });
      reflectionText = response.content;
      const responseContext = captureResponseInternalStateContext(response);
      if (responseContext) {
        persistenceContext = responseContext;
      }
    }

    let reflectionJournalEntryId: string | undefined;
    try {
      const reflectionEntry = reflectionJournal.append({
        templateId: template.id,
        templateName: template.name,
        prompt: reflectionPrompt,
        reflection: reflectionText,
        channelId: reflectionChannelId,
        mode: reflectionMode,
        createdAt: reflectionCreatedAt,
        ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
        ...(persistenceContext ? {
          internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef,
          internalState: persistenceContext.internalState,
          metacognitiveFlags: persistenceContext.metacognitiveFlags,
        } : {}),
      });
      reflectionJournalEntryId = reflectionEntry.id;
    } catch (error) {
      log.warn(`Reflection "${template.id}" note journal persistence skipped`, {
        error: String(error),
      });
    }

    try {
      reflectionDailyJournal.append({
        source: 'heartbeat_template',
        executionSource: source,
        templateId: template.id,
        templateName: template.name,
        channelId: reflectionChannelId,
        prompt: reflectionPrompt,
        reflection: reflectionText,
        mode: reflectionMode,
        createdAt: reflectionCreatedAt,
        ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
        ...(reflectionProcessId ? { processId: reflectionProcessId } : {}),
        tags: [template.id, 'reflection', reflectionMode],
      });
    } catch (error) {
      log.warn(`Reflection "${template.id}" daily journal persistence skipped`, {
        error: String(error),
      });
    }

    if (template.id === 'values-reflection') {
      valuesJournal.append({
        templateId: template.id,
        templateName: template.name,
        prompt: reflectionPrompt,
        reflection: reflectionText,
        ...(deliberationMetadata ? { deliberation: deliberationMetadata } : {}),
        ...(persistenceContext ? {
          internalStateSnapshotRef: persistenceContext.internalStateSnapshotRef,
          internalState: persistenceContext.internalState,
          metacognitiveFlags: persistenceContext.metacognitiveFlags,
        } : {}),
        provenance: {
          source: 'companion_reflection',
          templateId: template.id,
          templateName: template.name,
          channelId: reflectionChannelId,
          mode: reflectionMode,
          ...(reflectionJournalEntryId ? { reflectionJournalEntryId } : {}),
        },
      });
    }

    // Auto-publish to Obsidian vault
    if (runtimeOptions.vaultAutoPublisher) {
      try {
        await runtimeOptions.vaultAutoPublisher.publishReflection({
          templateId: template.id,
          templateName: template.name,
          reflection: reflectionText,
          mode: reflectionMode,
          createdAt: new Date(),
        });
      } catch (error) {
        log.warn(`Reflection "${template.id}" vault publish skipped`, { error: String(error) });
      }
    }

    const shouldSendToDiscord = options.sendToDiscordOverride ?? template.sendToDiscord;
    if (shouldSendToDiscord && heartbeatChannelId) {
      await sender.send(heartbeatChannelId, reflectionText);
    }

    return {
      templateId: template.id,
      templateName: template.name,
      reflection: reflectionText,
    };
  };

  const executeScheduledTemplate = async (template: ReflectionTemplate): Promise<void> => {
    const now = Date.now();
    const lastRunAt = lastScheduledRunAt.get(template.id);
    if (lastRunAt !== undefined && now - lastRunAt < MIN_SCHEDULED_TEMPLATE_GAP_MS) {
      log.warn(`Skipping reflection "${template.id}" due to rapid re-fire guard`, {
        templateId: template.id,
        sinceLastMs: now - lastRunAt,
      });
      return;
    }
    lastScheduledRunAt.set(template.id, now);
    try {
      await executeTemplate(template, {}, 'scheduled');
    } catch (error) {
      if (isHeartbeatTemplateLoopGuardError(error)) {
        log.warn('Scheduled reflection suppressed by rapid-fire loop guard', {
          templateId: template.id,
          source: error.source,
          cooldownUntil: new Date(error.cooldownUntil).toISOString(),
        });
        return;
      }
      if (!isBusyTurnError(error)) {
        throw error;
      }
      const deferred = queueDeferredTemplateRun(template.id);
      log.info('Deferred scheduled reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
    }
  };

  const buildDeferredHeartbeatAction = (
    template: ReflectionTemplate,
    options: { sendToDiscordOverride?: boolean } = {},
  ): PostTurnActionCandidate => ({
    kind: DEFERRED_HEARTBEAT_ACTION_KIND,
    payload: {
      templateId: template.id,
      ...(options.sendToDiscordOverride !== undefined
        ? { sendToDiscordOverride: options.sendToDiscordOverride }
        : {}),
    },
    dedupeKey: (
      options.sendToDiscordOverride === undefined
        ? `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}`
        : `${DEFERRED_HEARTBEAT_ACTION_KIND}:${template.id}:discord:${String(options.sendToDiscordOverride)}`
    ),
    maxRetries: 2,
  });

  const queueDeferredTemplateRun = (
    templateId: string,
    options: { sendToDiscordOverride?: boolean } = {},
  ): { templateName: string; queuedNow: boolean } => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    if (pendingDeferredTemplates.has(template.id)) {
      return { templateName: template.name, queuedNow: false };
    }

    pendingDeferredTemplates.add(template.id);
    const taskId = `${DEFERRED_REFLECTION_TASK_PREFIX}${template.id}:${Date.now()}`;
    try {
      scheduler.register({
        id: taskId,
        name: `${template.name} (deferred)`,
        type: 'one-shot',
        intervalMs: 0,
        runAt: Date.now() + 250,
        handler: async () => {
          try {
            await agentLoop.waitForIdle?.();
            const latestPolicy = store.load();
            const latestTemplate = latestPolicy.templates.find(candidate => candidate.id === template.id);
            if (!latestTemplate) {
              log.warn('Skipped deferred reflection; template removed before execution', {
                templateId: template.id,
                taskId,
              });
              return;
            }
            await executeTemplate(latestTemplate, options, 'deferred_scheduler');
          } catch (error) {
            if (isHeartbeatTemplateLoopGuardError(error)) {
              log.warn(`Deferred reflection "${template.id}" suppressed by rapid-fire loop guard`, {
                templateId: template.id,
                source: error.source,
                cooldownUntil: new Date(error.cooldownUntil).toISOString(),
              });
              return;
            }
            log.error(`Deferred reflection "${template.id}" failed`, { error: String(error) });
          } finally {
            pendingDeferredTemplates.delete(template.id);
          }
        },
        state: 'idle',
      });
      return { templateName: template.name, queuedNow: true };
    } catch (error) {
      pendingDeferredTemplates.delete(template.id);
      throw error;
    }
  };

  const runTemplateNow = async (
    templateId: string,
    options: { sendToDiscordOverride?: boolean; deferIfBusy?: boolean } = {},
  ): Promise<{
      templateId: string;
      templateName: string;
      reflection: string;
      queued?: boolean;
      deferredAction?: PostTurnActionCandidate;
    }> => {
    const current = store.load();
    const template = current.templates.find(candidate => candidate.id === templateId);
    if (!template) {
      throw new Error(`Template "${templateId}" not found`);
    }
    try {
      return await executeTemplate(template, options, 'manual');
    } catch (error) {
      if (options.deferIfBusy === false || !isBusyTurnError(error)) {
        throw error;
      }
      if (runtimeOptions.postTurnActions) {
        const deferredAction = buildDeferredHeartbeatAction(template, options);
        log.info('Inferred deferred heartbeat action from busy template execution', {
          templateId: template.id,
          dedupeKey: deferredAction.dedupeKey,
        });
        return {
          templateId: template.id,
          templateName: template.name,
          reflection: '',
          queued: true,
          deferredAction,
        };
      }

      const deferred = queueDeferredTemplateRun(template.id, {
        sendToDiscordOverride: options.sendToDiscordOverride,
      });
      log.info('Deferred manual reflection template execution', {
        templateId: template.id,
        queuedNow: deferred.queuedNow,
      });
      return {
        templateId: template.id,
        templateName: deferred.templateName,
        reflection: '',
        queued: true,
        deferredAction: buildDeferredHeartbeatAction(template, options),
      };
    }
  };

  type PostTurnInfererContext = Parameters<PostTurnActionInferer>[0];

  const buildConversationTrajectory = (context: Pick<PostTurnInfererContext, 'message' | 'response'>) => {
    const unresolvedTopics: string[] = [];
    const userText = context.message.content.trim();
    const responseText = context.response.content.trim();
    if (userText.includes('?') && !responseText.endsWith('?')) {
      unresolvedTopics.push(userText.slice(0, 180));
    }

    const summary = `User: ${userText.slice(0, 180)} | Assistant: ${responseText.slice(0, 180)}`;
    return {
      ...(unresolvedTopics.length > 0 ? { unresolvedTopics } : {}),
      summary,
      turnsSinceUserReply: 0,
    };
  };

  const triggerIntentionPostTurnAppraisal = (
    context: Pick<PostTurnInfererContext, 'message' | 'response' | 'canonicalContactKey' | 'completedAt'>,
  ): void => {
    if (!intentionAppraisal || !telemetryEventBus) {
      return;
    }

    const resolvedSessionId = (
      runtimeOptions.sessionManager?.resolveSessionChannelId(context.message.channelId)
      ?? context.message.channelId
    ).trim() || context.message.channelId;

    if (intentionSessionsInFlight.has(resolvedSessionId)) {
      return;
    }
    intentionSessionsInFlight.add(resolvedSessionId);

    void (async () => {
      try {
        const recentSessionEntries = runtimeOptions.sessionManager?.getRecentMessages(resolvedSessionId, 12) ?? [];
        const recentMessages = sessionEntriesToIntentionMessages(recentSessionEntries);
        recentMessages.push({
          role: 'user',
          content: context.message.content,
          timestamp: context.message.timestamp.getTime(),
        });
        const trimmedResponse = context.response.content.trim();
        if (trimmedResponse) {
          recentMessages.push({
            role: 'assistant',
            content: trimmedResponse,
            timestamp: Date.now(),
          });
        }

        if (context.response.metadata.internalState === undefined) {
          throw new Error('Intention post-turn appraisal requires response.metadata.internalState');
        }
        const internalState = cloneInternalState(context.response.metadata.internalState);
        const currentEmotion = {
          vad: { ...internalState.emotional.vad },
          mood: { ...internalState.emotional.mood },
          discrete: { ...internalState.emotional.discreteEmotions },
          confidence: internalState.emotional.confidence,
        };
        if (runtimeOptions.onBehavioralPatternOutcome) {
          try {
            await runtimeOptions.onBehavioralPatternOutcome({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
              emotionSnapshot: currentEmotion,
              observedAtMs: context.completedAt,
            });
          } catch (error) {
            log.warn('Behavioral pattern outcome hook failed', {
              channelId: context.message.channelId,
              messageId: context.message.id,
              error: String(error),
            });
          }
        }
        const contactEmotionalSnapshot = (
          context.canonicalContactKey
          && runtimeOptions.contactStore?.getEmotionalSnapshot
        )
          ? runtimeOptions.contactStore.getEmotionalSnapshot(context.canonicalContactKey) ?? null
          : null;
        const isPrimaryContact = context.canonicalContactKey
          ? runtimeOptions.contactStore?.getById?.(context.canonicalContactKey)?.trustLevel === 'primary'
          : false;
        const motivationAssessment = motivationBridge?.assess({
          sessionId: resolvedSessionId,
          currentEmotion,
          contactEmotionalSnapshot,
          isPrimaryContact,
        });
        if (motivationAssessment?.shouldTriggerAppraisal) {
          log.debug('Motivation bridge trigger matched', {
            sessionId: resolvedSessionId,
            profile: motivationAssessment.profile,
            signals: motivationAssessment.signals.map(signal => signal.kind),
            metrics: motivationAssessment.metrics,
          });
        }
        const activeConcerns = runtimeOptions.getActiveConcerns
          ? await Promise.resolve(
            runtimeOptions.getActiveConcerns({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
            }),
          )
          : undefined;
        const recentlyResolvedConcerns = runtimeOptions.getRecentResolvedConcerns
          ? await Promise.resolve(
            runtimeOptions.getRecentResolvedConcerns({
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
            }),
          )
          : undefined;
        const decisions = await intentionAppraisal.evaluate({
          sessionId: resolvedSessionId,
          internalState,
          currentEmotion,
          recentMessages,
          ...(activeConcerns ? { activeConcerns } : {}),
          ...(recentlyResolvedConcerns ? { recentlyResolvedConcerns } : {}),
          contactEmotionalSnapshot,
          conversationTrajectory: buildConversationTrajectory(context),
          ...(motivationAssessment?.shouldTriggerAppraisal
            ? {
              triggerOverride: 'motivation' as const,
              motivationSignals: motivationAssessment.signals.map(signal => signal.kind),
            }
            : {}),
        });

        if (runtimeOptions.onIntentionConcernDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'concern') continue;
            await runtimeOptions.onIntentionConcernDecision({
              decision,
              channelId: resolvedSessionId,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
            });
          }
        }
        if (runtimeOptions.onIntentionFollowUpDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'followUp') continue;
            const pendingFollowUpId = await runtimeOptions.onIntentionFollowUpDecision({
              decision,
              channelId: resolvedSessionId,
              channelType: context.message.channelType,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
            });
            if (pendingFollowUpId) {
              decision.followUp = {
                ...decision.followUp,
                pendingFollowUpId,
              };
            }
          }
        }
        if (runtimeOptions.onIntentionReminderDecision) {
          for (const decision of decisions) {
            if (decision.type !== 'reminder') continue;
            const reminderId = await runtimeOptions.onIntentionReminderDecision({
              decision,
              channelId: resolvedSessionId,
              channelType: context.message.channelType,
              canonicalContactKey: context.canonicalContactKey,
              sourceMessageId: context.message.id,
            });
            if (reminderId) {
              decision.reminder = {
                ...decision.reminder,
                reminderId,
              };
            }
          }
        }

        const candidates = decisionsToPostTurnActionCandidates(
          decisions,
          {
            message: context.message,
          },
          isBackgroundAppraisalChannel(context.message.channelId)
            ? { surfacePendingFollowUpsImmediately: true }
            : {},
        );
        if (candidates.length === 0) {
          return;
        }

        const inferredActions = toInferredPostTurnActions(candidates, context.message);
        if (inferredActions.length === 0) {
          return;
        }

        await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
          message: context.message,
          response: context.response,
          actions: inferredActions,
        });
      } catch (error) {
        log.warn('Intention post-turn appraisal dispatch failed', {
          channelId: context.message.channelId,
          messageId: context.message.id,
          error: String(error),
        });
      } finally {
        intentionSessionsInFlight.delete(resolvedSessionId);
      }
    })();
  };

  if (runtimeOptions.postTurnActions) {
    telemetryEventBus?.on('agent.post_turn.action.telemetry', (telemetry) => {
      if (telemetry.actionKind !== DEFERRED_TOOL_HANDOFF_ACTION_KIND) {
        return;
      }

      const payload = deferredToolHandoffPayloads.get(telemetry.dedupeKey);
      if (!payload) {
        return;
      }

      if (telemetry.phase === 'queued') {
        emitDeferredToolHandoffTelemetry({
          actionId: telemetry.actionId,
          dedupeKey: telemetry.dedupeKey,
          channelId: telemetry.channelId,
          sourceMessageId: telemetry.sourceMessageId,
          toolNames: payload.toolNames,
          intendedAction: payload.intendedAction,
          phase: 'queued',
          attempt: telemetry.attempt,
          maxAttempts: telemetry.maxAttempts,
        });
      } else if (telemetry.phase === 'failed') {
        emitDeferredToolHandoffTelemetry({
          actionId: telemetry.actionId,
          dedupeKey: telemetry.dedupeKey,
          channelId: telemetry.channelId,
          sourceMessageId: telemetry.sourceMessageId,
          toolNames: payload.toolNames,
          intendedAction: payload.intendedAction,
          phase: 'failed',
          attempt: telemetry.attempt,
          maxAttempts: telemetry.maxAttempts,
          ...(telemetry.error ? { error: telemetry.error } : {}),
        });
        deferredToolHandoffExecutionState.delete(telemetry.dedupeKey);
        deferredToolHandoffPayloads.delete(telemetry.dedupeKey);
      } else if (telemetry.phase === 'succeeded') {
        deferredToolHandoffExecutionState.delete(telemetry.dedupeKey);
        deferredToolHandoffPayloads.delete(telemetry.dedupeKey);
      }
    });

    runtimeOptions.postTurnActions.registerHandler(
      DEFERRED_TOOL_HANDOFF_ACTION_KIND,
      async (action) => {
        const payload = normalizeDeferredToolHandoffPayload(action.payload);
        if (!payload) {
          throw new Error(`Deferred tool handoff action "${action.id}" is missing required payload fields`);
        }
        deferredToolHandoffPayloads.set(action.dedupeKey, payload);

        const executionState = deferredToolHandoffExecutionState.get(action.dedupeKey) ?? {
          activated: false,
          executed: false,
        };

        if (!executionState.activated) {
          const activation = agentLoop.activateExtendedTools?.(payload.toolNames, {
            source: 'deferred',
            correlation: {
              turnId: action.sourceMessageId || action.id,
              requestId: action.id,
              channelId: action.channelId,
              callType: 'tool',
              purpose: 'agent.tools.adaptive.decision',
            },
            taskKind: 'deferred_tool_handoff',
            intent: 'deferred_tool_handoff',
          });
          if (!activation) {
            throw new Error('Agent loop does not support deferred tool activation');
          }
          if (activation.activatedTools.length === 0) {
            throw new Error(
              `Deferred tool handoff action "${action.id}" could not activate tools: ${payload.toolNames.join(', ')}`,
            );
          }
          executionState.activated = true;
          emitDeferredToolHandoffTelemetry({
            actionId: action.id,
            dedupeKey: action.dedupeKey,
            channelId: action.channelId,
            sourceMessageId: action.sourceMessageId,
            toolNames: payload.toolNames,
            intendedAction: payload.intendedAction,
            phase: 'activated',
          });
          deferredToolHandoffExecutionState.set(action.dedupeKey, executionState);
        }

        if (executionState.executed) {
          return;
        }

        const response = await agentLoop.handleMessage(buildDeferredToolHandoffMessage(action.id, payload));
        const responseText = response.content.trim();
        if (responseText && !payload.turn.channelId.startsWith('internal:')) {
          await sender.send(payload.turn.channelId, responseText);
        }

        executionState.executed = true;
        deferredToolHandoffExecutionState.set(action.dedupeKey, executionState);
        emitDeferredToolHandoffTelemetry({
          actionId: action.id,
          dedupeKey: action.dedupeKey,
          channelId: action.channelId,
          sourceMessageId: action.sourceMessageId,
          toolNames: payload.toolNames,
          intendedAction: payload.intendedAction,
          phase: 'executed',
        });
      },
      { executionMode: 'background' },
    );

    runtimeOptions.postTurnActions.registerHandler(
      DEFERRED_HEARTBEAT_ACTION_KIND,
      async (action) => {
        const templateIdRaw = action.payload.templateId;
        if (typeof templateIdRaw !== 'string' || !templateIdRaw.trim()) {
          throw new Error(`Deferred heartbeat action "${action.id}" is missing payload.templateId`);
        }
        const templateId = templateIdRaw.trim();
        const current = store.load();
        const template = current.templates.find(candidate => candidate.id === templateId);
        if (!template) {
          throw new Error(`Template "${templateId}" not found`);
        }
        const sendToDiscordOverride = typeof action.payload.sendToDiscordOverride === 'boolean'
          ? action.payload.sendToDiscordOverride
          : undefined;
        try {
          await executeTemplate(template, {
            ...(sendToDiscordOverride !== undefined ? { sendToDiscordOverride } : {}),
          }, 'deferred_post_turn');
        } catch (error) {
          if (isHeartbeatTemplateLoopGuardError(error)) {
            log.warn(`Deferred heartbeat action "${action.id}" suppressed by rapid-fire loop guard`, {
              templateId,
              source: error.source,
              cooldownUntil: new Date(error.cooldownUntil).toISOString(),
            });
            return;
          }
          throw error;
        }
      },
    );
    if (intentionAppraisal) {
      if (agentLoop.followUp) {
        runtimeOptions.postTurnActions.registerHandler(
          INTENTION_FOLLOW_UP_ACTION_KIND,
          async (action) => {
            const payload = normalizeIntentionFollowUpActionPayload(action.payload);
            if (!payload) {
              throw new Error(`Intention follow-up action "${action.id}" payload is missing required fields`);
            }
            if (payload.pendingFollowUpId && runtimeOptions.onIntentionFollowUpActivated) {
              await runtimeOptions.onIntentionFollowUpActivated({
                pendingFollowUpId: payload.pendingFollowUpId,
                activationReason: 'post_turn_action',
              });
            }
            agentLoop.followUp?.({
              id: `intention-follow-up:${action.id}`,
              channelId: payload.channelId,
              channelType: payload.channelType,
              authorId: payload.authorId,
              authorName: payload.authorName,
              content: payload.content,
              timestamp: new Date(),
            });
          },
          { executionMode: 'background' },
        );
        runtimeOptions.postTurnActions.registerHandler(
          INTENTION_REMINDER_ACTION_KIND,
          async (action) => {
            const payload = normalizeIntentionReminderActionPayload(action.payload);
            if (!payload) {
              throw new Error(`Intention reminder action "${action.id}" payload is missing required fields`);
            }
            if (!runtimeOptions.onIntentionReminderTriggered) {
              throw new Error('Intention reminder action triggered without reminder substrate wiring');
            }
            const triggered = await runtimeOptions.onIntentionReminderTriggered({
              reminderId: payload.reminderId,
            });
            if (!triggered) {
              return;
            }
            if (triggered.nextDueAt && telemetryEventBus) {
              const nextRunAt = Date.parse(triggered.nextDueAt);
              if (Number.isFinite(nextRunAt) && nextRunAt > 0) {
                const nextActions = toInferredPostTurnActions([{
                  kind: INTENTION_REMINDER_ACTION_KIND,
                  dedupeKey: `${INTENTION_REMINDER_ACTION_KIND}:${triggered.reminderId}:${nextRunAt}`,
                  payload: {
                    reminderId: triggered.reminderId,
                  },
                  maxRetries: 1,
                  runAt: nextRunAt,
                }], {
                  id: action.id,
                  channelId: action.channelId,
                });
                if (nextActions.length > 0) {
                  await telemetryEventBus.emit('agent.post_turn.actions.inferred', {
                    actions: nextActions,
                  });
                }
              }
            }
            agentLoop.followUp?.({
              id: `intention-reminder:${action.id}`,
              channelId: triggered.channelId,
              channelType: triggered.channelType,
              authorId: triggered.authorId,
              authorName: triggered.authorName,
              content: triggered.content,
              timestamp: new Date(),
            });
          },
          { executionMode: 'background' },
        );
      } else {
        log.warn('Intention appraisal enabled but followUp hook is unavailable on agent loop');
      }
    }
    if (sleeptimeAgent) {
      runtimeOptions.postTurnActions.registerHandler(
        SLEEPTIME_MEMORY_ACTION_KIND,
        async (action) => {
          await sleeptimeAgent.execute(action);
        },
        { executionMode: 'background' },
      );
    } else {
      log.info('Sleeptime memory agent wiring skipped: missing post-turn dependencies', {
        hasPostTurnActions: Boolean(runtimeOptions.postTurnActions),
        hasLLMProvider: Boolean(runtimeOptions.llmProvider),
        hasMemoryWriter: Boolean(runtimeOptions.memoryWriter),
        hasSessionManager: Boolean(runtimeOptions.sessionManager),
        hasCoreMemoryStore: Boolean(runtimeOptions.coreMemoryStore),
      });
    }

    if (agentLoop.registerPostTurnActionInferer) {
      const inferDeferredPostTurnActions: PostTurnActionInferer = async ({
        message,
        response,
        turnMessages,
        canonicalContactKey,
      }) => {
        const inferred = shouldUseCompositionalAppraisal(message.channelId)
          ? await inferComposedDeferredPostTurnActions({
            message,
            turnMessages,
            deferredHeartbeatActionKind: DEFERRED_HEARTBEAT_ACTION_KIND,
            onDeferredToolHandoffPayload: (dedupeKey, payload) => {
              deferredToolHandoffPayloads.set(dedupeKey, payload);
            },
          })
          : inferDeferredPostTurnActionsFromMessages({
            message,
            turnMessages,
            deferredHeartbeatActionKind: DEFERRED_HEARTBEAT_ACTION_KIND,
            onDeferredToolHandoffPayload: (dedupeKey, payload) => {
              deferredToolHandoffPayloads.set(dedupeKey, payload);
            },
          });
        if (sleeptimeAgent) {
          inferred.push(...sleeptimeAgent.inferPostTurnActions({ message }));
        }
        triggerIntentionPostTurnAppraisal({
          message,
          response,
          canonicalContactKey,
          completedAt: Date.now(),
        });
        return inferred;
      };
      agentLoop.registerPostTurnActionInferer(inferDeferredPostTurnActions);
    } else {
      log.warn('Post-turn action runtime enabled but inferer registration is unavailable');
    }
  }

  // Create sync function that re-registers all reflection tasks
  const syncReflectionTasks = (): void => {
    // Unregister all existing reflection:* tasks
    for (const task of scheduler.listTasks()) {
      if (task.id.startsWith('reflection:') && !task.id.startsWith(DEFERRED_REFLECTION_TASK_PREFIX)) {
        scheduler.unregister(task.id);
      }
    }

    // Re-register from current policy
    const current = store.load();
    for (const template of current.templates) {
      if (!template.enabled) continue;
      scheduler.register(
        {
          id: `reflection:${template.id}`,
          name: template.name,
          type: 'every',
          intervalMs: template.intervalMs,
          cadence: template.cadence,
          handler: async () => {
            try {
              await executeScheduledTemplate(template);
            } catch (err) {
              log.error(`Reflection "${template.id}" error`, { error: String(err) });
            }
          },
          state: 'idle',
        },
        { skipFirstRun: true },
      );
    }

    const activeCount = current.templates.filter(t => t.enabled).length;
    log.info(`Synced ${activeCount} reflection tasks`);
  };

  // Initial sync
  syncReflectionTasks();

  // Register tools
  target.registerTool(createHeartbeatGetPolicyTool(store), 'core');
  target.registerTool(createHeartbeatUpdatePolicyTool(store, syncReflectionTasks), 'extended');
  target.registerTool(createHeartbeatRunTemplateTool(store, runTemplateNow), 'extended');
  target.registerTool(createScheduleTaskTool(scheduler, agentLoop, sender, heartbeatChannelId), 'extended');
  target.registerTool(createValuesListTool(valuesJournal), 'core');
  target.registerTool(createValuesAddTool(valuesJournal), 'extended');
  target.registerTool(createValuesUpdateTool(valuesJournal), 'extended');

  const activeCount = policy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${policy.templates.length} templates, ${activeCount} active)`);
}
