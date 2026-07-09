import type {
  PostTurnActionCandidate,
  SubstrateMessage,
} from '../../shared/contracts/runtime.js';
import type { CapabilityTier } from '../../system/capabilities/tier-types.js';
import type { CompositionalPolicyConfig } from '../../system/config/runtime-config-contracts.js';
import type {
  EpisodeSynthesisLaneConfig,
  EpisodicProcessingRestWindowConfig,
  NearTurnMemoryCadenceConfig,
  OrientationRewriteGateConfig,
  ReflectionNoveltyGateConfig,
} from '../../system/config/scheduler-config.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { LLMProviderPort } from '../agent/contracts.js';
import type {
  ExtendedToolActivationOptions,
  ExtendedToolActivationResult,
  PostTurnActionInferer,
} from '../agent/substrate-agent.js';
import type { MemoryWriter } from '../../faculties/memory/writer.js';
import type { MemoryStorePort } from '../../faculties/memory/memory-store-port.js';
import type { EpisodicSynthesizer } from '../../faculties/memory/episodic/synthesis.js';
import type { SleepCycleEpisodeConsolidator } from '../../faculties/memory/episodic/sleep-consolidation.js';
import type { EpisodeArcWeaver } from '../../faculties/memory/episodic/arc-formation.js';
import type { DreamMeaningPass } from '../../faculties/memory/episodic/dream-meaning-pass.js';
import type { SleeptimeWikiPass } from '../../faculties/wiki/sleeptime-wiki-pass.js';
import type { NearTurnMemoryScopeClassifierPort } from '../../faculties/memory/near-turn-memory-lane.js';
import type { ProactiveOutboundDispatcher } from '../intention/proactive-outbound.js';
import type { OutreachOutboxStore } from '../intention/outreach-outbox.js';
import type {
  EpisodicStorePort,
} from '../../faculties/memory/episodic/store-port.js';
import type { ReflectionMetacognitionJournalStore } from '../../persistence/journals/reflection-metacognition-journal.js';
import type { SessionManager } from '../session/manager.js';
import type { CoreMemoryStore } from '../../faculties/core-memory/store.js';
import type { EmotionStateSnapshot } from '../emotion/state.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import type {
  ActiveConcernSnapshot,
  IntentionActionDecision,
} from '../intention/appraisal.js';
import type { PendingFollowUp } from '../intention/pending-follow-ups.js';
import type { PendingFollowUpStorePort } from '../intention/pending-follow-up-store-port.js';
import type { CareReminderStorePort } from '../intention/care-reminders.js';
import type { ScheduledPromptStorePort } from './scheduled-prompt-store-port.js';
import type { PostTurnActionRuntime } from '../agent/post-turn-action-runtime.js';
import type { InternalState } from '../self-model/state.js';
import type { MemoryExtractor } from '../agent/contracts.js';
import type { PromptRegistryStatePort } from '../identity/prompt-state-port.js';
import type { OutboundReplyGuardPort } from '../../system/lifecycle/outbound-reply-dedupe.js';
import type {
  DriftVelocityEvidencePort,
  DriftVelocityWatermarkStore,
} from '../cogsec/drift/drift-review-lane.js';
import type { SecondArrowEvidencePort } from '../cogsec/drift/second-arrow-review-lane.js';
import type { DriftReviewCardStore } from '../cogsec/drift/drift-review-card-store.js';
import type {
  IntakeDriftDetectionPolicyConfig,
  IntakeSecondArrowPolicyConfig,
} from '../../system/config/intake-policy-config.js';

export const DEFERRED_HEARTBEAT_ACTION_KIND = 'heartbeat.run_template';

export interface HeartbeatAgent {
  handleMessage(message: SubstrateMessage): Promise<{
    content: string;
    metadata?: {
      internalState?: InternalState;
      internalStateSnapshotRef?: string;
      metacognitiveFlags?: unknown;
      retrievalProvenanceRefs?: string[];
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
  llmProvider?: LLMProviderPort;
  capabilityTier?: CapabilityTier;
  compositionalPolicy?: CompositionalPolicyConfig;
  characterPromptVariablesProvider?: () => Record<string, string>;
  memoryWriter?: Pick<MemoryWriter, 'write'>;
  promptRegistry?: PromptRegistryStatePort | null;
  reflectionStore?: ReflectionMetacognitionJournalStore;
  sessionManager?: Pick<SessionManager, 'resolveSessionChannelId' | 'getRecentMessages'> & Partial<Pick<SessionManager, 'recordSystemMessage' | 'recordAssistantMessage'>>;
  emotionState?: { getState(): EmotionStateSnapshot };
  contactStore?: Pick<ContactStorePort, 'getById' | 'getEmotionalSnapshot' | 'getEmotionalTimeSeries'>
    & Partial<Pick<
      ContactStorePort,
      'listAll' | 'countVerifiedIdentityLinks' | 'getContactMaintenanceWatermark' | 'setContactMaintenanceWatermark'
    >>;
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
    formationVAD?: { valence: number; arousal: number; dominance: number };
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
  }) => Promise<boolean | void | undefined> | boolean | void | undefined;
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
  careReminderStore?: CareReminderStorePort | null;
  scheduledPromptStore?: ScheduledPromptStorePort | null;
  onBehavioralPatternOutcome?: (input: {
    channelId: string;
    canonicalContactKey?: string;
    sourceMessageId: string;
    emotionSnapshot: EmotionStateSnapshot;
    observedAtMs?: number;
  }) => Promise<void> | void;
  coreMemoryStore?: Pick<CoreMemoryStore, 'getSnapshot' | 'rethink'>;
  /** JSON-owned near-turn lane cadence (scheduler.json `nearTurnMemory`). */
  nearTurnMemoryCadence?: NearTurnMemoryCadenceConfig;
  /**
   * Canonical group-memory scope classifier (ObservedGroupMemoryScheduler)
   * so the near-turn and episode-synthesis lanes share the memoryMode/topology
   * detection used by group extraction instead of duplicating it.
   */
  memoryScopeClassifier?: NearTurnMemoryScopeClassifierPort | null;
  /** Gate + tuning config for the candidate-episode synthesis lane. */
  episodeSynthesis?: EpisodeSynthesisLaneConfig;
  /**
   * Deterministic novelty gate for cadence-fired reflection templates
   * (scheduler.json `reflectionNovelty`). Manual run_template invocations
   * bypass the gate.
   */
  reflectionNoveltyGate?: ReflectionNoveltyGateConfig;
  /**
   * Watermark store for the episode-synthesis lane's deterministic gates and
   * the reflection-template novelty watermark ("entries since last
   * reflection" per template/scope).
   */
  episodicWatermarkStore?: Pick<
    EpisodicStorePort,
    'getProcessingWatermark' | 'upsertProcessingWatermark'
  > | null;
  /** Companion aliases for deterministic relevance classification. */
  companionNames?: readonly string[];
  /** Companion author ids (e.g. Discord bot id) for mention detection. */
  companionAuthorIds?: readonly string[];
  episodicSynthesizer?: Pick<EpisodicSynthesizer, 'run'> | null;
  sleepConsolidator?: Pick<SleepCycleEpisodeConsolidator, 'run'> | null;
  arcWeaver?: Pick<EpisodeArcWeaver, 'run'> | null;
  dreamMeaningPass?: Pick<DreamMeaningPass, 'run'> | null;
  /** Sleeptime wiki update pass (E8.2): runs inside the sleeptime stack after settling. */
  sleeptimeWikiPass?: Pick<SleeptimeWikiPass, 'run'> | null;
  proactiveOutbound?: Pick<ProactiveOutboundDispatcher, 'dispatch'> | null;
  /**
   * Shared outbound-reply dedupe guard. When present, the deferred-tool-handoff
   * continuation consults it before delivering its reply and suppresses (with a
   * loud WARN) a message identical to one already delivered to the channel by
   * the primary turn — preventing the double-reply loop (psfn-framework-mdxu).
   */
  outboundReplyGuard?: OutboundReplyGuardPort | null;
  outreachOutbox?: OutreachOutboxStore | null;
  memoryMaintenanceStore?: Pick<
    MemoryStorePort,
    'upsertMemoryMaintenanceReview' | 'listActiveMemories' | 'getById' | 'getMemoryMaintenanceDiagnostics'
  > | null;
  episodicDiagnosticsStore?: Pick<EpisodicStorePort, 'getMaintenanceDiagnostics'> | null;
  episodicProcessingRestWindow?: EpisodicProcessingRestWindowConfig;
  /**
   * Slow-poisoning drift-velocity review lane (htm9.14): pre-bound evidence
   * reads, the operator review-card store, the intake-policy `driftDetection`
   * knobs, and the durable daily watermark. Absent ⇒ the lane is not wired
   * (logged, never silent).
   */
  driftVelocityReview?: {
    evidence: DriftVelocityEvidencePort;
    cardStore: DriftReviewCardStore;
    config: IntakeDriftDetectionPolicyConfig;
    watermarks: DriftVelocityWatermarkStore;
  } | null;
  /**
   * Second-arrow rumination review lane (htm9.15): pre-bound evidence reads
   * (memory embeddings, concerns, affect series), the SAME operator review-
   * card store as the drift-velocity lane, the `driftDetection.secondArrow`
   * knobs, and the durable daily watermark (own processor id). Absent ⇒ the
   * lane is not wired (logged, never silent).
   */
  secondArrowReview?: {
    evidence: SecondArrowEvidencePort;
    cardStore: DriftReviewCardStore;
    config: IntakeSecondArrowPolicyConfig;
    watermarks: DriftVelocityWatermarkStore;
  } | null;
  orientationRewriteGate?: OrientationRewriteGateConfig;
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
  /**
   * Set when a cadence-fired run was skipped by the reflection novelty gate
   * (insufficient new scope entries since the template's last reflection).
   * Manual run_template invocations never carry this flag.
   */
  noveltyGateSkipped?: boolean;
  queued?: boolean;
  queuedVia?: 'scheduler' | 'post_turn';
  deferredAction?: PostTurnActionCandidate;
}
