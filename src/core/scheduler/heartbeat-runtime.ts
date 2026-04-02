import type {
  PostTurnActionCandidate,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { CapabilityTier } from '../../system/capabilities/tier-types.js';
import type { CompositionalPolicyConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ToolRegistrarTarget } from '../agent/tool-registrar.js';
import type {
  ExtendedToolActivationOptions,
  ExtendedToolActivationResult,
  PostTurnActionInferer,
} from '../agent/substrate-agent.js';
import type { LLMProvider } from '../agent/contracts.js';
import type { MemoryWriter } from '../../faculties/memory/writer.js';
import type { ReflectionMetacognitionJournalStore } from '../../persistence/journals/reflection-metacognition-journal.js';
import type { SessionManager } from '../session/manager.js';
import type { CoreMemoryStore } from '../../faculties/core-memory/store.js';
import type { MessageSender } from '../../system/lifecycle/notifications.js';
import type { Scheduler } from './scheduler.js';
import {
  createHeartbeatGetPolicyTool,
  createHeartbeatRunTemplateTool,
  createHeartbeatUpdatePolicyTool,
  createScheduleTaskTool,
} from './heartbeat-tools.js';
import { createScheduleTool } from './schedule-tool.js';
import {
  createValuesAddTool,
  createValuesListTool,
  createValuesUpdateTool,
} from '../../faculties/values/tools.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from '../intention/appraisal.js';
import type { PendingFollowUp, PendingFollowUpStore } from '../intention/pending-follow-ups.js';
import type { CareReminderStore } from '../intention/care-reminders.js';
import type { PostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import type { InternalState } from '../self-model/state.js';
import { createLegacyAliasTelemetryEmitter } from '../tools/legacy-alias-telemetry.js';
import {
  createHeartbeatTemplateRuntime,
  type HeartbeatTemplateRuntime,
} from './heartbeat-template-runtime.js';
import { wireHeartbeatPostTurnRuntime } from './heartbeat-post-turn-runtime.js';

const log = createComponentLogger('HeartbeatRuntime');

export const DEFERRED_HEARTBEAT_ACTION_KIND = 'heartbeat.run_template';

export interface HeartbeatAgent {
  handleMessage(message: SubstrateMessage): Promise<{
    content: string;
    metadata?: {
      internalState?: InternalState;
      internalStateSnapshotRef?: string;
      metacognitiveFlags?: unknown;
    };
  }>;
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

export interface HeartbeatRuntimeOptions {
  eventBus?: EventBus;
  llmProvider?: LLMProvider;
  capabilityTier?: CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
  characterPromptVariablesProvider?: () => Record<string, string>;
  memoryWriter?: Pick<MemoryWriter, 'write'>;
  reflectionStore?: ReflectionMetacognitionJournalStore;
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
  getPendingFollowUpsForResurfacing?: (input: {
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
    isBackgroundTurn: boolean;
    now: number;
    motivationSignals?: readonly string[];
    currentMoodValence?: number | null;
  }) => Promise<readonly PendingFollowUp[]> | readonly PendingFollowUp[];
  onIntentionFollowUpActivated?: (input: {
    pendingFollowUpId: string;
    activationReason?: string;
  }) => Promise<boolean | undefined> | boolean | undefined;
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
  pendingFollowUpStore?: PendingFollowUpStore | null;
  careReminderStore?: CareReminderStore | null;
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

export interface HeartbeatRunTemplateResult {
  templateId: string;
  templateName: string;
  reflection: string;
  silent?: boolean;
  queued?: boolean;
  queuedVia?: 'scheduler' | 'post_turn';
  deferredAction?: PostTurnActionCandidate;
}

export function wireHeartbeatRuntime(
  target: ToolRegistrarTarget,
  scheduler: Scheduler,
  agentLoop: HeartbeatAgent,
  sender: MessageSender,
  dataDir: string,
  heartbeatChannelId?: string,
  runtimeOptions: HeartbeatRuntimeOptions = {},
): void {
  const templateRuntime: HeartbeatTemplateRuntime = createHeartbeatTemplateRuntime({
    scheduler,
    agentLoop,
    sender,
    dataDir,
    heartbeatChannelId,
    runtimeOptions,
  });

  wireHeartbeatPostTurnRuntime({
    agentLoop,
    sender,
    templateRuntime,
    runtimeOptions,
  });

  target.registerTool(createHeartbeatGetPolicyTool(templateRuntime.policyStore), 'core');
  target.registerTool(createScheduleTool({
    scheduler,
    agentLoop,
    sender,
    heartbeatPolicyStore: templateRuntime.policyStore,
    syncReflectionTasks: templateRuntime.syncReflectionTasks,
    runTemplate: templateRuntime.runTemplateNow,
    heartbeatChannelId,
    memoryWriter: runtimeOptions.memoryWriter,
    pendingFollowUpStore: runtimeOptions.pendingFollowUpStore ?? null,
    careReminderStore: runtimeOptions.careReminderStore ?? null,
    emitLegacyAliasTelemetry: createLegacyAliasTelemetryEmitter(runtimeOptions.eventBus),
  }), 'core');
  target.registerTool(createHeartbeatUpdatePolicyTool(templateRuntime.policyStore, templateRuntime.syncReflectionTasks, {
    memoryWriter: runtimeOptions.memoryWriter,
    reflectionStore: runtimeOptions.reflectionStore,
  }), 'extended');
  target.registerTool(createHeartbeatRunTemplateTool(templateRuntime.policyStore, templateRuntime.runTemplateNow), 'extended');
  target.registerTool(createScheduleTaskTool(scheduler, agentLoop, sender, heartbeatChannelId), 'extended');
  target.registerTool(createValuesListTool(templateRuntime.valuesJournal), 'core');
  target.registerTool(createValuesAddTool(templateRuntime.valuesJournal), 'extended');
  target.registerTool(createValuesUpdateTool(templateRuntime.valuesJournal), 'extended');

  const activeCount = templateRuntime.initialPolicy.templates.filter(t => t.enabled).length;
  log.info(`Heartbeat runtime wired (${templateRuntime.initialPolicy.templates.length} templates, ${activeCount} active)`);
}
