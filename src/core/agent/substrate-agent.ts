// ── SubstrateAgent ──
// Wraps pi-agent-core's Agent class, replacing the manual streamWithToolLoop
// from the legacy in-house loop implementation. pi-agent-core handles tool
// calling/execution/looping
// internally — we just configure it and subscribe to events for streaming.
//
// Provider interfaces (LLMProviderPort, MemoryProvider,
// MemoryExtractor) are re-exported here for callers that import contracts
// from the SubstrateAgent module.

import { Agent } from '../../boundary/pi-agent/index.js';
import type { AgentTool, StreamFn } from '../../boundary/pi-agent/index.js';
import type { UserMessage } from '@earendil-works/pi-ai';
import type { EventBus } from '../../shared/event-bus.js';
import { createEventBusCostTelemetryPort } from '../../shared/telemetry/cost-telemetry-port.js';
import {
  getRunChargeContext,
  runWithChargeContext,
  type DurableRunChargeProbe,
  type DurableRunChargeRecorder,
} from '../../shared/telemetry/run-charge.js';
import { createMemoryAppCache } from '../../shared/cache/memory-cache.js';
import type { AppCache } from '../../shared/cache/types.js';
import { RUNTIME_LAYOUT_MODE, resolveRuntimeLayoutMode } from '../../persistence/layout.js';
import type { SessionManager } from '../session/manager.js';
import { formatAttributedSystemContent } from '../session/entry-attribution.js';
import type { AgentResponse, Attachment, CorrelationMetadata, MessagePromptOverride, ResponseStyle, SubstrateMessage } from '../../shared/contracts/runtime.js';
import type { PlacesRegistryConfig } from '../../shared/contracts/places-registry.js';
import type { CapabilityTier, CoreSubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { ContactStorePort } from '../contacts/contact-store-port.js';
import { resolveIcpAutonomyCandidateSchedulerOrigin } from '../icp/candidate-scheduler-origin.js';
import type { ContactTrackingGate } from '../contacts/tracking-gate.js';
import type { ImageVisionReviewer } from '../../primitives/images/types.js';
import type { VisionIntakeImageScreenerPort } from './substrate-agent/vision-attachments.js';
import type { LLMProviderPort, MemoryProvider, MemoryExtractor, ScratchpadProvider, WikiRetrievalPort } from './contracts.js';
import {
  resolveChannelResponseStyle,
  type ChannelMeta,
} from '../../system/trust/policy.js';
import {
  type CapsuleCustodyService,
  type DisclosureLineage,
} from '../cogsec/disclosure/index.js';
import { applyAdmittedToolResultDisclosureFloor } from '../cogsec/disclosure/mcp-turn-context.js';
import type { ChannelPromptRegistryPort } from '../../channels/backplane/registry-port.js';
import type { MessageHandlerOptions } from '../../channels/backplane/types.js';
import type { PromptComposer } from '../identity/prompt-composer.js';
import {
  createSubstrateStreamFn,
  type SubstrateStreamTransport,
  type SubstrateStreamRuntimeOptions,
} from './stream-adapter.js';
import type { ProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import { PiProviderRuntime } from '../../primitives/llm/provider-runtime.js';
import { createActiveEmanationSatellitePresencePort } from './satellite-adapter-port.js';
import {
  abortActiveAgentRun,
  installAgentToolSchedulerPatch,
  type AgentRunAbortResult,
} from '../../boundary/pi-agent/agent-loop-patch.js';
import { PromptCacheTurnRuntime } from './substrate-agent/turn-execution/prompt-cache-runtime.js';
import { TurnRunReservation } from './substrate-agent/turn-run-reservation.js';
import { TurnQueueIngressCoordinator } from './substrate-agent/turn-queue-ingress.js';
import { convertToLlm } from './messages.js';
import { createEventBridge, type EventBridge } from './event-bridge.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { SkillsRuntime } from '../../faculties/skills/runtime.js';
import { ReflectionNudgeTracker } from '../../faculties/skills/reflection-nudge.js';
import type { IntrospectionTurnSensitivityDecisions } from '../../faculties/introspection/turn-sensitivity.js';
import type { ToolCategory } from './tool-registrar.js';
import {
  gateToolWithCapabilities,
  type CapabilityAccess,
  type EgressToolGuard,
} from '../../system/capabilities/gate.js';
import type { PreToolHookGate } from '../../boundary/gateway/pre-tool-hook.js';
import { assertToolCapabilityRequirementDeclared } from '../../system/capabilities/requirements.js';
import { isCanonicalFirstPartyToolName } from './tool-surface/registry.js';
import type { ToolUsageRanking } from './tool-surface/usage-ranking.js';
import {
  type IntakeSinkGate,
} from '../cogsec/intake/sink-gates.js';
import { classifyToolResultCogSecProvenance } from '../cogsec/intake/tool-result-provenance.js';
import type { IntakeEnvelopeSnapshot } from '../../shared/contracts/intake-envelope.js';
import { CapabilityRuntime } from '../../system/capabilities/runtime.js';
import type { CapabilityGrantSnapshot } from '../../system/capabilities/access.js';
import { normalizeCapabilityTier, resolveTierCapabilityTokens } from '../../system/capabilities/tiers.js';
import type { CapabilityToken } from '../../system/capabilities/tokens.js';
import { toErrorMessage } from '../../shared/utils/errors.js';
import {
  type GatewayToolMetadataCoverage,
  type ToolWiringValidationMode,
} from './tool-wiring-validator.js';
import type { AdaptiveToolRuntimeState } from './adaptive-tools-telemetry.js';
import type { RuntimeToolCatalogSnapshot } from './tool-catalog.js';
import { createTurnId } from '../turns/id.js';
import { EmotionState, type VADVector } from '../emotion/state.js';
import type { EmotionObserver } from '../emotion/observer.js';
import { EmotionAppraisal } from '../emotion/appraisal.js';
import type { SocialDesireFeltSignalWriter } from '../intention/social-desire-felt-signal.js';
import type { ActiveConcernContextProvider } from '../intention/concern-store-port.js';
import type { PendingFollowUpContextProvider } from '../intention/pending-follow-ups.js';
import type { BehavioralPatternContextProvider } from '../intention/patterns.js';
import {
  cloneMetacognitiveFlags,
  type MetacognitiveFlag,
} from '../self-model/metacognition.js';
import {
  cloneInternalState,
  type InternalState,
} from '../self-model/state.js';
import {
  type InternalStateContinuityGap,
  type InternalStateStorePort,
  type PersistedInternalStateRecord,
} from '../self-model/internal-state-persistence.js';
import {
  buildPromptPrefixCacheKey as buildPromptPrefixCacheKeyForTurn,
  buildStaticPromptSettingsHash as buildStaticPromptSettingsHashForTurn,
  captureTurnPromptSnapshot as captureTurnPromptSnapshotForTurn,
  hashPromptText as hashPromptTextForTurn,
  resolveStaticPromptPrefixFromAppCache as resolveStaticPromptPrefixForTurn,
} from './substrate-agent/prompt-lifecycle.js';
import {
  invalidateStaticPromptPrefixCache,
  logStaticPromptPrefixCacheEvent,
  resolveConfiguredCharacterName,
} from './substrate-agent/prompt-runtime-helpers.js';
import {
  countResolvableSpeakerContactsForTurn,
  resolveParticipantRelationshipsForTurn,
} from './substrate-agent/participant-relationships.js';
import {
  type IntentionPostTurnHook,
  type PostTurnActionInferer,
} from './substrate-agent/post-turn-actions.js';
import { resolveTurnSituatedFallbackPlaceId } from './substrate-agent/runtime-context-sections/turn-presence-mode.js';
import type { CompanionPresenceTurnPort } from './companion-presence-runtime.js';
import { SessionPresenceOverrideState } from './session-presence-override.js';
import {
  resolveContinuitySubjectKey,
  type CompanionSubstrateHealthContext,
} from './substrate-agent/runtime-context.js';
import { SituatedEmanationTracker } from './substrate-agent/runtime-context-sections/situated-emanation.js';
import { createVirtualRoomFollower, type VirtualRoomFollower } from './virtual-room-follow.js';
import { installContextCoherenceMonitor } from './context-coherence-monitor.js';
import { EmotionSelfModelRuntime } from './substrate-agent/emotion-self-model-runtime.js';
import { PromptContextBuilder } from './substrate-agent/prompt-context-builder.js';
import { FollowUpIngressRouter } from './substrate-agent/follow-up-ingress.js';
import { buildEgressToolGuard as buildEgressToolGuardForTurn } from './substrate-agent/egress-tool-guard.js';
import {
  handleMessageForTurn,
  type TurnDeliveryLifecycle,
} from './substrate-agent/turn-execution-runtime.js';
import type { TurnSessionIdentity } from './substrate-agent/turn-execution/contracts.js';
import type { HumanAttentionPressurePort } from './fatigue/human-attention-pressure.js';
import { createTurnExecutionRuntimeAdapter } from './substrate-agent/turn-execution-adapter.js';
import type { BackgroundWorkRuntimeTuning } from './background-work/config.js';
import {
  CompletionNoticeBuffer,
  type CompletionNoticeDeliveryDisposition,
  type CompletionNoticeDeliveryInput,
} from './completion-notices.js';
import {
  refreshModelFromConfig as refreshModelFromConfigForRuntime,
} from './substrate-agent/model-runtime.js';
import {
  buildTurnBudgetCharacteristics as buildTurnBudgetCharacteristicsForRuntime,
  resolveChannelType as resolveChannelTypeForRuntime,
  resolveTaskKind as resolveTaskKindForRuntime,
} from './substrate-agent/channel-routing-runtime.js';
import {
  deriveCharacterName as deriveCharacterNameForRuntime,
  extractResponseText as extractResponseTextForRuntime,
  getLatestAssistantMessage as getLatestAssistantMessageForRuntime,
  resolveContextWindow as resolveContextWindowForRuntime,
} from './substrate-agent/agent-state-runtime.js';
import {
  ToolRuntimeFacade,
  type PromotedToolMutationResult,
} from './substrate-agent/tool-runtime-facade.js';
import { createResponseControlTool } from './no-reply-tool.js';
import type { ApprovalQueuePort } from '../../system/capabilities/approval-queue-port.js';
import type { NotificationPort } from '../../boundary/gateway/notification-port.js';
import type { ArtifactEgressDestination } from '../artifacts/sensitivity-egress.js';
import { TurnSupportRuntime } from './substrate-agent/turn-support-runtime.js';
import {
  BackgroundWorkSupervisor,
  type BackgroundWorkAutomataLifecyclePort,
  type BackgroundWorkExecutionScope,
} from './background-work/supervisor.js';
import type {
  BackgroundWorkStorePort,
  BackgroundWorkWelfarePolicy,
} from './background-work/store-port.js';
import { executePostTurnBackgroundWork } from './background-work/post-turn-runtime.js';
import { runBackgroundWorkTick } from './background-work/tick-runtime.js';
import { BackgroundWorkHandoffRecoveryRuntime } from './background-work/handoff-recovery-runtime.js';
import type { ObserverEvalSidecarRuntime } from '../eval/observer-sidecar/types.js';
import type { FatigueBudgetPort } from './fatigue/fatigue-budget.js';
import type { IcpFatigueRegulationReservationPort } from './fatigue/regulation-reservation.js';
import type { RuntimeServiceHealthStatus } from '../../operator/tool-health/types.js';
import type { IntakeFirewallMode } from '../../system/config/intake-policy-config.js';

const log = createComponentLogger('SubstrateAgent');

export type {
  LLMProviderPort,
  MemoryProvider,
  MemoryExtractor,
  ScratchpadProvider,
} from './contracts.js';
export type {
  PostTurnActionInferer,
  IntentionPostTurnHookContext,
  IntentionPostTurnHookEffects,
  IntentionPostTurnHook,
} from './substrate-agent/post-turn-actions.js';
export type {
  PromotedToolMutationErrorCode,
  PromotedToolMutationResult,
} from './substrate-agent/tool-runtime-facade.js';

export interface EmotionRuntimeWiring {
  state?: EmotionState;
  observer?: EmotionObserver;
  appraisal?: EmotionAppraisal;
  requireWiring?: boolean;
}

export interface SelfModelRuntimeWiring {
  requireWiring?: boolean;
}

export interface SubstrateAgentOptions {
  streamFn?: StreamFn;
  streamRuntimeOptions?: Omit<SubstrateStreamRuntimeOptions, 'transport'>;
  runtime?: ProviderRuntime;
  characterName?: string;
  characterPromptVariables?: Record<string, string>;
  characterPromptVariablesProvider?: () => Record<string, string>;
  runtimeMode?: ToolWiringValidationMode;
  emotionRuntime?: EmotionRuntimeWiring;
  selfModelRuntime?: SelfModelRuntimeWiring;
  observerEvalSidecar?: ObserverEvalSidecarRuntime;
  fatigueBudget?: FatigueBudgetPort | null;
  humanAttentionPressure?: HumanAttentionPressurePort | null;
  fatigueRegulationReservations?: IcpFatigueRegulationReservationPort | null;
  streamTransport?: SubstrateStreamTransport;
  appCache?: AppCache;
  /** Contact-tracking policy gate (E3.4). Absent gate behaves as 'auto' everywhere. */
  contactTrackingGate?: ContactTrackingGate | null;
  /**
   * Places soft-registry (S10). Absent/undefined behaves as an empty registry,
   * so a runtime with no `places.json` renders byte-identically.
   */
  placesRegistryConfig?: PlacesRegistryConfig;
  backgroundWorkStore?: BackgroundWorkStorePort;
  /** Required scheduler.json-owned tuning whenever durable background work is enabled. */
  backgroundWorkTuning?: BackgroundWorkRuntimeTuning;
  /** Explicitly omit post-turn jobs for ephemeral/test agents with no durable owner. */
  backgroundWorkDisabled?: boolean;
  /**
   * Transport-only policy for a denied capability whose privileged boundary
   * performs the real grant. It never changes the advertised/granted tokens.
   */
  allowCapabilityDeniedTransport?: import('../../system/capabilities/gate.js').CapabilityDeniedTransportPolicy;
  /** Anti-starvation welfare policy (mmo9.7.4), owner-file backed (scheduler.json). */
  backgroundWorkWelfare?: Partial<BackgroundWorkWelfarePolicy>;
  /** Canonical lifecycle binding for eligible durable background automata. */
  backgroundWorkAutomataLifecycle?: BackgroundWorkAutomataLifecyclePort;
  /** Durable creation gate that must complete before any raw session append. */
  classifySessionAtCreation?: (message: SubstrateMessage) => Promise<void>;
}

function requireBackgroundWorkTuning(
  tuning: BackgroundWorkRuntimeTuning | undefined,
): BackgroundWorkRuntimeTuning {
  if (!tuning) {
    throw new Error('SubstrateAgent requires scheduler-owned durable background work tuning');
  }
  return tuning;
}

function requireBackgroundWorkWelfare(
  welfare: Partial<BackgroundWorkWelfarePolicy> | undefined,
): BackgroundWorkWelfarePolicy {
  if (welfare?.deferThreshold === undefined
    || welfare.ageThresholdMs === undefined
    || welfare.reserveSlots === undefined) {
    throw new Error('SubstrateAgent requires scheduler-owned durable background work welfare policy');
  }
  return {
    deferThreshold: welfare.deferThreshold,
    ageThresholdMs: welfare.ageThresholdMs,
    reserveSlots: welfare.reserveSlots,
  };
}

const DEFAULT_TOOL_SCHEDULER_MAX_PARALLEL = 5;

export type SubstrateAgentAbortResult = AgentRunAbortResult;

// ── SubstrateAgent ──

export class SubstrateAgent {
  private agent: Agent;
  private eventBus: EventBus;
  private llmClient: LLMProviderPort;
  private runtime: ProviderRuntime;
  private sessionManager: SessionManager;
  private systemPrompt: string;
  private characterName: string;
  private resolveCharacterPromptVariables: () => Record<string, string>;
  private config: CoreSubstrateConfig;
  private readonly classifySessionAtCreation:
    | ((message: SubstrateMessage) => Promise<void>)
    | undefined;
  private modelResolved = false;
  private modelSignature: string | null = null;
  private bridge: EventBridge;
  private channelRegistry: ChannelPromptRegistryPort = new Map();
  private capabilityRuntime: CapabilityRuntime | null = null;
  /**
   * Explicit injected capability access (mus2.1). When set, it is the single
   * authority for tool gates, prompt tool availability, and audit fields —
   * taking precedence over any disk-backed CapabilityRuntime and over the
   * tier-name default path. This is the seam a derived immutable shard access
   * uses so a `custom` grant governs the agent without an owner file.
   */
  private explicitCapabilityAccess: CapabilityAccess | null = null;
  private readonly allowCapabilityDeniedTransport:
    | import('../../system/capabilities/gate.js').CapabilityDeniedTransportPolicy
    | undefined;
  private gatedToolCache = new WeakMap<AgentTool<any>, AgentTool<any>>();
  /**
   * Synchronous pre_tool_use hook gate (bead 7ym.3). Late-bound after
   * construction (the operator hook runtime is wired later in startup); gated
   * tool wrappers read it lazily, so cached wrappers pick up a later binding.
   */
  private preToolHookGate: PreToolHookGate | null = null;
  private readonly appCache: AppCache;
  private reflectionNudge = new ReflectionNudgeTracker();
  private readonly promptCacheRuntime = new PromptCacheTurnRuntime();
  private readonly turnRunReservation = new TurnRunReservation();
  private readonly turnQueueIngress: TurnQueueIngressCoordinator;
  readonly completionNotices = new CompletionNoticeBuffer();
  private readonly turnSupportRuntime: TurnSupportRuntime;
  private readonly backgroundWorkSupervisor: BackgroundWorkSupervisor | null;
  private readonly backgroundWorkHandoffRecoveryRuntime: BackgroundWorkHandoffRecoveryRuntime;
  private readonly toolRuntimeFacade: ToolRuntimeFacade;
  private readonly satellitePresencePort = createActiveEmanationSatellitePresencePort();
  private selfModelRuntimeRequired = false;
  private readonly emotionSelfModelRuntime: EmotionSelfModelRuntime;
  private readonly fatigueBudget: FatigueBudgetPort | null;
  private readonly humanAttentionPressure: HumanAttentionPressurePort | null;
  private readonly fatigueRegulationReservations: IcpFatigueRegulationReservationPort | null;
  private readonly promptContextBuilder: PromptContextBuilder;
  private readonly followUpIngress: FollowUpIngressRouter;
  private durableChargeRecorder: DurableRunChargeRecorder | null = null;
  private durableChargeProbe: DurableRunChargeProbe | null = null;
  private currentInternalState: InternalState | null = null;
  private currentInternalStateSnapshotRef: string | null = null;
  private currentMetacognitiveFlags: MetacognitiveFlag[] = [];
  private currentAuthoritativeSystemPrompt: string | null = null;
  private internalStateStore: InternalStateStorePort | null = null;
  private internalStateContinuityGap: InternalStateContinuityGap | null = null;
  private internalStateContinuityGapRenderCount = 0;
  private companionSubstrateHealthContext: CompanionSubstrateHealthContext | null = null;
  private runtimeMode: ToolWiringValidationMode;

  private get activeTurnCorrelation(): CorrelationMetadata | null {
    return this.turnSupportRuntime.getActiveTurnCorrelation();
  }

  private set activeTurnCorrelation(correlation: CorrelationMetadata | null) {
    this.turnSupportRuntime.setActiveTurnCorrelation(correlation);
  }

  private get activeTurnTaskKind(): string | null {
    return this.turnSupportRuntime.getActiveTurnTaskKind();
  }

  private set activeTurnTaskKind(taskKind: string | null) {
    this.turnSupportRuntime.setActiveTurnTaskKind(taskKind);
  }

  private get activeTurnIntent(): string | null {
    return this.turnSupportRuntime.getActiveTurnIntent();
  }

  private set activeTurnIntent(intent: string | null) {
    this.turnSupportRuntime.setActiveTurnIntent(intent);
  }

  // Pluggable memory — null until memory system is wired
  memoryProvider: MemoryProvider | null = null;
  artifactApprovalQueue: ApprovalQueuePort | null = null;
  // Durable Share Capsule custody riding the same approval queue (jp36.7.1.2).
  // Consumers (Garden approvals surface jp36.7.2, companion publication tool
  // jp36.7.3) authorize exact-replay + revoke through this handle; null until wired.
  shareCapsuleCustody: CapsuleCustodyService | null = null;
  artifactApprovalNotifier: NotificationPort | null = null;
  shareApprovedArtifacts: ((
    attachments: readonly Attachment[],
    destination: ArtifactEgressDestination,
  ) => Promise<void>) | null = null;
  memoryExtractor: MemoryExtractor | null = null;
  // E8.3: supplemental wiki RAG — null until the pgvector projection is wired.
  wikiRetrieval: WikiRetrievalPort | null = null;
  scratchpadProvider: ScratchpadProvider | null = null;
  /**
   * Social-desire felt-signal writer (psfn-framework-hrmrq.85), assigned by
   * composition when the social-desire lane is enabled. The post-turn
   * emotion_appraisal background job records each turn's deterministic felt
   * social signal through it; null keeps accumulation inert (lane disabled).
   */
  socialDesireFeltSignals: SocialDesireFeltSignalWriter | null = null;
  /**
   * Intake sink gate (htm9.3), assigned by composition alongside the session
   * manager's. Drives the tool-egress sink: per-invocation lethal-trifecta
   * checks over the current turn's intake envelopes. Null = firewall off.
   */
  intakeSinkGate: IntakeSinkGate | null = null;
  /**
   * Intake envelopes riding the CURRENT turn's message routing metadata
   * (htm9.3). Set for the duration of handleMessage (same lifetime pattern as
   * currentInternalState) so the egress guard sees the turn's intake context
   * at tool-invocation time; empty outside a turn.
   */
  private currentTurnIntakeEnvelopes: readonly IntakeEnvelopeSnapshot[] = [];
  /**
   * Per-turn outbound disclosure lineage (bible §9.2), set once the generation
   * context is folded and cleared at turn end. The egress tool guard composes
   * `assessDisclosure` over this against a derived social destination (jp36.1.3).
   * Undefined until built — an outward social send with no lineage fails closed.
   */
  private currentTurnDisclosureLineage: DisclosureLineage | undefined;
  /**
   * mmo9.6.1: transport-agnostic cancellation identity of the CURRENT active
   * turn (from `message.routing.cancellationId` or the dispatch options).
   * CLAIMED by a turn only when it carries an id AND the slot is unregistered,
   * and cleared in the finally only by the turn that claimed it, so concurrent
   * ordinary turns (granted as overlapping shared readers by the turn-run
   * reservation) cannot overwrite or null it. {@link cancelTurn} can abort IFF
   * the caller names the turn that is actually running. A stale/mismatched id is
   * a no-op — it must never abort a newer turn (critical for rapid voice segment
   * turns, mmo9.8).
   */
  private activeTurnCancellationId: string | null = null;
  activeConcernProvider: ActiveConcernContextProvider | null = null;
  pendingFollowUpProvider: PendingFollowUpContextProvider | null = null;
  behavioralPatternProvider: BehavioralPatternContextProvider | null = null;

  // Trust resolution — null until contacts are wired
  contactStore: ContactStorePort | null = null;

  // Contact-tracking policy gate (E3.4) — null behaves as 'auto' everywhere
  private readonly contactTrackingGate: ContactTrackingGate | null;

  // Cross-companion presence (sprint 10, W5a) — null (single-companion /
  // flag-off) leaves every turn byte-identical: no writes, no co-presence.
  // Wired from the agent entrypoint after persistence bootstrap, like
  // memoryProvider/contactStore above.
  companionPresence: CompanionPresenceTurnPort | null = null;

  // Places soft-registry (S10) — undefined behaves as an empty registry
  private readonly placesRegistryConfig: PlacesRegistryConfig | undefined;
  /** Validated per-logical-session narrative location assertions (vinz.29). */
  private readonly sessionPresenceOverrideState: SessionPresenceOverrideState;

  // Handoff-aware active-emanation tracker (S10 B2) — remembers the companion's
  // current physical room and any deliberate virtual move. Plain-chat turns
  // consume its physical room only through the authored twin mapping.
  private readonly situatedEmanationTracker = new SituatedEmanationTracker();

  // Virtual-activity presence follow (vinz.21): pulls the companion's virtual
  // presence to a place-bound companion-room when the trusted partner is
  // active there. Constructed in the constructor (needs sessionManager /
  // registry); invoked from the pre-turn path after author/trust resolution.
  private readonly virtualRoomFollower: VirtualRoomFollower;

  /**
   * Deliberate virtual navigation (vinz.26): the world tool's `move` action
   * applies its LOCAL situated effect through this seam. The virtual overlay
   * never touches the physical emanation; a later place-bearing turn
   * supersedes it (see SituatedEmanationTracker.moveToVirtualPlace).
   */
  applyDeliberateVirtualMove(placeId: string): void {
    this.situatedEmanationTracker.moveToVirtualPlace(placeId);
  }

  /**
   * Set or clear a partner-asserted physical location for the logical session
   * owning `channelId`. This is the deterministic intake seam; free-text
   * extraction is intentionally not performed in the turn path.
   */
  setSessionPresenceOverride(channelId: string, physicalPlaceId: string | null): void {
    const logicalSessionId = this.sessionManager.resolveSessionChannelId(channelId);
    this.sessionPresenceOverrideState.set(logicalSessionId, physicalPlaceId);
  }

  /**
   * The companion's current situated place, as the situated block foregrounds
   * it on a placeless turn (deliberate virtual move, else active emanation).
   * Serves the world tool's deictic defaults (perceive/list without placeId).
   */
  resolveCurrentSituatedPlaceId(): string | undefined {
    return this.situatedEmanationTracker.resolvePlaceId();
  }

  /**
   * Dual-presence situated fallback for a turn (vinz.29, decisions 9-13): the
   * place foregrounded when the turn carries no place binding of its own.
   * Physical-origin turns keep the legacy chain (deliberate virtual move →
   * active emanation); mindspace turns (plain chat) use a session assertion's
   * twin, then the durable last-known physical room's twin, still outranked by
   * a deliberate virtual move. Single seam for the situated block, co-presence read, wiki
   * shared-world scope, and the mindspace presence write — they must all agree
   * on where the companion is.
   */
  resolveSituatedFallbackPlaceIdForTurn(message: SubstrateMessage): string | undefined {
    const logicalSessionId = this.sessionManager.resolveSessionChannelId(message.channelId);
    const virtualMovePlaceId = this.situatedEmanationTracker.resolveVirtualMovePlaceId();
    const sessionOverridePhysicalPlaceId = this.sessionPresenceOverrideState
      .resolvePhysicalPlaceId(logicalSessionId);
    const emanationPlaceId = this.situatedEmanationTracker.snapshot()?.placeId;
    return resolveTurnSituatedFallbackPlaceId({
      message,
      ...(this.placesRegistryConfig ? { placesRegistry: this.placesRegistryConfig } : {}),
      ...(virtualMovePlaceId ? { virtualMovePlaceId } : {}),
      ...(sessionOverridePhysicalPlaceId ? { sessionOverridePhysicalPlaceId } : {}),
      ...(emanationPlaceId ? { emanationPlaceId } : {}),
      durableLocation: this.emotionSelfModelRuntime.getCurrentSituatedLocation(),
    });
  }

  // Prompt composition — null falls back to static systemPrompt
  promptComposer: PromptComposer | null = null;

  // SKILL.md runtime — null until skills system is wired
  skillsRuntime: SkillsRuntime | null = null;
  imageVisionReviewer: ImageVisionReviewer | null = null;
  /** htm9.8 vision intake screener (gateway-backed); null when not wired. */
  visionIntakeScreener: VisionIntakeImageScreenerPort | null = null;
  /** Canonical global CogSec mode; defaults to shadow until composition arms it. */
  cogSecMode: IntakeFirewallMode = 'shadow';
  observerEvalSidecar: ObserverEvalSidecarRuntime | null = null;

  constructor(
    eventBus: EventBus,
    llmClient: LLMProviderPort,
    sessionManager: SessionManager,
    systemPrompt: string,
    config: CoreSubstrateConfig,
    options?: SubstrateAgentOptions,
  ) {
    const backgroundWorkStore = options?.backgroundWorkStore;
    if (!backgroundWorkStore && options?.backgroundWorkDisabled !== true) {
      throw new Error('SubstrateAgent requires a durable background work store');
    }
    const backgroundWorkTuning = backgroundWorkStore
      ? requireBackgroundWorkTuning(options.backgroundWorkTuning)
      : null;
    const backgroundWorkWelfare = backgroundWorkStore
      ? requireBackgroundWorkWelfare(options.backgroundWorkWelfare)
      : null;
    this.eventBus = eventBus;
    this.llmClient = llmClient;
    this.runtime = options.runtime ?? new PiProviderRuntime();
    this.sessionManager = sessionManager;
    this.systemPrompt = systemPrompt;
    this.characterName = options.characterName?.trim()
      || resolveConfiguredCharacterName(config)
      || deriveCharacterNameForRuntime(systemPrompt);
    const fallbackPromptVariables = { ...(options.characterPromptVariables ?? {}) };
    this.resolveCharacterPromptVariables = options.characterPromptVariablesProvider
      ?? (() => fallbackPromptVariables);
    this.config = config;
    this.classifySessionAtCreation = options?.classifySessionAtCreation;
    this.runtimeMode = options.runtimeMode ?? 'gateway';
    this.allowCapabilityDeniedTransport = options.allowCapabilityDeniedTransport;
    this.appCache = options.appCache ?? createMemoryAppCache({ name: 'substrate-agent-prompt-cache' });
    this.selfModelRuntimeRequired = options.selfModelRuntime?.requireWiring ?? false;
    this.observerEvalSidecar = options.observerEvalSidecar ?? null;
    this.fatigueBudget = options.fatigueBudget ?? null;
    this.humanAttentionPressure = options.humanAttentionPressure ?? null;
    this.fatigueRegulationReservations = options.fatigueRegulationReservations ?? null;
    this.contactTrackingGate = options.contactTrackingGate ?? null;
    this.placesRegistryConfig = options.placesRegistryConfig;
    this.sessionPresenceOverrideState = new SessionPresenceOverrideState(this.placesRegistryConfig);
    this.virtualRoomFollower = createVirtualRoomFollower({
      ...(this.placesRegistryConfig ? { placesRegistry: this.placesRegistryConfig } : {}),
      getCompanionPresence: () => this.companionPresence,
      applyVirtualMove: (placeId) => this.applyDeliberateVirtualMove(placeId),
      resolveSituatedFallbackPlaceId: (message) => this.resolveSituatedFallbackPlaceIdForTurn(message),
      roomEntryNoteSink: this.sessionManager,
      eventBus: this.eventBus,
    });
    this.emotionSelfModelRuntime = new EmotionSelfModelRuntime({
      sessionManager: this.sessionManager,
      llmProvider: this.llmClient,
      ...(this.config.companionId ? { companionId: this.config.companionId } : {}),
      emotionRuntime: options.emotionRuntime,
      ...(config.emotionScoping ? { emotionScopingConfig: config.emotionScoping } : {}),
      ...(config.narrativeEmotionAppraisal
        ? { narrativeEmotionAppraisalConfig: config.narrativeEmotionAppraisal }
        : {}),
      getActiveConcernProvider: () => this.activeConcernProvider,
      getPendingFollowUpProvider: () => this.pendingFollowUpProvider,
      getContactStore: () => this.contactStore,
      getSelfModelRuntimeRequired: () => this.selfModelRuntimeRequired,
      getPlacesRegistry: () => this.placesRegistryConfig,
      logger: log,
      onEmotionAppraisalGateEvent: (event) => {
        this.eventBus.emit('emotion.appraisal.gate', event).catch((error) => {
          log.warn('Failed to emit emotion appraisal gate telemetry', {
            error: toErrorMessage(error),
          });
        });
      },
      // 7ang.1: forward a vad-shift emotion snapshot onto the companion relay
      // source bus. Fire-and-forget; a relay failure never blocks appraisal.
      onEmotionSnapshot: (snapshot) => {
        this.eventBus.emit('agent.emotion.snapshot', {
          trigger: snapshot.trigger,
          vad: snapshot.vad,
          mood: snapshot.mood,
          discrete: snapshot.discrete,
          confidence: snapshot.confidence,
          channelId: snapshot.channelId,
          timestamp: Date.now(),
        }).catch((error) => {
          log.warn('Failed to emit companion emotion snapshot', {
            error: toErrorMessage(error),
          });
        });
      },
    });
    this.emotionSelfModelRuntime.assertEmotionRuntimeConfigured();

    if (backgroundWorkStore && backgroundWorkTuning && backgroundWorkWelfare) {
      this.backgroundWorkSupervisor = new BackgroundWorkSupervisor({
        ...backgroundWorkTuning.supervisor,
        store: backgroundWorkStore,
        eventBus: this.eventBus,
        welfare: backgroundWorkWelfare,
        ...(options.backgroundWorkAutomataLifecycle
          ? { automataLifecycle: options.backgroundWorkAutomataLifecycle }
          : {}),
        onTerminalFailure: ({ jobId, payload, reasonCode }) => {
          if (payload.kind !== 'emotion_appraisal') return;
          const released = this.emotionSelfModelRuntime.releaseNarrativeEmotionAppraisal({
            sessionChannelId: payload.emotionSessionId,
            driftDecision: payload.driftDecision,
          });
          log.debug('Terminal emotion appraisal reservation resolved', {
            jobId,
            reasonCode,
            released,
          });
        },
        executor: (input) => executePostTurnBackgroundWork(input, {
          sessionManager: this.sessionManager,
          llmProvider: this.llmClient,
          getMemoryExtractor: () => this.memoryExtractor,
          runIntentionPostTurnHooks: (context, runOptions) => this.turnSupportRuntime
            .runIntentionPostTurnHooks(context, runOptions),
          emotionRuntime: this.emotionSelfModelRuntime,
          getEmotionTemplateVariables: () => this.resolveCharacterPromptVariables(),
          tuning: backgroundWorkTuning.postTurn,
          // Read at execution time (not construction) because composition
          // assigns the writer after the agent is built (hrmrq.85).
          ...(this.socialDesireFeltSignals
            ? { socialDesireFeltSignals: this.socialDesireFeltSignals }
            : {}),
        }),
      });
    } else {
      this.backgroundWorkSupervisor = null;
    }
    this.backgroundWorkHandoffRecoveryRuntime = new BackgroundWorkHandoffRecoveryRuntime(
      this.sessionManager,
    );

    const defaultStreamTransport = options.streamTransport ?? {
      stream: this.llmClient.stream.bind(this.llmClient),
    };
    const configuredProviderFirstOutput = options.streamRuntimeOptions?.onProviderFirstOutput;
    const configuredProviderPayloadCaptured = options.streamRuntimeOptions?.onProviderPayloadCaptured;

    this.agent = new Agent({
      streamFn: options.streamFn ?? createSubstrateStreamFn(config, {
        ...(options.streamRuntimeOptions ?? {}),
        onProviderFirstOutput: async (event) => {
          await this.eventBus.emit('agent.provider.first_output', event);
          await configuredProviderFirstOutput?.(event);
        },
        onProviderPayloadCaptured: async (event) => {
          await this.eventBus.emit('agent.provider.payload_captured', event);
          await configuredProviderPayloadCaptured?.(event);
        },
        transport: defaultStreamTransport,
      }),
      convertToLlm,
    });
    this.turnQueueIngress = new TurnQueueIngressCoordinator({
      agent: this.agent,
      resolveOwner: () => this.turnRunReservation.getCurrentOwnerAttribution(),
      runFreshOrdinary: async (message) => {
        await this.handleMessageUnderReservation(message);
      },
    });
    this.agent.subscribe((event) => this.turnQueueIngress.observeAgentEvent(event));
    this.turnSupportRuntime = new TurnSupportRuntime({
      eventBus: this.eventBus,
      sessionManager: this.sessionManager,
      backgroundWorkSupervisor: this.backgroundWorkSupervisor,
      ...(backgroundWorkTuning
        ? { backgroundWorkMaxAttempts: backgroundWorkTuning.postTurn.maxAttempts }
        : {}),
      backgroundWorkDisabled: options.backgroundWorkDisabled === true,
      hashPromptText: hashPromptTextForTurn,
      resolveContextWindow: () => resolveContextWindowForRuntime(
        this.config,
        this.agent.state.model as { contextWindow?: unknown } | undefined,
      ),
      companionId: this.config.companionId,
    });
    installContextCoherenceMonitor({
      eventBus: this.eventBus,
      getRecentSessionEntries: (channelId, limit) => this.sessionManager.getRecentSessionEntries(channelId, limit),
    });
    this.toolRuntimeFacade = new ToolRuntimeFacade({
      config: this.config,
      agent: this.agent,
      resolveCapabilityAccess: () => this.resolveCapabilityAccess(),
      withCapabilityGates: (tools) => this.withCapabilityGates(tools),
      withAdaptiveCorrelation: (correlation, purpose) => this.turnSupportRuntime.withAdaptiveCorrelation(correlation, purpose),
      emitAdaptiveToolDecision: (payload) => this.turnSupportRuntime.emitAdaptiveToolDecision(payload),
      emitTelemetry: (event, payload) => this.turnSupportRuntime.emitTelemetry(event, payload),
      getActiveTurnCorrelation: () => this.turnSupportRuntime.getActiveTurnCorrelation(),
      getActiveTurnTaskKind: () => this.turnSupportRuntime.getActiveTurnTaskKind(),
    });
    installAgentToolSchedulerPatch(this.agent, {
      maxParallelToolCalls: DEFAULT_TOOL_SCHEDULER_MAX_PARALLEL,
      // hrmrq.54: screen tool results at the scheduler seam, BEFORE they
      // enter the turn — the persistence-time screen alone let quarantined
      // content (e.g. an fs.read of a withheld document) reach the model
      // loop unscreened. Resolved lazily: composition assigns
      // sessionManager.intakeScreening after construction; a null service
      // means the firewall is off for this runtime.
      toolResultScreener: ({ toolName, toolCallId, arguments: toolArguments, text }) => {
        const screening = this.sessionManager.intakeScreening;
        if (!screening) return null;
        const sourceChannelId = this.turnSupportRuntime.getActiveTurnCorrelation()?.channelId?.trim();
        const toolCallSuffix = toolCallId.trim() ? `:${toolCallId.trim()}` : '';
        const screened = screening.screenSync(text, {
          sourceClass: 'tool_output',
          toolResultProvenance: { toolName, arguments: toolArguments },
          // Structural clean-bubble provenance: derived from the tool NAME only
          // (unforgeable by content/model args), so boundary-mode internal
          // tool results make zero semantic-screening calls.
          structuralProvenance: classifyToolResultCogSecProvenance(toolName),
          origin: {
            ref: `tool:${toolName.trim()}${toolCallSuffix}`.slice(0, 2048),
            detail: 'seam:tool-scheduler',
          },
          scope: 'context',
          ...(sourceChannelId ? { sourceChannelId } : {}),
        });
        return {
          mode: screened.mode,
          withheld: screened.withheld,
          effectiveText: screened.effectiveText,
          snapshot: screened.snapshot,
          ...(screened.markingPlan ? { markingPlan: screened.markingPlan } : {}),
        };
      },
      onToolResultAdmitted: (input) => {
        // Discovery/release metadata preserves the admitted context's
        // sensitivity; remote call results and other tool outputs retain the
        // disclosure generation's confidential result floor.
        this.currentTurnDisclosureLineage = applyAdmittedToolResultDisclosureFloor(
          this.currentTurnDisclosureLineage,
          input,
        );
      },
      onTelemetry: (eventName, payload) => {
        this.turnSupportRuntime.emitTelemetry(eventName, {
          ...this.turnSupportRuntime.withAdaptiveCorrelation(
            this.turnSupportRuntime.getActiveTurnCorrelation() ?? undefined,
            eventName,
          ),
          timestamp: Date.now(),
          taskKind: this.turnSupportRuntime.getActiveTurnTaskKind(),
          intent: this.turnSupportRuntime.getActiveTurnIntent(),
          ...payload,
        });
      },
    }, {
      resolvePromptCacheBoundaries: (systemPrompt) => this.promptCacheRuntime.resolveBoundariesFor(systemPrompt),
      resolveTurnTools: () => this.toolRuntimeFacade.resolveOwnedTurnTools(),
    });

    this.installRuntimeHooks();

    // Persistent event bridge: pi-agent-core events → EventBus
    this.bridge = createEventBridge(this.agent, eventBus);

    // Register the core response/discovery and non-default tool control tools.
    this.registerTool(createResponseControlTool((input) => (
      this.turnSupportRuntime.recordIntentionalNoReplyDecision(input)
    )), 'core');
    this.registerTool(this.toolRuntimeFacade.createToolSearchTool(), 'core');
    this.registerTool(this.toolRuntimeFacade.createToolsetTool(), 'core');

    // Eagerly resolve the model. Continuous/test runtimes may defer a failed
    // resolution until the first turn, while production startup fails closed.
    try {
      this.refreshModelFromConfig('startup', undefined, 'propagate');
    } catch (error) {
      log.warn('Model resolution failed at startup', { error: toErrorMessage(error) });
      const layoutMode = resolveRuntimeLayoutMode({
        mode: process.env.PSFN_RUNTIME_LAYOUT_MODE,
        nodeEnv: process.env.NODE_ENV,
      });
      if (layoutMode === RUNTIME_LAYOUT_MODE.PRODUCTION) {
        throw error;
      }
    }

    // Per-turn prompt/context input assembly (charter 12.1 split, emh3p.2).
    this.promptContextBuilder = new PromptContextBuilder({
      config: this.config,
      resolveCharacterPromptVariables: this.resolveCharacterPromptVariables,
      getAgentModelId: () => this.agent.state.model.id,
      getAgentModelContextWindow: () => this.agent.state.model as { contextWindow?: unknown } | undefined,
      getAgentUserFacingBoundaryIndex: () => (this.agent.state as { userFacingBoundaryIndex?: unknown }).userFacingBoundaryIndex,
      getCharacterName: () => this.characterName,
      setCharacterName: (name) => {
        this.characterName = name;
      },
      toolRuntimeFacade: this.toolRuntimeFacade,
      getInternalStateContinuityGap: () => this.internalStateContinuityGap,
      noteInternalStateContinuityGapRendered: () => {
        this.internalStateContinuityGapRenderCount += 1;
      },
      getSkillsRuntime: () => this.skillsRuntime,
      getCompanionPresence: () => this.companionPresence,
      placesRegistryConfig: this.placesRegistryConfig,
      getChannelRegistry: () => this.channelRegistry,
      emotionSelfModelRuntime: this.emotionSelfModelRuntime,
      getCompanionSubstrateHealthContext: () => this.companionSubstrateHealthContext,
      situatedEmanationTracker: this.situatedEmanationTracker,
      resolveSituatedFallbackPlaceIdForTurn: (message) => this.resolveSituatedFallbackPlaceIdForTurn(message),
      getActiveConcernProvider: () => this.activeConcernProvider,
      getBehavioralPatternProvider: () => this.behavioralPatternProvider,
      getScratchpadProvider: () => this.scratchpadProvider,
      getContactStore: () => this.contactStore,
      contactTrackingGate: this.contactTrackingGate,
      snapshotCapabilityGrant: () => this.snapshotCapabilityGrant(),
      log,
    });
    // Queued follow-up ingress + completion-notice routing (emh3p.2).
    this.followUpIngress = new FollowUpIngressRouter({
      agent: this.agent,
      turnRunReservation: this.turnRunReservation,
      turnQueueIngress: this.turnQueueIngress,
      turnSupportRuntime: this.turnSupportRuntime,
      completionNotices: this.completionNotices,
      requireActiveTurnSessionIdentity: () => this.requireActiveTurnSessionIdentity(),
      resolveAuthorContext: (message) => this.promptContextBuilder.resolveAuthorContext(message),
    });
  }

  /** Ensure the model is resolved before calling agent.prompt() */
  private ensureModel(message?: SubstrateMessage): void {
    this.refreshModelFromConfig('turn-start', message);
  }

  /**
   * Re-resolve the chat model from current config.
   * Safe for runtime updates: if a new model cannot be resolved, keep the last working model.
   */
  refreshRuntimeModels(): void {
    this.refreshModelFromConfig('settings-update');
  }

  private installRuntimeHooks(): void {
    const existingHooks = this.config.runtimeHooks ?? {};
    const priorRefreshModels = existingHooks.refreshModels;
    const priorRefreshCapabilities = existingHooks.refreshCapabilities;
    const priorInvalidatePromptPrefixCache = existingHooks.invalidatePromptPrefixCache;
    this.config.runtimeHooks = {
      ...existingHooks,
      refreshModels: () => {
        priorRefreshModels?.();
        this.refreshRuntimeModels();
        invalidateStaticPromptPrefixCache(this.appCache, 'runtime.refreshModels', log);
      },
      refreshCapabilities: () => {
        priorRefreshCapabilities?.();
        this.refreshCapabilityRuntime();
        invalidateStaticPromptPrefixCache(this.appCache, 'runtime.refreshCapabilities', log);
      },
      invalidatePromptPrefixCache: (reason = 'runtime.invalidatePromptPrefixCache') => {
        priorInvalidatePromptPrefixCache?.(reason);
        invalidateStaticPromptPrefixCache(this.appCache, reason, log);
      },
    };
  }

  private refreshCapabilityRuntime(): void {
    if (this.explicitCapabilityAccess) {
      // Explicit access is an immutable launch artifact: it never re-reads
      // disk, and owner-file churn must not widen or narrow it (mus2.1).
      this.config.capabilityTier = this.explicitCapabilityAccess.getTier();
      return;
    }

    if (this.capabilityRuntime) {
      const refreshed = this.capabilityRuntime.refreshFromDisk();
      this.config.capabilityTier = refreshed.tier;
      return;
    }

    this.config.capabilityTier = this.resolveCapabilityTier();
  }

  private resolveCapabilityTier(): CapabilityTier {
    return normalizeCapabilityTier(this.config.capabilityTier);
  }

  private resolveCapabilityAccess(): CapabilityAccess {
    if (this.explicitCapabilityAccess) return this.explicitCapabilityAccess;
    if (this.capabilityRuntime) return this.capabilityRuntime;

    const tier = this.resolveCapabilityTier();
    const grantedTokens = new Set(resolveTierCapabilityTokens(tier));
    return {
      getTier: () => tier,
      getGrantedTokens: () => grantedTokens,
      has: (token: CapabilityToken) => grantedTokens.has(token),
    };
  }

  /**
   * Capture the tier and effective grant once for prompt assembly. The mutable
   * disk-backed runtime uses its authoritative atomic snapshot; the other
   * access variants are immutable for their lifetime, so copying their one
   * resolved grant preserves the same prompt/tool-gate semantics.
   */
  private snapshotCapabilityGrant(): Pick<CapabilityGrantSnapshot, 'tier' | 'grantedTokens'> {
    if (!this.explicitCapabilityAccess && this.capabilityRuntime) {
      return this.capabilityRuntime.snapshotOwnerGrant();
    }

    const access = this.resolveCapabilityAccess();
    return Object.freeze({
      tier: access.getTier(),
      grantedTokens: Object.freeze([...access.getGrantedTokens()]),
    });
  }

  /**
   * Late-bind the synchronous pre_tool_use hook gate (bead 7ym.3). Called
   * during startup once the operator hook runtime exists. Gated tools consult
   * this lazily, so previously cached wrappers observe the binding too.
   */
  setPreToolHookGate(gate: PreToolHookGate | null): void {
    this.preToolHookGate = gate;
  }

  private withCapabilityGates(tools: AgentTool<any>[]): AgentTool<any>[] {
    return tools.map((tool) => {
      const cached = this.gatedToolCache.get(tool);
      if (cached) return cached;
      // Fail closed at registration for audited first-party tools that forgot to
      // declare a capability requirement (02-M2). Third-party/plugin tools are
      // still refused, but at gate-evaluation time so one bad plugin cannot take
      // down the whole runtime at startup.
      if (isCanonicalFirstPartyToolName(tool.name)) {
        assertToolCapabilityRequirementDeclared(tool);
      }
      const wrapped = gateToolWithCapabilities(
        tool,
        () => this.resolveCapabilityAccess(),
        () => this.buildEgressToolGuard(),
        this.allowCapabilityDeniedTransport,
        () => this.preToolHookGate,
      );
      this.gatedToolCache.set(tool, wrapped);
      return wrapped;
    });
  }

  /**
   * Tool-egress sink guard (htm9.3). Applies only to egress-capable
   * invocations (INTAKE_EGRESS_CAPABILITY_TOKENS). Two checks, both audited
   * by the gate: the tool_egress sink-access gate over the turn's intake
   * envelopes (deny labels like exfil/canary_leak; explicit unscreened
   * default when the turn carries none), then the lethal-trifecta invariant.
   * `privateDataInPath` is structurally true for companion turns: core
   * memory, persona, and session history are always assembled into the
   * prompt, so any enveloped external content plus egress completes the
   * trifecta. Hard tiers deny; soft tiers pass with a review-flagged audit.
   */
  private buildEgressToolGuard(): EgressToolGuard | null {
    return buildEgressToolGuardForTurn({
      intakeSinkGate: this.intakeSinkGate,
      getActiveTurnIntakeEnvelopes: () => this.getActiveTurnIntakeEnvelopes(),
      getCurrentTurnDisclosureLineage: () => this.currentTurnDisclosureLineage,
      getActiveTurnSessionIdentity: () => this.turnSupportRuntime.getActiveTurnSessionIdentity(),
    });
  }

  private normalizeTurnPromptOverride(message: SubstrateMessage): MessagePromptOverride {
    const raw = message.routing?.promptOverride;
    if (!raw) {
      return { mode: 'default' };
    }

    if (raw.mode === 'none') return { mode: 'none' };
    if (raw.mode === 'custom') {
      const prompt = raw.systemPrompt?.trim();
      if (prompt) return { mode: 'custom', systemPrompt: prompt };
      return { mode: 'none' };
    }
    return { mode: 'default' };
  }

  private normalizeTurnResponseStyleOverride(message: SubstrateMessage): ResponseStyle | null {
    const raw = message.routing?.responseStyle;
    return raw === 'concise' || raw === 'expressive'
      ? raw
      : null;
  }

  private resolveResponseStyle(
    message: SubstrateMessage,
    channelType: string | undefined,
    channelMeta: ChannelMeta,
  ): ResponseStyle {
    const turnOverride = this.normalizeTurnResponseStyleOverride(message);
    if (turnOverride) return turnOverride;

    return resolveChannelResponseStyle(message.channelId, {
      channelType,
      meta: channelMeta,
      overrides: this.config.responseStyleOverrides,
    });
  }

  private refreshModelFromConfig(
    reason: 'startup' | 'turn-start' | 'settings-update',
    message?: SubstrateMessage,
    resolutionFailurePolicy: 'retain-current' | 'propagate' = 'retain-current',
  ): void {
    const nextState = refreshModelFromConfigForRuntime({
      reason,
      config: this.config,
      runtime: this.runtime,
      state: {
        modelResolved: this.modelResolved,
        modelSignature: this.modelSignature,
      },
      message,
      resolutionFailurePolicy,
      setAgentModel: model => { this.agent.state.model = model; },
      getCurrentModelId: () => this.agent.state.model.id,
      logger: log,
    });
    this.modelResolved = nextState.modelResolved;
    this.modelSignature = nextState.modelSignature;
  }

  registerTool(tool: AgentTool<any>, category: ToolCategory = 'core'): void {
    this.toolRuntimeFacade.registerTool(tool, category);
  }

  /**
   * Live per-turn outbound disclosure lineage (bible §9.2), or undefined outside
   * a folded turn. Read-only accessor so runtime-authority consumers (the
   * jp36.7.3 companion publication tool) can derive a share candidate's
   * effective sensitivity, provenance, and subject contacts from the runtime's
   * folded lineage at tool-invocation time — the model never self-asserts that
   * disclosure metadata. Undefined ⇒ fail closed (no attestable provenance).
   */
  getCurrentTurnDisclosureLineage(): DisclosureLineage | undefined {
    return this.currentTurnDisclosureLineage;
  }

  getPromotedExtendedToolsLimit(): number {
    return this.toolRuntimeFacade.getPromotedExtendedToolsLimit();
  }

  getPromotedExtendedTools(): readonly string[] {
    return this.toolRuntimeFacade.getPromotedExtendedTools();
  }

  addPromotedExtendedTool(toolName: string): Promise<PromotedToolMutationResult> {
    return this.toolRuntimeFacade.addPromotedExtendedTool(toolName);
  }

  removePromotedExtendedTool(toolName: string): Promise<PromotedToolMutationResult> {
    return this.toolRuntimeFacade.removePromotedExtendedTool(toolName);
  }

  swapPromotedExtendedTools(fromSlot: number, toSlot: number): Promise<PromotedToolMutationResult> {
    return this.toolRuntimeFacade.swapPromotedExtendedTools(fromSlot, toSlot);
  }

  getToolCatalog(): { core: readonly AgentTool<any>[]; extended: readonly AgentTool<any>[] } {
    return this.toolRuntimeFacade.getToolCatalog();
  }

  /**
   * Refresh the durable-usage presentation-ordering signal (psfn-framework-b0yl.5).
   * Fed by the periodic tool-usage evaluator; presentation-only, never gates callability.
   */
  setToolUsageRanking(ranking: ToolUsageRanking | null): void {
    this.toolRuntimeFacade.setToolUsageRanking(ranking);
  }

  getAdaptiveToolRuntimeState(): AdaptiveToolRuntimeState {
    return this.toolRuntimeFacade.getAdaptiveToolRuntimeState();
  }

  getActiveTurnTools(): readonly AgentTool<any>[] {
    return this.toolRuntimeFacade.getActiveTurnTools();
  }

  /**
   * Intake envelopes for the exact async-local tool turn. Empty outside a
   * turn; safe when ordinary turns overlap.
   */
  getActiveTurnIntakeEnvelopes(): readonly IntakeEnvelopeSnapshot[] {
    return this.toolRuntimeFacade.getActiveTurnIntakeEnvelopes();
  }

  getToolCatalogSnapshot(): RuntimeToolCatalogSnapshot {
    return this.toolRuntimeFacade.getToolCatalogSnapshot();
  }

  getToolHealthStatusByName(): ReadonlyMap<string, RuntimeServiceHealthStatus> {
    return this.toolRuntimeFacade.getToolHealthStatusByName();
  }

  setCompanionSubstrateHealthContext(context: CompanionSubstrateHealthContext | null): void {
    this.companionSubstrateHealthContext = context;
  }

  validateToolWiring(
    mode: ToolWiringValidationMode,
    gatewayClient?: object,
    requiredGatewayMetadataCoverage?: GatewayToolMetadataCoverage,
  ): void {
    this.toolRuntimeFacade.validateToolWiring(mode, gatewayClient, requiredGatewayMetadataCoverage);
  }

  setChannelRegistry(registry: ChannelPromptRegistryPort): void {
    this.channelRegistry = registry;
    invalidateStaticPromptPrefixCache(this.appCache, 'channel-registry-updated', log);
  }

  setCapabilityRuntime(runtime: CapabilityRuntime | null): void {
    this.capabilityRuntime = runtime;
    this.gatedToolCache = new WeakMap<AgentTool<any>, AgentTool<any>>();
    this.refreshCapabilityRuntime();
  }

  /**
   * Inject an explicit capability access (mus2.1), e.g. an immutable derived
   * shard access from `deriveShardCapabilityGrant`. While set, it governs tool
   * gates, prompt tool availability, and audit tier fields, and it takes
   * precedence over any disk-backed CapabilityRuntime — a shard agent must not
   * re-resolve authority from an owner file or a tier name. Pass `null` to
   * remove it and fall back to the runtime/tier resolution order.
   */
  setCapabilityAccess(access: CapabilityAccess | null): void {
    this.explicitCapabilityAccess = access;
    this.gatedToolCache = new WeakMap<AgentTool<any>, AgentTool<any>>();
    this.refreshCapabilityRuntime();
  }

  // ── Steering + follow-up + lifecycle ──

  /** Whether the agent is currently processing a prompt */
  get isStreaming(): boolean {
    return this.agent.state.isStreaming;
  }

  /**
   * Inject a steering message mid-run. Delivered after current tool execution,
   * remaining tool calls are skipped, and the message is added to context
   * before the next LLM call. When no ordinary run can accept it, the message
   * starts a fresh ordinary turn under its own reservation owner.
   * Input arriving during an exclusive candidate turn is deferred as a fresh
   * ordinary turn so it cannot steer the candidate-owned provider loop.
   */
  async steer(message: SubstrateMessage): Promise<void> {
    return this.turnRunReservation.runIngress({
      kind: 'queued-ingress',
      sourceId: message.id,
      ingress: 'steer',
    }, async ({ deferredFromExclusive }) => {
      // Claim the fresh-ordinary FIFO slot synchronously, before author
      // resolution, so concurrent idle inputs cannot invert arrival order.
      const slot = this.turnQueueIngress.reserveFreshOrdinarySlot();
      try {
        if (!deferredFromExclusive && await this.trySteerActiveRun(message)) return;
        await slot.run(message);
      } finally {
        slot.dispose();
      }
    });
  }

  private async trySteerActiveRun(message: SubstrateMessage): Promise<boolean> {
    const authorContext = await this.promptContextBuilder.resolveAuthorContext(message);
    if (!this.turnQueueIngress.canQueueIntoActiveOrdinaryRun()) return false;
    const turnSessionIdentity = this.requireActiveTurnSessionIdentity();
    this.turnSupportRuntime.recordUserMessage(
      message,
      turnSessionIdentity,
      createTurnId(),
      message.id,
      authorContext.trustLevel,
      authorContext.subjectIdentityKey ?? authorContext.canonicalContactKey,
    );
    this.agent.steer({
      role: 'user',
      content: message.content,
      timestamp: Date.now(),
    } satisfies UserMessage);
    log.debug('Steered message', { channelId: message.channelId, content: message.content.slice(0, 80) });
    return true;
  }

  /**
   * Queue a follow-up message processed after the agent finishes current work.
   * Non-interrupting — waits for idle before delivery.
   *
   * Intention appraisal follow-ups are injected as internal Whisper notes to self
   * and are never persisted into the external session journal.
   * Input arriving during an exclusive candidate turn is deferred as a fresh
   * ordinary turn rather than entering the candidate follow-up queue.
   */
  async followUp(message: SubstrateMessage): Promise<void> {
    return this.followUpIngress.followUp(message);
  }

  /**
   * Route a terminal child result to its originating companion context.
   * A matching active parent turn receives a private internal whisper; idle or
   * differently-scoped work is buffered by logical session for the next
   * ordinary turn. Neither path creates conversational speech or outbound IO.
   */
  async deliverCompletionNotice(
    input: CompletionNoticeDeliveryInput,
  ): Promise<CompletionNoticeDeliveryDisposition> {
    return this.followUpIngress.deliverCompletionNotice(input);
  }

  private requireActiveTurnSessionIdentity(): TurnSessionIdentity {
    const identity = this.turnSupportRuntime.getActiveTurnSessionIdentity();
    if (!identity) {
      throw new Error('Active ordinary run is missing its captured session identity');
    }
    return identity;
  }

  /**
   * Record a message as observed context without invoking the model or adding an
   * assistant response. Used for ambient channel traffic that should be visible
   * in later turns but must not itself trigger a reply.
   */
  async observeMessage(message: SubstrateMessage): Promise<void> {
    await this.classifySessionAtCreation?.(message);
    return this.turnRunReservation.runIngress({
      kind: 'queued-ingress',
      sourceId: message.id,
      ingress: 'observation',
    }, () => this.observeMessageUnderReservation(message));
  }

  private async observeMessageUnderReservation(message: SubstrateMessage): Promise<void> {
    // mmo9.4: observations record onto the last-committed session without
    // blocking on pending auto-compaction. The durable compaction job commits
    // atomically via append-only insertCompaction and does not conflict with a
    // concurrently appended observation entry.
    const turnId = createTurnId();
    const requestId = message.id;
    const observationMetadata = JSON.stringify({
      type: 'observed_message',
      source: message.routing?.source ?? message.channelType,
      responseMode: message.routing?.responseMode ?? 'observe',
    });
    const recordOptions = {
      turnId,
      requestId,
      sourceMessageId: message.id,
      ...(message.replyToMessageId ? { replyToMessageId: message.replyToMessageId } : {}),
      ...(message.routing?.addressing ? { addressing: message.routing.addressing } : {}),
      metadata: observationMetadata,
      channelMeta: {
        isDirectMessage: message.isDirectMessage ?? false,
      },
    };

    if (message.authorId.startsWith('system:')) {
      this.sessionManager.recordSystemMessage(
        message.channelId,
        formatAttributedSystemContent(message.content, message.authorName),
        message.authorId,
        message.authorName,
        message.isDirectMessage,
        undefined,
        recordOptions,
      );
      return;
    }

    const authorContext = await this.promptContextBuilder.resolveAuthorContext(message);
    const continuitySubjectKey = resolveContinuitySubjectKey({
      canonicalContactKey: authorContext.canonicalContactKey,
      subjectIdentityKey: authorContext.subjectIdentityKey,
      authorId: message.authorId,
    });
    this.sessionManager.recordUserMessage(
      message.channelId,
      message.content,
      message.authorId,
      message.authorName,
      message.isDirectMessage,
      continuitySubjectKey,
      {
        ...recordOptions,
        trustLevel: authorContext.trustLevel,
        // htm9.3: observed (no-turn) messages persist their adapter-screened
        // intake envelopes too, so later context builds gate them.
        ...(message.routing?.intakeEnvelopes && message.routing.intakeEnvelopes.length > 0
          ? { intakeEnvelopes: message.routing.intakeEnvelopes }
          : {}),
      },
    );
    log.debug('Observed message without model turn', {
      channelId: message.channelId,
      messageId: message.id,
      authorId: message.authorId,
    });
  }

  /** Wait for the model engine and every owned outer turn callback to settle. */
  async waitForIdle(): Promise<void> {
    await Promise.all([
      this.agent.waitForIdle(),
      this.turnRunReservation.waitForIdle(),
    ]);
  }

  setActiveConcernProvider(provider: ActiveConcernContextProvider | null): void {
    this.activeConcernProvider = provider;
  }

  setPendingFollowUpProvider(provider: PendingFollowUpContextProvider | null): void {
    this.pendingFollowUpProvider = provider;
  }

  setBehavioralPatternProvider(provider: BehavioralPatternContextProvider | null): void {
    this.behavioralPatternProvider = provider;
  }

  /** Late-wired by the agent entrypoint before any message callback is exposed. */
  setDurableChargeRecorder(
    recorder: DurableRunChargeRecorder,
    probe: DurableRunChargeProbe,
  ): void {
    this.durableChargeRecorder = recorder;
    this.durableChargeProbe = probe;
  }

  setSelfModelRuntimeRequired(required: boolean): void {
    this.selfModelRuntimeRequired = required;
  }

  getCurrentInternalState(): InternalState | null {
    if (!this.currentInternalState) return null;
    return cloneInternalState(this.currentInternalState);
  }

  /** Route one immutable concern-resolution appraisal into the scoped state. */
  applyConcernResolutionDelta(
    contactId: string | undefined,
    generationId: string,
    delta: VADVector,
  ): 'applied' | 'duplicate' | 'deferred' | 'unavailable' {
    return this.emotionSelfModelRuntime.applyConcernResolutionDelta(
      contactId,
      generationId,
      delta,
    );
  }

  getCurrentInternalStateSnapshotRef(): string | null {
    return this.currentInternalStateSnapshotRef;
  }

  getCurrentMetacognitiveFlags(): MetacognitiveFlag[] {
    return cloneMetacognitiveFlags(this.currentMetacognitiveFlags);
  }

  getCurrentAuthoritativeSystemPrompt(): string | null {
    return this.currentAuthoritativeSystemPrompt;
  }

  setInternalStateStore(store: InternalStateStorePort | null): void {
    this.internalStateStore = store;
  }

  setIntrospectionTurnSensitivityDecisions(
    decisions: IntrospectionTurnSensitivityDecisions | null,
  ): void {
    this.turnSupportRuntime.setIntrospectionTurnSensitivityDecisions(decisions);
  }

  /** Restores a validated persisted snapshot as the current running state (startup rehydration). */
  restorePersistedInternalState(record: PersistedInternalStateRecord): void {
    this.currentInternalState = cloneInternalState(record.state);
    this.currentInternalStateSnapshotRef = record.snapshotRef;
    this.currentMetacognitiveFlags = cloneMetacognitiveFlags(record.metacognitiveFlags);
    this.internalStateContinuityGap = null;
    this.internalStateContinuityGapRenderCount = 0;
    // S10 B3: seed the durable situated location so a restored location survives
    // a continuity gap (reload) and carries forward until a new routing signal.
    this.emotionSelfModelRuntime.restoreSituatedLocation(this.currentInternalState.situated.location);
  }

  /** Records that persisted state was too stale to restore; surfaced to her on the next turn. */
  noteInternalStateContinuityGap(gap: InternalStateContinuityGap): void {
    this.internalStateContinuityGap = gap;
    this.internalStateContinuityGapRenderCount = 0;
  }

  getInternalStateContinuityGap(): InternalStateContinuityGap | null {
    return this.internalStateContinuityGap;
  }

  private persistCurrentInternalState(): void {
    if (!this.internalStateStore || !this.currentInternalState || !this.currentInternalStateSnapshotRef) {
      return;
    }
    const record: PersistedInternalStateRecord = {
      state: cloneInternalState(this.currentInternalState),
      snapshotRef: this.currentInternalStateSnapshotRef,
      metacognitiveFlags: cloneMetacognitiveFlags(this.currentMetacognitiveFlags),
      savedAt: new Date().toISOString(),
    };
    this.internalStateStore.save(record).catch((error: unknown) => {
      log.error('Failed to persist current internal state', {
        error: toErrorMessage(error),
        snapshotRef: record.snapshotRef,
      });
    });
  }

  registerPostTurnActionInferer(inferer: PostTurnActionInferer): () => void {
    return this.turnSupportRuntime.registerPostTurnActionInferer(inferer);
  }

  registerIntentionPostTurnHook(hook: IntentionPostTurnHook): () => void {
    return this.turnSupportRuntime.registerIntentionPostTurnHook(hook);
  }

  hasDurableBackgroundWorkSupervisor(): boolean {
    return this.backgroundWorkSupervisor !== null;
  }

  async tickBackgroundWork(): Promise<void> {
    const supervisor = this.backgroundWorkSupervisor;
    if (!supervisor) {
      throw new Error('Durable background work supervisor is not configured');
    }
    await runBackgroundWorkTick({
      recoverHandoffs: () => this.backgroundWorkHandoffRecoveryRuntime.recover(
        jobs => supervisor.enqueue(jobs),
      ),
      tick: () => supervisor.tick(),
    });
  }

  setBackgroundWorkExecutionScope(scope: BackgroundWorkExecutionScope): void {
    const supervisor = this.backgroundWorkSupervisor;
    if (!supervisor) {
      throw new Error('Durable background work supervisor is not configured');
    }
    supervisor.setExecutionScope(scope);
  }

  async stopBackgroundWork(): Promise<void> {
    this.backgroundWorkHandoffRecoveryRuntime.abort();
    await this.backgroundWorkSupervisor?.stop();
  }

  /**
   * Synchronously latch recovery cancellation before the scheduler drains.
   * The latch closes the race where an in-flight scheduler tick has started but
   * has not yet installed its recovery AbortController.
   */
  abortBackgroundWorkRecovery(): void {
    this.backgroundWorkHandoffRecoveryRuntime.abort();
  }

  /** Abort the expected request's prompt and report whether its signal was actually tripped. */
  abort(expectedRequestId?: string): SubstrateAgentAbortResult {
    this.turnRunReservation.assertActiveRunMutationAllowed('abort');
    return abortActiveAgentRun(this.agent, expectedRequestId);
  }

  /**
   * mmo9.6.1: identity-guarded turn cancellation. Aborts the active turn IFF
   * its cancellation identity matches `cancellationId`. A cancel that names a
   * turn which is no longer active (already finished, or superseded by a newer
   * turn) is a deliberate no-op — it returns `owner_mismatch`/`not_active` and
   * never aborts whatever turn is currently running. This is the seam voice
   * barge-in and preemptive control frames route through so a late interrupt
   * cannot kill the next turn.
   */
  cancelTurn(cancellationId: string): SubstrateAgentAbortResult {
    if (!cancellationId) {
      return { status: 'owner_mismatch' };
    }
    if (this.activeTurnCancellationId === null) {
      return { status: 'not_active' };
    }
    if (this.activeTurnCancellationId !== cancellationId) {
      return { status: 'owner_mismatch' };
    }
    return this.abort();
  }

  async handleMessage(
    message: SubstrateMessage,
    deliveryLifecycle?: TurnDeliveryLifecycle,
    turnControl?: MessageHandlerOptions,
  ): Promise<AgentResponse> {
    await this.classifySessionAtCreation?.(message);
    return this.turnRunReservation.runShared(
      { kind: 'ordinary-turn', sourceId: message.id },
      () => {
        this.turnQueueIngress.enqueuePendingInternalFollowUpsForOrdinaryRun();
        return this.handleMessageUnderReservation(message, deliveryLifecycle, turnControl);
      },
    );
  }

  private async handleMessageUnderReservation(
    message: SubstrateMessage,
    deliveryLifecycle?: TurnDeliveryLifecycle,
    turnControl?: MessageHandlerOptions,
  ): Promise<AgentResponse> {
    const cancellationId = turnControl?.cancellationId ?? message.routing?.cancellationId ?? null;
    // mmo9.6.1: register this turn's cancellation identity for the lifetime of
    // the run and wire the dispatch AbortSignal to the identity-guarded cancel
    // so aborting the signal cancels THIS turn and no other.
    //
    // handleMessage dispatches ordinary turns through `turnRunReservation.runShared`,
    // a reader-writer lock that grants consecutive ordinary turns CONCURRENTLY
    // (see turn-run-reservation.ts drain: `while (queue[0]?.mode === 'shared')`).
    // Only ONE of those overlapping turns becomes the pi-agent `activeRun`; every
    // other concurrent dispatch throws 'Agent is already processing' and is a
    // throw-away. A throw-away turn MUST NOT overwrite — or null — the running
    // turn's cancellation identity, or a voice barge-in silently no-ops
    // (psfn-framework-mmo9.6.1): a concurrent scheduler/heartbeat/API turn carries
    // no cancellationId and, under the old unconditional assignment, reset the
    // field to null while a voice turn was mid-generation. So a turn CLAIMS the
    // identity only when it carries one AND none is currently registered, and it
    // CLEARS only the identity it itself registered — leaving the genuinely
    // active run the sole owner of the cancellation identity.
    const claimsCancellationIdentity =
      cancellationId !== null && this.activeTurnCancellationId === null;
    if (claimsCancellationIdentity) {
      this.activeTurnCancellationId = cancellationId;
    }
    let detachCancelSignal: (() => void) | null = null;
    if (turnControl?.signal && cancellationId !== null) {
      const signal = turnControl.signal;
      const onAbort = (): void => {
        this.cancelTurn(cancellationId);
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
        detachCancelSignal = () => signal.removeEventListener('abort', onAbort);
      }
    }
    try {
      return await this.handleMessageUnderReservationInner(message, deliveryLifecycle);
    } finally {
      detachCancelSignal?.();
      // Clear only the identity THIS turn registered. A concurrent throw-away
      // turn that never claimed the field must not clear the active turn's id.
      if (claimsCancellationIdentity && this.activeTurnCancellationId === cancellationId) {
        this.activeTurnCancellationId = null;
      }
    }
  }

  private async handleMessageUnderReservationInner(
    message: SubstrateMessage,
    deliveryLifecycle?: TurnDeliveryLifecycle,
  ): Promise<AgentResponse> {
    const run = async (): Promise<AgentResponse> => handleMessageForTurn(createTurnExecutionRuntimeAdapter({
      eventBus: this.eventBus,
      costTelemetry: createEventBusCostTelemetryPort(this.eventBus),
      durableChargeRecorder: this.durableChargeRecorder,
      durableChargeProbe: this.durableChargeProbe,
      fatigueBudget: this.fatigueBudget,
      humanAttentionPressure: this.humanAttentionPressure,
      fatigueRegulationReservations: this.fatigueRegulationReservations,
      satellitePresence: this.satellitePresencePort,
      companionPresence: this.companionPresence,
      llmClient: this.llmClient,
      runtime: this.runtime,
      imageVisionReviewer: this.imageVisionReviewer,
      visionIntakeScreener: this.visionIntakeScreener,
      cogSecMode: this.cogSecMode,
      sessionManager: this.sessionManager,
      config: this.config,
      runtimeMode: this.runtimeMode,
      agent: this.agent,
      bridge: this.bridge,
      systemPrompt: this.systemPrompt,
      memoryProvider: this.memoryProvider,
      artifactApprovalQueue: this.artifactApprovalQueue,
      artifactApprovalNotifier: this.artifactApprovalNotifier,
      ...(this.shareApprovedArtifacts
        ? { shareApprovedArtifacts: this.shareApprovedArtifacts }
        : {}),
      memoryExtractor: this.memoryExtractor,
      wikiRetrieval: this.wikiRetrieval,
      placesRegistry: this.placesRegistryConfig,
      resolveSituatedFallbackPlaceId: (message) => this.resolveSituatedFallbackPlaceIdForTurn(message),
      followVirtualRoomActivity: (message, author) => this.virtualRoomFollower.maybeFollow(message, author),
      skillsRuntime: this.skillsRuntime,
      evaluateReflectionNudge: (toolSummary) => this.reflectionNudge.evaluate(toolSummary),
      emotionSelfModelRuntime: this.emotionSelfModelRuntime,
      observerEvalSidecar: this.observerEvalSidecar,
      turnSupportRuntime: this.turnSupportRuntime,
      toolRuntimeFacade: this.toolRuntimeFacade,
      promptCacheRuntime: this.promptCacheRuntime,
      completionNotices: this.completionNotices,
      callbacks: {
        resolveTaskKind: (turnMessage) => resolveTaskKindForRuntime(turnMessage, this.channelRegistry),
        buildTurnBudgetCharacteristics: (turnMessage, taskKind) => buildTurnBudgetCharacteristicsForRuntime(
          turnMessage,
          taskKind,
        ),
        resolveAuthorContext: (turnMessage) => this.promptContextBuilder.resolveAuthorContext(turnMessage),
        countResolvableSpeakerContacts: (turnMessage, speakers) => countResolvableSpeakerContactsForTurn({
          message: turnMessage,
          speakers,
          contactStore: this.contactStore,
        }),
        resolveParticipantRelationships: (turnMessage, scope, trustLevel) => resolveParticipantRelationshipsForTurn({
          message: turnMessage,
          conversationScope: scope,
          trustLevel,
          contactStore: this.contactStore,
        }),
        resolveChannelType: (turnMessage) => resolveChannelTypeForRuntime(turnMessage, this.channelRegistry),
        ensureModel: (turnMessage) => this.ensureModel(turnMessage),
        captureTurnPromptSnapshot: (ctx) => captureTurnPromptSnapshotForTurn({
          promptComposer: this.promptComposer,
          composeContext: ctx,
          systemPrompt: this.systemPrompt,
        }),
        captureAuthoritativeSystemPrompt: (systemPrompt) => {
          this.currentAuthoritativeSystemPrompt = systemPrompt.trim() || null;
        },
        buildScratchpadContextBlock: () => this.promptContextBuilder.buildScratchpadContextBlock(),
        normalizeTurnPromptOverride: (turnMessage) => this.normalizeTurnPromptOverride(turnMessage),
        resolveResponseStyle: (turnMessage, channelType, channelMeta) => this.resolveResponseStyle(
          turnMessage,
          channelType,
          channelMeta,
        ),
        buildPromptTemplateVariables: (
          turnMessage,
          resolvedUserName,
          trustLevel,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
          now,
        ) => this.promptContextBuilder.buildPromptTemplateVariables(
          turnMessage,
          resolvedUserName,
          trustLevel,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
          now,
        ),
        buildDynamicPromptTemplateVariables: (
          turnMessage,
          resolvedUserName,
          trustLevel,
          relationshipType,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
          responseStyle,
          now,
          taskKind,
          templateVariables,
          internalState,
          metacognitiveFlags,
          emotionAppraisalChain,
          currentUserRuntimeProfile,
          conversationScope,
          participantRelationshipEdges,
          capturedSessionReads,
        ) => this.promptContextBuilder.buildDynamicPromptTemplateVariables(
          turnMessage,
          resolvedUserName,
          trustLevel,
          relationshipType,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
          responseStyle,
          now,
          taskKind,
          templateVariables,
          internalState,
          metacognitiveFlags,
          emotionAppraisalChain,
          currentUserRuntimeProfile,
          conversationScope,
          participantRelationshipEdges,
          capturedSessionReads,
        ),
        setCurrentSelfModelState: (state, snapshotRef, metacognitiveFlags) => {
          this.currentInternalState = state;
          this.currentInternalStateSnapshotRef = snapshotRef;
          this.currentMetacognitiveFlags = cloneMetacognitiveFlags(metacognitiveFlags);
          // A continuity gap stays visible for the first turn after restart
          // (state is recomputed before the prompt renders), then clears.
          if (this.internalStateContinuityGap && this.internalStateContinuityGapRenderCount > 0) {
            this.internalStateContinuityGap = null;
          }
          this.persistCurrentInternalState();
        },
        setCurrentTurnDisclosureLineage: (lineage) => {
          this.currentTurnDisclosureLineage = lineage;
        },
        getCurrentTurnDisclosureLineage: () => this.currentTurnDisclosureLineage,
        buildRuntimeContext: (
          turnMessage,
          resolvedUserName,
          trustLevel,
          relationshipType,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
          responseStyle,
          now,
          taskKind,
          templateVariables,
          internalState,
          metacognitiveFlags,
          emotionAppraisalChain,
          conversationScope,
        ) => this.promptContextBuilder.buildRuntimeContext(
          turnMessage,
          resolvedUserName,
          trustLevel,
          relationshipType,
          channelType,
          canonicalContactKey,
          subjectIdentityKey,
          responseStyle,
          now,
          taskKind,
          templateVariables,
          internalState,
          metacognitiveFlags,
          emotionAppraisalChain,
          conversationScope,
        ),
        buildPromptPrefixCacheKey: buildPromptPrefixCacheKeyForTurn,
        buildStaticPromptSettingsHash: buildStaticPromptSettingsHashForTurn,
        resolveStaticPromptPrefix: (params) => resolveStaticPromptPrefixForTurn({
          cache: this.appCache,
          cacheKey: params.cacheKey,
          staticPrefixTemplate: params.staticPrefixTemplate,
          staticHash: params.staticHash,
          settingsHash: params.settingsHash,
          now: params.now,
          variables: params.variables,
          onCacheEvent: event => logStaticPromptPrefixCacheEvent(this.appCache, event, log),
        }),
        hashPromptText: hashPromptTextForTurn,
        getPersonaAdaptation: (
          trustLevel,
          internalState,
          metacognitiveFlags,
          templateVariables,
        ) => this.promptContextBuilder.getPersonaAdaptation(
          trustLevel,
          internalState,
          metacognitiveFlags,
          templateVariables,
        ),
        resolveContextWindow: () => resolveContextWindowForRuntime(
          this.config,
          this.agent.state.model as { contextWindow?: unknown } | undefined,
        ),
        extractResponseText: () => extractResponseTextForRuntime({
          assistantMessage: getLatestAssistantMessageForRuntime(
            this.agent.state.messages,
            this.promptContextBuilder.getUserFacingBoundaryIndex(),
          ),
          logger: log,
        }),
        getLatestAssistantMessage: () => getLatestAssistantMessageForRuntime(
          this.agent.state.messages,
          this.promptContextBuilder.getUserFacingBoundaryIndex(),
        ),
      },
    }), message, deliveryLifecycle);

    return this.toolRuntimeFacade.runWithTurnToolContext(message, async () => {
      // htm9.3: expose the message's intake envelopes to the egress tool guard
      // for the duration of this turn (cleared in finally — never leaks into
      // the next turn).
      this.currentTurnIntakeEnvelopes = message.routing?.intakeEnvelopes ?? [];
      // Fail closed: no lineage is published until the generation context is
      // folded this turn, so a social send before then is denied outward.
      this.currentTurnDisclosureLineage = undefined;
      try {
        if (!this.config.chargePolicy || getRunChargeContext()) {
          return await run();
        }

        return await runWithChargeContext({
          chargePolicy: this.config.chargePolicy,
          eventBus: this.eventBus,
          lane: 'interactive',
          runId: message.id,
          correlation: {
            requestId: message.id,
            channelId: message.channelId,
          },
        }, run);
      } finally {
        this.currentTurnIntakeEnvelopes = [];
        this.currentTurnDisclosureLineage = undefined;
      }
    });
  }

  async handleIcpAutonomyCandidateTurn(message: SubstrateMessage): Promise<AgentResponse> {
    return this.turnRunReservation.runExclusive({
      kind: 'candidate-turn',
      sourceId: message.id,
    }, async () => {
      this.turnQueueIngress.assertCandidateQueueEmpty();
      const candidateOrigin = resolveIcpAutonomyCandidateSchedulerOrigin(message);
      if (!candidateOrigin) {
        throw new Error('Trusted ICP autonomy candidate turn requires a validated scheduler origin');
      }
      return this.toolRuntimeFacade.runWithIcpAutonomyCandidateNotifyScope(
        message,
        () => this.handleMessageUnderReservation(message),
      );
    });
  }

  /** Restart-safe recovery for a sender-side target-channel initiation turn. */
  findRecordedIcpInitiation(
    channelId: string,
    sourceMessageId: string,
  ): {
    content: string;
    correlation: import('../../shared/contracts/icp-autonomy.js').IcpConversationCorrelation;
    recoveryResponse: AgentResponse;
  } | null {
    return this.sessionManager.findRecordedIcpInitiation(channelId, sourceMessageId);
  }

  findIcpDeliveryObservation(
    channelId: string,
    sourceMessageId: string,
  ): import('../session/icp-delivery-recovery.js').IcpDeliveryObservation | null {
    return this.sessionManager.findIcpDeliveryObservation(channelId, sourceMessageId);
  }

  /** Durable recipient envelope used to bind restart replay to original L0 truth. */
  findRecordedCompanionSourceMessage(
    channelId: string,
    sourceMessageId: string,
  ): import('../session/icp-delivery-recovery.js').RecordedCompanionSourceMessage | null {
    return this.sessionManager.findRecordedCompanionSourceMessage(channelId, sourceMessageId);
  }

  /** Durable recipient-side source-id check; survives agent process restart. */
  hasRecordedSourceMessage(channelId: string, sourceMessageId: string): boolean {
    return this.sessionManager.hasRecordedSourceMessage(channelId, sourceMessageId);
  }

  /**
   * Records local transport truth in the channel journal's hidden system lane.
   * It never becomes peer speech and therefore cannot imply a failed send was
   * mutually witnessed.
   */
  recordIcpDeliveryObservation(
    observation: import('../session/icp-delivery-recovery.js').IcpDeliveryObservation,
  ): void {
    this.sessionManager.recordIcpDeliveryObservation(observation);
  }

}
