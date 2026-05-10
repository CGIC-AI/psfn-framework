import type {
  PostTurnActionCandidate,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { CapabilityTier } from '../../system/capabilities/tier-types.js';
import type { CompositionalPolicyConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { LLMProvider } from '../agent/contracts.js';
import type {
  ExtendedToolActivationOptions,
  ExtendedToolActivationResult,
  PostTurnActionInferer,
} from '../agent/substrate-agent.js';
import type { MemoryWriter } from '../../faculties/memory/writer.js';
import type { ReflectionMetacognitionJournalStore } from '../../persistence/journals/reflection-metacognition-journal.js';
import type { SessionManager } from '../session/manager.js';
import type { CoreMemoryStore } from '../../faculties/core-memory/store.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from '../intention/appraisal.js';
import type { PendingFollowUp } from '../intention/pending-follow-ups.js';
import type { PendingFollowUpStorePort } from '../intention/pending-follow-up-store-port.js';
import type { CareReminderStore } from '../intention/care-reminders.js';
import type { PostTurnActionRuntime } from '../../app/startup/composition/post-turn-actions.js';
import type { InternalState } from '../self-model/state.js';
import type { MemoryExtractor } from '../agent/contracts.js';

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
  memoryExtractor?: MemoryExtractor | null;
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
  pendingFollowUpStore?: PendingFollowUpStorePort | null;
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
