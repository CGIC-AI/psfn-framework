import type {
  MemoryProvider,
  EmbeddingProviderPort,
  LLMProviderPort,
  RetrievalVADInput,
} from '../../core/agent/contracts.js';
import type {
  ContactProfileArtifact,
  MemoryStorePort,
} from './memory-store-port.js';
import type {
  PurrMemory,
  MemoryScopeQuery,
  RetrievalCallerContext,
  RetrievalModeInput,
} from './types.js';
import { MEMORY_CONFIG } from './types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import type { TrustLevel } from '../../system/trust/types.js';
import type { ChannelPrivacy } from '../../system/trust/context-envelope.js';
import type {
  ContextBudgetConfigLike,
  ContextBudgetTurnCharacteristics,
} from '../../shared/context-budget.js';
import { classifyChannelDisclosure, type ChannelMeta } from '../../system/trust/policy.js';
import { resolveBroadcastVisibilityScope } from '../../system/trust/broadcast-safety.js';
import { createComponentLogger } from '../../shared/logger.js';
import { clampUnit as clampProbability } from '../../shared/utils/numeric.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { ConversationScope } from '../../core/session/conversation-scope.js';
import type { TurnMemorySnapshot } from '../../core/turns/snapshot.js';
import {
  normalizeCostTelemetryPort,
  type CostTelemetryInput,
  type CostTelemetryPort,
} from '../../shared/telemetry/cost-telemetry-port.js';
import {
  cloneContactProfileArtifact,
  cloneEmotionalSnapshot,
  cloneMemory,
  cloneScoredMemory,
} from '../../core/turns/snapshot.js';
import { isInternalMemoryArtifact } from './internal-artifacts.js';
import {
  cloneMemoryWithheldSummary,
  type MemoryWithheldSummary,
} from './withheld-summary.js';
import {
  memoryMatchesScopeQuery,
  normalizeMemoryScopeQuery,
} from './types.js';
import {
  evaluateRetrievalAccessDecision,
  mergeMemoryWithheldSummaries,
  summarizeWithheldMemories,
  type RetrievalRoomVisibilityContext,
} from './retrieval/access.js';
import {
  type ContactProfileAccessResult,
  resolveContactProfileAccess as resolveContactProfileAccessWithDeps,
  resolveRoomVisibilityContext as resolveRoomVisibilityContextWithDeps,
} from './retrieval/access-context.js';
import {
  cloneActiveMemorySnapshot,
  type ActiveMemoryRefreshLoop,
  type ActiveMemoryRefreshTarget,
  type ActiveMemoryState,
} from './retrieval/active-state.js';
import {
  finalizeRetrievalPromptBlock as finalizeRetrievalPromptBlockWithActiveContext,
  invalidateActiveMemoryContexts as invalidateActiveMemoryContextsWithDeps,
} from './retrieval/active-context-refresh.js';
import {
  resolveMemoryRetrieverBudget,
  resolveGuaranteedSelectionFloor,
  selectWithinRelevanceAndTokenBudget,
} from './retrieval/budget.js';
import {
  collectRecentLexicalMemoryCandidates,
  mergeScoredMemoryCandidates,
} from './retrieval/candidates.js';
import {
  applyCompositionalRetrievalRanking as applyCompositionalRetrievalRankingWithPolicy,
} from './retrieval/compositional.js';
import type {
  ActiveMemoryContextInvalidationRequest,
  ActiveMemoryContextInvalidationResult,
  ActiveMemoryContextRequest,
  ActiveMemoryContextSnapshot,
} from './active-context.js';
import {
  resolveActiveMemoryContextIdentity,
} from './active-context.js';
import {
  cloneEpisodicRetrievalChain,
  collectEpisodicChainProvenanceRefs,
  countEpisodicChainEpisodes,
  type EpisodicRetrievalChain,
  type EpisodicRetrievalStore,
} from './retrieval/episodic.js';
import {
  resolveEpisodicChains as resolveEpisodicChainsWithDeps,
} from './retrieval/episodic-resolution.js';
import {
  retrieveProactiveRecall as retrieveProactiveRecallWithDeps,
} from './retrieval/proactive-recall.js';
import {
  applyScoreGuarantee,
  collectSelectedProvenanceRefs,
  computeRetrievalScore,
  countSelectedMemoryTypes,
  resolveMoodCongruenceWeight,
  SCORE_GUARANTEE_FLOOR,
  SCORE_GUARANTEE_MIN_K,
} from './retrieval/scoring.js';
import {
  computeSharedBackground,
  SHARED_BACKGROUND_DEFAULT_LIMIT,
  type SharedBackgroundAccessOptions,
  type SharedBackgroundResult,
} from './retrieval/shared-background.js';
import {
  collectContactProfileProvenanceRefs,
  mergeProvenanceRefs,
} from './retrieval/provenance.js';
import {
  applyWithheldSummaryTelemetry,
  buildManifestSeedFromTelemetry,
} from './retrieval/telemetry.js';
import {
  emitRetrievalTelemetry as emitRetrievalTelemetryWithDeps,
} from './retrieval/telemetry-emission.js';
import {
  filterQuarantinedEpisodicChains,
  filterQuarantinedMemories,
  isMemoryQuarantined,
  type MemorySessionQuarantineFilter,
} from './retrieval/session-quarantine.js';
import {
  applySocialContextRankingAdjustments,
  attachEvolutionChains,
  buildSelectedContactContext,
  collectContactEmotionalMemories,
  collectEmotionalContinuityMemories,
  collectProactiveRecallCandidates,
  resolveEmotionalSnapshot,
  resolveRetrievalSocialContext,
} from './retrieval/social-context.js';
import {
  captureTurnMemorySnapshot as captureTurnMemorySnapshotWithDeps,
} from './retrieval/turn-snapshot.js';
import type {
  RetrievalContactContext,
  RetrievalDecisionDiagnostics,
  RetrievalSocialContext,
  RetrievalTelemetry,
  ScoredMemory,
} from './retrieval/types.js';
const log = createComponentLogger('Retrieval');

type RetrievalIntegrityErrorStage =
  | 'retrieve'
  | 'episodic_retrieve'
  | 'selected_access_update'
  | 'proactive_access_update';

export interface RetrievalIntegrityErrorContext {
  stage: RetrievalIntegrityErrorStage;
  channelId: string;
  trustLevel?: TrustLevel;
  memoryId?: string;
}

export class RetrievalIntegrityError extends Error {
  readonly context: RetrievalIntegrityErrorContext;
  readonly cause: unknown;

  constructor(message: string, context: RetrievalIntegrityErrorContext, cause: unknown) {
    super(message);
    this.name = 'RetrievalIntegrityError';
    this.context = context;
    this.cause = cause;
  }
}

export interface MemoryRetrieverConfig {
  retrievalBudgetPct?: number;
  contextWindow?: number;
  retrievalThreshold?: number;
  moodCongruenceWeight?: number;
  telemetryEnabled?: boolean;
  proactiveRecallProbability?: number;
  proactiveRecallMinTurnsBetween?: number;
}

function isSubstrateConfig(config: MemoryRetrieverConfig | SubstrateConfig | undefined): config is SubstrateConfig {
  return !!config && typeof config === 'object' && 'defaultContextWindow' in config;
}

type ProactiveRecallRuntimeConfig = SubstrateConfig & {
  memoryProactiveRecallProbability?: number;
  memoryProactiveRecallMinTurnsBetween?: number;
};

export class MemoryRetriever implements MemoryProvider {
  private memoryStore: MemoryStorePort;
  private embeddingService: EmbeddingProviderPort;
  private runtimeConfig: SubstrateConfig | null;
  private fallbackBudgetConfig: ContextBudgetConfigLike | null;
  private retrievalThreshold: number;
  private costTelemetry?: CostTelemetryPort;
  private eventBus?: EventBus;
  private contactStore: ContactStorePort | null;
  private telemetryEnabled: boolean;
  private llmProvider: LLMProviderPort | null;
  private episodicStore: EpisodicRetrievalStore | null;
  private moodCongruenceWeight: number;
  private proactiveRecallProbability: number;
  private proactiveRecallMinTurnsBetween: number;
  private proactiveTurnCounter: number;
  private lastProactiveRecallTurn: number;
  private activeMemoryContexts: Map<string, ActiveMemoryState>;
  private activeMemoryRefreshLoops: Map<string, ActiveMemoryRefreshLoop>;
  private sessionQuarantineFilter: MemorySessionQuarantineFilter | null;

  constructor(
    memoryStore: MemoryStorePort,
    embeddingService: EmbeddingProviderPort,
    config?: MemoryRetrieverConfig | SubstrateConfig,
    costTelemetry?: CostTelemetryInput,
    contactStore?: ContactStorePort | null,
    llmProvider?: LLMProviderPort | null,
    episodicStore?: EpisodicRetrievalStore | null,
    sessionQuarantineFilter?: MemorySessionQuarantineFilter | null,
  ) {
    this.memoryStore = memoryStore;
    this.embeddingService = embeddingService;
    this.costTelemetry = normalizeCostTelemetryPort(costTelemetry);
    if (isSubstrateConfig(config)) {
      this.runtimeConfig = config;
      this.fallbackBudgetConfig = null;
      this.retrievalThreshold = MEMORY_CONFIG.retrievalThreshold;
      this.moodCongruenceWeight = resolveMoodCongruenceWeight(config.moodCongruenceWeight);
      this.telemetryEnabled = config.memoryRetrievalTelemetryEnabled ?? true;
      const proactiveConfig = config as ProactiveRecallRuntimeConfig;
      this.proactiveRecallProbability = clampProbability(proactiveConfig.memoryProactiveRecallProbability ?? 0);
      this.proactiveRecallMinTurnsBetween = clampTurnFrequency(proactiveConfig.memoryProactiveRecallMinTurnsBetween ?? 2);
    } else {
      const retrieverConfig = config as MemoryRetrieverConfig | undefined;
      this.runtimeConfig = null;
      this.fallbackBudgetConfig = {
        defaultContextWindow: retrieverConfig?.contextWindow ?? 128_000,
        modelRoster: {},
        ...(retrieverConfig?.retrievalBudgetPct !== undefined
          ? { memoryRetrievalBudgetPct: retrieverConfig.retrievalBudgetPct }
          : {}),
      };
      this.retrievalThreshold = retrieverConfig?.retrievalThreshold ?? MEMORY_CONFIG.retrievalThreshold;
      this.moodCongruenceWeight = resolveMoodCongruenceWeight(retrieverConfig?.moodCongruenceWeight);
      this.telemetryEnabled = retrieverConfig?.telemetryEnabled ?? true;
      this.proactiveRecallProbability = clampProbability(retrieverConfig?.proactiveRecallProbability ?? 0);
      this.proactiveRecallMinTurnsBetween = clampTurnFrequency(retrieverConfig?.proactiveRecallMinTurnsBetween ?? 2);
    }
    this.contactStore = contactStore ?? null;
    this.llmProvider = llmProvider ?? null;
    this.episodicStore = episodicStore ?? null;
    this.sessionQuarantineFilter = sessionQuarantineFilter ?? null;
    this.proactiveTurnCounter = 0;
    this.lastProactiveRecallTurn = Number.NEGATIVE_INFINITY;
    this.activeMemoryContexts = new Map();
    this.activeMemoryRefreshLoops = new Map();
  }

  /**
   * Shared-background retrieval mode (E4.5): the union of memories that link two
   * contacts (edge-evidence, co-mention, shared-room), gated by the asking
   * context and bounded to top-K. Exposed to the model only as the
   * `shared_background` ACTION of the canonical memory tool (Charter Law 33).
   */
  async sharedBackground(input: {
    contactAId: string;
    contactBId: string;
    access: SharedBackgroundAccessOptions;
    limit?: number;
  }): Promise<SharedBackgroundResult> {
    if (!this.contactStore) {
      // Fail closed: no contact store means the social graph and rosters are
      // unavailable, so no link can be established.
      return {
        contactAId: input.contactAId,
        contactBId: input.contactBId,
        resolved: false,
        missingContactIds: [input.contactAId, input.contactBId],
        items: [],
        totalCandidates: 0,
        truncated: false,
        limit: input.limit ?? SHARED_BACKGROUND_DEFAULT_LIMIT,
      };
    }
    return computeSharedBackground(
      { memoryStore: this.memoryStore, contactStore: this.contactStore },
      {
        contactAId: input.contactAId,
        contactBId: input.contactBId,
        access: input.access,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    );
  }

  private resolveRetrievalBudget(
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): ReturnType<typeof resolveMemoryRetrieverBudget> {
    return resolveMemoryRetrieverBudget(this.runtimeConfig, this.fallbackBudgetConfig, turnBudgetCharacteristics);
  }

  getActiveMemoryContext(request: ActiveMemoryContextRequest): ActiveMemoryContextSnapshot | null {
    const identity = resolveActiveMemoryContextIdentity(request);
    const state = this.activeMemoryContexts.get(identity.key);
    if (!state) return null;
    return cloneActiveMemorySnapshot(state.snapshot);
  }

  invalidateActiveMemoryContexts(
    request: ActiveMemoryContextInvalidationRequest,
  ): ActiveMemoryContextInvalidationResult {
    return invalidateActiveMemoryContextsWithDeps(request, {
      activeMemoryContexts: this.activeMemoryContexts,
      eventBus: this.eventBus,
      toErrorMessage,
    });
  }

  refreshActiveMemoryContext(request: ActiveMemoryContextRequest): Promise<ActiveMemoryContextSnapshot | null> {
    const identity = resolveActiveMemoryContextIdentity(request);
    const existing = this.activeMemoryRefreshLoops.get(identity.key);
    if (existing) {
      existing.latestRequest = request;
      return existing.running;
    }

    const loop: ActiveMemoryRefreshLoop = {
      running: Promise.resolve(null),
    };
    loop.running = this.runActiveMemoryRefreshLoop(identity.key, request)
      .finally(() => {
        if (this.activeMemoryRefreshLoops.get(identity.key) === loop) {
          this.activeMemoryRefreshLoops.delete(identity.key);
        }
      });
    this.activeMemoryRefreshLoops.set(identity.key, loop);
    return loop.running;
  }

  private async runActiveMemoryRefreshLoop(
    key: string,
    initialRequest: ActiveMemoryContextRequest,
  ): Promise<ActiveMemoryContextSnapshot | null> {
    let nextRequest: ActiveMemoryContextRequest | undefined = initialRequest;
    let latestSnapshot: ActiveMemoryContextSnapshot | null = null;
    while (nextRequest) {
      latestSnapshot = await this.performActiveMemoryRefresh(nextRequest);
      const loop = this.activeMemoryRefreshLoops.get(key);
      nextRequest = loop?.latestRequest;
      if (loop) {
        delete loop.latestRequest;
      }
    }
    return latestSnapshot;
  }

  private async performActiveMemoryRefresh(
    request: ActiveMemoryContextRequest,
  ): Promise<ActiveMemoryContextSnapshot | null> {
    const identity = resolveActiveMemoryContextIdentity(request);
    const startedAt = Date.now();
    this.markActiveMemoryRefreshing(identity.key, startedAt);

    try {
      const turnSnapshot = typeof this.captureTurnMemorySnapshot === 'function'
        ? await this.captureTurnMemorySnapshot(
          request.contextText,
          request.channelId,
          request.trustLevel,
          request.channelMeta,
          request.canonicalContactId,
          request.turnBudgetCharacteristics,
          request.scopeQuery,
          request.callerContext,
          request.retrievalMode,
        )
        : undefined;

      await this.retrieve(
        request.contextText,
        request.channelId,
        request.trustLevel,
        request.channelMeta,
        request.canonicalContactId,
        turnSnapshot,
        request.turnBudgetCharacteristics,
        undefined,
        request.scopeQuery,
        request.callerContext,
        request.retrievalMode,
        request.conversationScope,
        {
          request,
          startedAt,
          identity,
        },
      );
      return cloneActiveMemorySnapshot(this.activeMemoryContexts.get(identity.key)?.snapshot ?? null);
    } catch (error) {
      return this.markActiveMemoryDegraded(identity.key, request.channelId, startedAt, error);
    }
  }

  private markActiveMemoryRefreshing(key: string, startedAt: number): void {
    const state = this.activeMemoryContexts.get(key);
    if (!state) return;
    state.snapshot = {
      ...state.snapshot,
      refreshStatus: 'refreshing',
      lastRefreshStartedAt: startedAt,
    };
  }

  private markActiveMemoryDegraded(
    key: string,
    channelId: string,
    startedAt: number,
    error: unknown,
  ): ActiveMemoryContextSnapshot | null {
    const errorText = toErrorMessage(error);
    const state = this.activeMemoryContexts.get(key);
    log.error('Active memory context refresh failed; keeping previous active context', {
      key,
      channelId,
      error: errorText,
    });
    void this.eventBus?.emit('memory.active_context.refresh', {
      channelId,
      key,
      phase: 'degraded',
      error: errorText,
      timestamp: Date.now(),
    }).catch((emitError: unknown) => {
      log.debug('Failed to emit active memory refresh degradation event', {
        key,
        channelId,
        error: toErrorMessage(emitError),
      });
    });
    if (!state) return null;
    state.snapshot = {
      ...state.snapshot,
      refreshStatus: 'degraded',
      lastRefreshStartedAt: startedAt,
      lastRefreshCompletedAt: Date.now(),
      lastRefreshError: errorText,
    };
    return cloneActiveMemorySnapshot(state.snapshot);
  }

  private async resolveRoomVisibilityContext(
    channelId: string,
    channelMeta: ChannelMeta | undefined,
    canonicalContactId: string | undefined,
    conversationScope: ConversationScope | undefined,
  ): Promise<RetrievalRoomVisibilityContext> {
    return resolveRoomVisibilityContextWithDeps({
      contactStore: this.contactStore,
      channelId,
      channelMeta,
      canonicalContactId,
      conversationScope,
    });
  }

  private async resolveContactProfileAccess(
    profile: ContactProfileArtifact | undefined,
    options: {
      trustLevel: TrustLevel;
      channelPrivacy: ChannelPrivacy;
      broadcast: boolean;
      channelMeta?: ChannelMeta;
      canonicalContactId?: string;
      operatorApproval?: boolean;
      roomVisibility?: RetrievalRoomVisibilityContext;
    },
  ): Promise<ContactProfileAccessResult> {
    return resolveContactProfileAccessWithDeps({
      memoryStore: this.memoryStore,
      sessionQuarantineFilter: this.sessionQuarantineFilter,
      profile,
      options,
    });
  }

  async captureTurnMemorySnapshot(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    scopeQuery?: MemoryScopeQuery,
    callerContext?: RetrievalCallerContext,
    retrievalMode?: RetrievalModeInput,
  ): Promise<TurnMemorySnapshot> {
    return captureTurnMemorySnapshotWithDeps(
      {
        contextText,
        channelId,
        trustLevel,
        channelMeta,
        canonicalContactId,
        turnBudgetCharacteristics,
        scopeQuery,
        callerContext,
        retrievalMode,
      },
      {
        memoryStore: this.memoryStore,
        embeddingService: this.embeddingService,
        retrievalThreshold: this.retrievalThreshold,
        resolveRetrievalBudget: turn => this.resolveRetrievalBudget(turn),
        resolveRoomVisibilityContext: (roomChannelId, roomChannelMeta, roomCanonicalContactId) => (
          this.resolveRoomVisibilityContext(roomChannelId, roomChannelMeta, roomCanonicalContactId, undefined)
        ),
        resolveContactProfileAccess: (profile, options) => this.resolveContactProfileAccess(profile, options),
        resolveEmotionalSnapshot: contactId => resolveEmotionalSnapshot(this.contactStore, contactId),
        collectContactEmotionalMemories: contactId => collectContactEmotionalMemories(this.memoryStore, contactId),
        collectProactiveRecallCandidates: (proactiveChannelId, proactiveContactId) => (
          collectProactiveRecallCandidates(this.memoryStore, proactiveChannelId, proactiveContactId)
        ),
        resolveEpisodicChains: episodicInput => this.resolveEpisodicChains(episodicInput),
        filterQuarantinedMemories: memories => filterQuarantinedMemories(this.sessionQuarantineFilter, memories),
        filterQuarantinedEpisodicChains: chains => (
          filterQuarantinedEpisodicChains(this.sessionQuarantineFilter, chains)
        ),
      },
    );
  }

  private finalizeRetrievalPromptBlock(input: {
    activeContextTarget?: ActiveMemoryRefreshTarget;
    profile?: ContactProfileArtifact;
    selectedForPrompt?: ScoredMemory[];
    emotionalSnapshot?: TurnMemorySnapshot['emotionalSnapshot'];
    emotionalContinuityMemories?: PurrMemory[];
    withheldSummary?: MemoryWithheldSummary;
    socialContext?: RetrievalSocialContext;
    contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
    episodicChains?: EpisodicRetrievalChain[];
    telemetry: RetrievalTelemetry;
  }): string {
    return finalizeRetrievalPromptBlockWithActiveContext({
      ...input,
      manifestSeed: buildManifestSeedFromTelemetry(input.telemetry),
    }, {
      activeMemoryContexts: this.activeMemoryContexts,
      eventBus: this.eventBus,
      isMemoryQuarantined: memory => isMemoryQuarantined(this.sessionQuarantineFilter, memory),
      filterQuarantinedMemories: memories => filterQuarantinedMemories(
        this.sessionQuarantineFilter,
        memories,
      ).memories,
      filterQuarantinedEpisodicChains: chains => filterQuarantinedEpisodicChains(
        this.sessionQuarantineFilter,
        chains,
      ),
      toErrorMessage,
    });
  }

  async retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: TurnMemorySnapshot,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    currentVAD?: RetrievalVADInput,
    scopeQuery?: MemoryScopeQuery,
    callerContext?: RetrievalCallerContext,
    retrievalMode?: RetrievalModeInput,
    conversationScope?: ConversationScope,
    activeContextTarget?: ActiveMemoryRefreshTarget,
  ): Promise<string> {
    const hasDirectRetrievalContext = callerContext !== undefined || retrievalMode !== undefined;
    const effectiveCallerContext = hasDirectRetrievalContext
      ? callerContext
      : turnSnapshot?.callerContext;
    const effectiveRetrievalMode = hasDirectRetrievalContext
      ? retrievalMode
      : turnSnapshot?.retrievalMode;
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const effectiveBudgetTurn = turnBudgetCharacteristics ?? {
      channelId,
      ...(channelMeta?.isDirectMessage !== undefined ? { isDirectMessage: channelMeta.isDirectMessage } : {}),
      messageText: contextText,
    };
    const budget = this.resolveRetrievalBudget(effectiveBudgetTurn);
    const limit = budget.estimatedCount;
    const effectiveTrust = trustLevel ?? 'regular';
    const channelDisclosure = classifyChannelDisclosure(channelId, channelMeta);
    const { channelPrivacy, broadcast } = channelDisclosure;
    const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
    const operatorApproval = visibilityScope === 'approved_private_context';
    const roomVisibility = await this.resolveRoomVisibilityContext(
      channelId,
      channelMeta,
      canonicalContactId,
      conversationScope,
    );
    const socialContext = canonicalContactId
      ? await resolveRetrievalSocialContext(this.contactStore, canonicalContactId, effectiveTrust, channelPrivacy)
      : undefined;
    const telemetry: RetrievalTelemetry = {
      channelId,
      count: 0,
      reason: 'ok',
      retrievalSource: 'embedding',
      trustLevel: effectiveTrust,
      channelVisibility: channelPrivacy,
      candidateCount: 0,
      semanticCandidateCount: 0,
      lexicalCandidateCount: 0,
      rankedCount: 0,
      returnedCount: 0,
      retrievalLimit: limit,
      retrievalThreshold: this.retrievalThreshold,
      retrievalBudgetPct: budget.budgetPct,
      retrievalTokenBudget: budget.tokenBudget,
      retrievalLimitMode: budget.mode,
      visibilityScope,
      operatorApproval,
      provenanceRefs: [],
      profileIncluded: false,
      emotionalSnapshotIncluded: false,
      emotionalContinuityCount: 0,
    };
    const rawProfile = turnSnapshot?.profile
      ? cloneContactProfileArtifact(turnSnapshot.profile)
      : canonicalContactId
        ? await this.memoryStore.getContactProfile(canonicalContactId)
        : undefined;
    const profileAccess = await this.resolveContactProfileAccess(rawProfile, {
      trustLevel: effectiveTrust,
      channelPrivacy,
      broadcast,
      channelMeta,
      canonicalContactId,
      operatorApproval,
      roomVisibility,
    });
    const profile = profileAccess.profile;
    telemetry.profileIncluded = !!profile;
    telemetry.provenanceRefs = collectContactProfileProvenanceRefs(profile);
    const emotionalSnapshot = turnSnapshot?.emotionalSnapshot
      ? cloneEmotionalSnapshot(turnSnapshot.emotionalSnapshot)
      : canonicalContactId
        ? await resolveEmotionalSnapshot(this.contactStore, canonicalContactId)
        : undefined;
      telemetry.emotionalSnapshotIncluded = !!emotionalSnapshot;
      const contactQuarantine = filterQuarantinedMemories(
        this.sessionQuarantineFilter,
        turnSnapshot?.contactEmotionalMemories.map(cloneMemory)
        ?? (canonicalContactId ? await collectContactEmotionalMemories(this.memoryStore, canonicalContactId) : []),
      );
      const contactEmotionalSource = contactQuarantine.memories;
      const proactiveQuarantine = filterQuarantinedMemories(
        this.sessionQuarantineFilter,
        turnSnapshot?.proactiveCandidates.map(cloneMemory) ?? [],
      );
      const proactiveSource = proactiveQuarantine.memories;
      const rawEpisodicChains = Array.isArray(turnSnapshot?.episodicChains)
        ? turnSnapshot.episodicChains.map(cloneEpisodicRetrievalChain)
        : await this.resolveEpisodicChains({
          contextText,
        channelId,
        trustLevel: effectiveTrust,
        channelDisclosure,
          canonicalContactId,
          scopeQuery: normalizedScopeQuery,
        });
      const episodicChains = filterQuarantinedEpisodicChains(this.sessionQuarantineFilter, rawEpisodicChains);
    const episodicEpisodeCount = countEpisodicChainEpisodes(episodicChains);
    telemetry.episodicChainCount = episodicChains.length;
    telemetry.episodicEpisodeCount = episodicEpisodeCount;
      const snapshotWithheldSummary = cloneMemoryWithheldSummary(turnSnapshot?.withheldSummary);
      let withheldSummary = mergeMemoryWithheldSummaries(
        snapshotWithheldSummary,
        profileAccess.withheldSummary,
        contactQuarantine.summary,
        proactiveQuarantine.summary,
      );

    const emptySelectedIds = new Set<string>();
    const fallbackEmotionalContinuity = canonicalContactId
      ? await collectEmotionalContinuityMemories(
        this.memoryStore,
        canonicalContactId,
        effectiveTrust,
        channelDisclosure,
        emptySelectedIds,
        operatorApproval,
        channelMeta,
        contactEmotionalSource,
        roomVisibility,
        memories => filterQuarantinedMemories(this.sessionQuarantineFilter, memories).memories,
      )
      : [];
    telemetry.emotionalContinuityCount = fallbackEmotionalContinuity.length;

    if (!contextText.trim()) {
      if (!snapshotWithheldSummary) {
        withheldSummary = mergeMemoryWithheldSummaries(
          withheldSummary,
          summarizeWithheldMemories(
            contactEmotionalSource,
            {
            trustLevel: effectiveTrust,
            channelPrivacy,
            broadcast,
            channelMeta,
            canonicalContactId,
            operatorApproval,
            roomVisibility,
            },
          ).summary,
        );
      }
      telemetry.reason = 'empty_input';
      applyWithheldSummaryTelemetry(telemetry, withheldSummary);
      await this.emitRetrievalTelemetry(telemetry);
      return this.finalizeRetrievalPromptBlock({
        activeContextTarget,
        profile,
        emotionalSnapshot,
        emotionalContinuityMemories: fallbackEmotionalContinuity,
        withheldSummary,
        socialContext,
        episodicChains,
        telemetry,
      });
    }

    try {
        let semanticMemories = (turnSnapshot?.semanticCandidates.map(cloneScoredMemory) ?? [])
          .filter(memory => !isInternalMemoryArtifact(memory));
        if (semanticMemories.length === 0 && !turnSnapshot) {
        const embedding = await this.embeddingService.embed(contextText);
        const candidateLimit = Math.max(40, limit * 4);
        semanticMemories = await this.memoryStore.searchByEmbedding(
          embedding,
          this.retrievalThreshold,
          candidateLimit,
          normalizedScopeQuery,
          );
          semanticMemories = semanticMemories.filter(memory => !isInternalMemoryArtifact(memory));
        }
        const semanticQuarantine = filterQuarantinedMemories(this.sessionQuarantineFilter, semanticMemories);
        semanticMemories = semanticQuarantine.memories;
        if (!turnSnapshot) {
          const recentLexicalCandidates = await collectRecentLexicalMemoryCandidates({
          memoryStore: this.memoryStore,
          contextText,
          existingIds: new Set(semanticMemories.map(memory => memory.id)),
          scopeQuery: normalizedScopeQuery,
          });
          semanticMemories = mergeScoredMemoryCandidates(semanticMemories, recentLexicalCandidates);
          const mergedSemanticQuarantine = filterQuarantinedMemories(this.sessionQuarantineFilter, semanticMemories);
          semanticMemories = mergedSemanticQuarantine.memories;
          withheldSummary = mergeMemoryWithheldSummaries(
            withheldSummary,
            mergedSemanticQuarantine.summary,
          );
        }
        withheldSummary = mergeMemoryWithheldSummaries(withheldSummary, semanticQuarantine.summary);
        telemetry.semanticCandidateCount = semanticMemories.length;

      let memories = semanticMemories;
      if (semanticMemories.length === 0) {
          const lexicalMemories = (turnSnapshot?.lexicalCandidates.map(cloneScoredMemory)
            ?? await this.memoryStore.searchByText(
              contextText,
            Math.max(40, limit * 4),
              normalizedScopeQuery,
            )).filter(memory => !isInternalMemoryArtifact(memory));
          const lexicalQuarantine = filterQuarantinedMemories(this.sessionQuarantineFilter, lexicalMemories);
          const visibleLexicalMemories = lexicalQuarantine.memories;
          withheldSummary = mergeMemoryWithheldSummaries(withheldSummary, lexicalQuarantine.summary);
          telemetry.lexicalCandidateCount = visibleLexicalMemories.length;
          if (visibleLexicalMemories.length > 0) {
            memories = visibleLexicalMemories;
            telemetry.retrievalSource = 'lexical_fallback';
          log.info('Retrieval: lexical fallback activated after semantic miss', {
            channelId,
            trustLevel: effectiveTrust,
            threshold: this.retrievalThreshold,
            semanticCandidates: 0,
            lexicalCandidates: lexicalMemories.length,
            queryLength: contextText.length,
          });
        } else {
            if (!snapshotWithheldSummary) {
              withheldSummary = mergeMemoryWithheldSummaries(
                withheldSummary,
                summarizeWithheldMemories(
                  [...contactEmotionalSource, ...proactiveSource],
                  {
                    trustLevel: effectiveTrust,
                    channelPrivacy,
                    broadcast,
                    channelMeta,
                    canonicalContactId,
                    operatorApproval,
                    roomVisibility,
                  },
                ).summary,
              );
            }
          telemetry.reason = 'no_candidates';
          applyWithheldSummaryTelemetry(telemetry, withheldSummary);
          if (episodicChains.length > 0) {
            telemetry.reason = 'ok';
            telemetry.returnedCount = episodicEpisodeCount;
            telemetry.count = episodicEpisodeCount;
            telemetry.selectedTypes = { episodic: episodicEpisodeCount };
            telemetry.provenanceRefs = mergeProvenanceRefs(
              telemetry.provenanceRefs,
              collectEpisodicChainProvenanceRefs(episodicChains),
            );
            await this.emitRetrievalTelemetry(telemetry);
            return this.finalizeRetrievalPromptBlock({
              activeContextTarget,
              profile,
              emotionalSnapshot,
              emotionalContinuityMemories: fallbackEmotionalContinuity,
              withheldSummary,
              socialContext,
              episodicChains,
              telemetry,
            });
          }
          log.info('Retrieval: no candidates (semantic + lexical)', {
            channelId,
            trustLevel: effectiveTrust,
            threshold: this.retrievalThreshold,
            semanticCandidates: 0,
            lexicalCandidates: 0,
            queryLength: contextText.length,
          });
          await this.emitRetrievalTelemetry(telemetry);
          return this.finalizeRetrievalPromptBlock({
            activeContextTarget,
            profile,
            emotionalSnapshot,
            emotionalContinuityMemories: fallbackEmotionalContinuity,
            withheldSummary,
            socialContext,
            episodicChains,
            telemetry,
          });
        }
      }
      telemetry.candidateCount = memories.length;
      if (!snapshotWithheldSummary) {
        withheldSummary = mergeMemoryWithheldSummaries(
          withheldSummary,
          summarizeWithheldMemories(
            [...memories, ...contactEmotionalSource, ...proactiveSource],
            {
              trustLevel: effectiveTrust,
              channelPrivacy,
              broadcast,
              channelMeta,
              canonicalContactId,
              operatorApproval,
              roomVisibility,
            },
          ).summary,
        );
      }
      applyWithheldSummaryTelemetry(telemetry, withheldSummary);

      if (memories.length > 0) {
        telemetry.topSimilarity = memories[0].similarity;
        telemetry.bottomSimilarity = memories[memories.length - 1].similarity;
      }

        const diagnostics: RetrievalDecisionDiagnostics = {
          candidateCount: memories.length,
          policyAllowedCount: 0,
          rejectedBySessionQuarantine: telemetry.sessionQuarantineRejectedCount ?? 0,
          rejectedByRoomVisibility: 0,
        rejectedByContactScope: 0,
        rejectedBySensitivity: 0,
        rejectedByPolicy: 0,
        rejectedByPolicyReasonTag: {},
        rejectedByScore: 0,
        selectedCount: 0,
        topSelected: [],
        contradictionAdjustedCount: 0,
        lowConfidenceSuppressedCount: 0,
        explicitQueryOverrideCount: 0,
      };
      const policyAllowed: Array<PurrMemory & { similarity: number }> = [];

      for (const memory of memories) {
        if (normalizedScopeQuery?.mode === 'only' && !memoryMatchesScopeQuery(memory, normalizedScopeQuery)) {
          continue;
        }
        const accessDecision = evaluateRetrievalAccessDecision(memory, {
          trustLevel: effectiveTrust,
          channelPrivacy,
          broadcast,
          channelMeta,
          canonicalContactId,
          operatorApproval,
          roomVisibility,
        });
        if (!accessDecision.allowed) {
          if (accessDecision.rejectionKind === 'room_visibility') {
            diagnostics.rejectedByRoomVisibility++;
          } else if (accessDecision.rejectionKind === 'contact_scope') {
            diagnostics.rejectedByContactScope++;
          } else if (accessDecision.rejectionKind === 'sensitivity') {
            diagnostics.rejectedBySensitivity++;
          } else if (accessDecision.rejectionKind === 'policy' && accessDecision.withheldReason) {
            diagnostics.rejectedByPolicy++;
            diagnostics.rejectedByPolicyReasonTag[accessDecision.withheldReason] = (
              diagnostics.rejectedByPolicyReasonTag[accessDecision.withheldReason] ?? 0
            ) + 1;
          } else {
            diagnostics.rejectedByPolicy++;
          }
          continue;
        }

        policyAllowed.push(memory);
      }
      diagnostics.policyAllowedCount = policyAllowed.length;
      telemetry.policyAllowedCount = diagnostics.policyAllowedCount;
      telemetry.roomVisibilityRejectedCount = diagnostics.rejectedByRoomVisibility;
      telemetry.contactScopeRejectedCount = diagnostics.rejectedByContactScope;
      telemetry.sensitivityRejectedCount = diagnostics.rejectedBySensitivity;
      telemetry.policyRejectedCount = diagnostics.rejectedByPolicy;
      telemetry.policyRejectedReasonTags = diagnostics.rejectedByPolicyReasonTag;

      if (policyAllowed.length === 0) {
        if (episodicChains.length > 0) {
          telemetry.reason = 'ok';
          telemetry.returnedCount = episodicEpisodeCount;
          telemetry.count = episodicEpisodeCount;
          telemetry.selectedTypes = { episodic: episodicEpisodeCount };
          telemetry.provenanceRefs = mergeProvenanceRefs(
            telemetry.provenanceRefs,
            collectEpisodicChainProvenanceRefs(episodicChains),
          );
          await this.emitRetrievalTelemetry(telemetry);
          return this.finalizeRetrievalPromptBlock({
            activeContextTarget,
            profile,
            emotionalSnapshot,
            emotionalContinuityMemories: fallbackEmotionalContinuity,
            withheldSummary,
            socialContext,
            episodicChains,
            telemetry,
          });
        }
        telemetry.reason = 'trust_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        log.info('Retrieval: all candidates filtered by trust policy', {
          channelId,
          trustLevel: effectiveTrust,
          channelPrivacy,
          candidateCount: diagnostics.candidateCount,
          rejectedByRoomVisibility: diagnostics.rejectedByRoomVisibility,
            rejectedByContactScope: diagnostics.rejectedByContactScope,
            rejectedBySessionQuarantine: diagnostics.rejectedBySessionQuarantine,
            rejectedBySensitivity: diagnostics.rejectedBySensitivity,
          rejectedByPolicy: diagnostics.rejectedByPolicy,
          rejectedByPolicyReasonTags: diagnostics.rejectedByPolicyReasonTag,
        });
        return this.finalizeRetrievalPromptBlock({
          activeContextTarget,
          profile,
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
          withheldSummary,
          socialContext,
          episodicChains,
          telemetry,
        });
      }

      // Score all policy-allowed memories. Instead of filtering out score==0
      // entirely, guarantee at least SCORE_GUARANTEE_MIN_K top-similarity
      // memories surface even when privacy penalties zero their composite score.
      // This prevents "water in the well, bucket has holes" retrieval gaps.
      const allScored = policyAllowed
        .map(memory => ({
          memory,
          ...computeRetrievalScore(memory, contextText, {
            currentVAD,
            moodCongruenceWeight: this.moodCongruenceWeight,
            scopeQuery: normalizedScopeQuery,
            callerContext: effectiveCallerContext,
            retrievalMode: effectiveRetrievalMode,
          }),
        }))
        .filter(item => !item.retrievalModeExcluded)
        .sort((a, b) => b.score - a.score);
      const rerankDecision = await applyCompositionalRetrievalRankingWithPolicy({
        contextText,
        channelId,
        candidates: allScored,
        runtimeConfig: this.runtimeConfig,
        llmProvider: this.llmProvider,
      });
      const scoredCandidates = await applySocialContextRankingAdjustments(
        this.contactStore,
        rerankDecision.ranked ?? allScored,
        contextText,
        socialContext,
      );
      telemetry.compositionalMode = rerankDecision.mode;
      telemetry.compositionalCandidateCount = rerankDecision.candidateCount;
      telemetry.compositionalEvaluationBatchCount = rerankDecision.evaluationBatchCount;
      telemetry.compositionalFinalistCount = rerankDecision.finalistCount;

      diagnostics.contradictionAdjustedCount = scoredCandidates
        .filter(item => item.contradictionPenaltyMultiplier < 1)
        .length;
      diagnostics.lowConfidenceSuppressedCount = scoredCandidates
        .filter(item => item.lowConfidenceSingleSourceSuppressed)
        .length;
      diagnostics.explicitQueryOverrideCount = scoredCandidates
        .filter(item => item.explicitlyQueried && item.evidenceSupport < 0.5)
        .length;
      telemetry.evidenceSupportAverage = scoredCandidates.length > 0
        ? Number(
          (
            scoredCandidates.reduce((sum, item) => sum + item.evidenceSupport, 0)
            / scoredCandidates.length
          ).toFixed(4),
        )
        : 0;
      telemetry.contradictionAdjustedCount = diagnostics.contradictionAdjustedCount;
      telemetry.lowConfidenceSuppressedCount = diagnostics.lowConfidenceSuppressedCount;
      telemetry.explicitQueryOverrideCount = diagnostics.explicitQueryOverrideCount;

      const scoreGuarantee = applyScoreGuarantee(scoredCandidates);
      diagnostics.rejectedByScore = scoreGuarantee.rejectedByScore;
      telemetry.scoreRejectedCount = diagnostics.rejectedByScore;
      const scoreGuaranteedCount = scoreGuarantee.scoreGuaranteedCount;
      telemetry.scoreGuaranteedCount = scoreGuaranteedCount;

      const scored = scoreGuarantee.scored;

      const ranked = scored;
      telemetry.rankedCount = ranked.length;

      if (ranked.length > 0) {
        telemetry.topScore = ranked[0].score;
        telemetry.bottomScore = ranked[ranked.length - 1].score;
      }

      if (ranked.length === 0) {
        if (episodicChains.length > 0) {
          telemetry.reason = 'ok';
          telemetry.returnedCount = episodicEpisodeCount;
          telemetry.count = episodicEpisodeCount;
          telemetry.selectedTypes = { episodic: episodicEpisodeCount };
          telemetry.provenanceRefs = mergeProvenanceRefs(
            telemetry.provenanceRefs,
            collectEpisodicChainProvenanceRefs(episodicChains),
          );
          await this.emitRetrievalTelemetry(telemetry);
          return this.finalizeRetrievalPromptBlock({
            activeContextTarget,
            profile,
            emotionalSnapshot,
            emotionalContinuityMemories: fallbackEmotionalContinuity,
            withheldSummary,
            socialContext,
            episodicChains,
            telemetry,
          });
        }
        telemetry.reason = 'score_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        log.info('Retrieval: all policy-allowed memories scored zero', {
          channelId,
          trustLevel: effectiveTrust,
          policyAllowedCount: diagnostics.policyAllowedCount,
        });
        return this.finalizeRetrievalPromptBlock({
          activeContextTarget,
          profile,
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
          withheldSummary,
          socialContext,
          episodicChains,
          telemetry,
        });
      }

      const guaranteedSelectionFloor = resolveGuaranteedSelectionFloor(ranked.length, scoreGuaranteedCount);
      const selection = selectWithinRelevanceAndTokenBudget(
        ranked,
        budget.tokenBudget,
        guaranteedSelectionFloor,
      );
      const selected = selection.selected;

      telemetry.returnedCount = selected.length + episodicEpisodeCount;
      telemetry.selectionStopReason = selection.stopReason;
      telemetry.selectionScoreFloor = selection.relevanceScoreFloor;
      telemetry.relevanceStoppedCount = selection.relevanceStoppedCount;
      telemetry.budgetCappedCount = selection.budgetCappedCount;
      telemetry.selectedTypes = countSelectedMemoryTypes(selected);
      if (episodicEpisodeCount > 0) {
        const previousEpisodicCount = Object.entries(telemetry.selectedTypes)
          .find(([type]) => type === 'episodic')?.[1] ?? 0;
        telemetry.selectedTypes = {
          ...telemetry.selectedTypes,
          episodic: previousEpisodicCount + episodicEpisodeCount,
        };
      }
      diagnostics.selectedCount = selected.length;
      diagnostics.topSelected = selected.slice(0, 3).map((item) => ({
        id: item.memory.id,
        score: Number(item.score.toFixed(4)),
        baseScore: Number(item.baseScore.toFixed(4)),
        evidenceSupport: Number(item.evidenceSupport.toFixed(4)),
        contradictionPenaltyMultiplier: Number(item.contradictionPenaltyMultiplier.toFixed(4)),
        lowConfidenceSingleSourceSuppressed: item.lowConfidenceSingleSourceSuppressed,
        explicitlyQueried: item.explicitlyQueried,
        privacyRisk: Number(item.privacyRisk.toFixed(4)),
        privacyPenalty: Number(item.privacyPenalty.toFixed(4)),
        sensitivity: item.memory.sensitivity,
      }));

      // INFO-level retrieval trace: operators can see the full pipeline funnel
      // without needing debug logging enabled.
      log.info('Retrieval trace', {
        channelId,
        trustLevel: effectiveTrust,
        channelPrivacy,
        retrievalSource: telemetry.retrievalSource,
        semanticCandidates: telemetry.semanticCandidateCount,
        lexicalCandidates: telemetry.lexicalCandidateCount,
        episodicChains: telemetry.episodicChainCount,
        episodicEpisodes: telemetry.episodicEpisodeCount,
        pipeline: `${diagnostics.candidateCount} candidates -> ${diagnostics.policyAllowedCount} policy-allowed -> ${scored.length} scored -> ${ranked.length} ranked -> ${selected.length} selected + ${episodicEpisodeCount} episodic episodes`,
        selectionStopReason: telemetry.selectionStopReason,
        selectionScoreFloor: telemetry.selectionScoreFloor,
        relevanceStoppedCount: telemetry.relevanceStoppedCount,
        budgetCappedCount: telemetry.budgetCappedCount,
        rejectedByContactScope: diagnostics.rejectedByContactScope,
        rejectedBySensitivity: diagnostics.rejectedBySensitivity,
        rejectedByPolicy: diagnostics.rejectedByPolicy,
        rejectedByPolicyReasonTags: diagnostics.rejectedByPolicyReasonTag,
        withheldCount: telemetry.withheldCount,
        withheldReasonCounts: telemetry.withheldReasonCounts,
        withheldRelevanceBands: telemetry.withheldRelevanceBands,
        rejectedByRoomVisibility: diagnostics.rejectedByRoomVisibility,
        rejectedByScore: diagnostics.rejectedByScore,
        scoreGuaranteedCount,
        evidenceSupportAverage: telemetry.evidenceSupportAverage,
        contradictionAdjustedCount: diagnostics.contradictionAdjustedCount,
        lowConfidenceSuppressedCount: diagnostics.lowConfidenceSuppressedCount,
        explicitQueryOverrideCount: diagnostics.explicitQueryOverrideCount,
        budgetMode: budget.mode,
        tokenBudget: budget.tokenBudget,
        compositionalMode: telemetry.compositionalMode,
        compositionalCandidateCount: telemetry.compositionalCandidateCount,
        compositionalEvaluationBatchCount: telemetry.compositionalEvaluationBatchCount,
        compositionalFinalistCount: telemetry.compositionalFinalistCount,
      });
      log.debug('Retrieval decision rationale', {
        trustLevel: effectiveTrust,
        channelPrivacy,
        ...diagnostics,
      });
      const selectedIds = new Set(selected.map(item => item.memory.id));
      const emotionalContinuityMemories = canonicalContactId
        ? await collectEmotionalContinuityMemories(
          this.memoryStore,
          canonicalContactId,
          effectiveTrust,
          channelDisclosure,
          selectedIds,
          operatorApproval,
          channelMeta,
          turnSnapshot?.contactEmotionalMemories,
          roomVisibility,
          memories => filterQuarantinedMemories(this.sessionQuarantineFilter, memories).memories,
        )
        : [];
      telemetry.emotionalContinuityCount = emotionalContinuityMemories.length;
      telemetry.provenanceRefs = mergeProvenanceRefs(
        telemetry.provenanceRefs,
        collectSelectedProvenanceRefs(
          selected,
          telemetry.retrievalSource,
        ),
        collectEpisodicChainProvenanceRefs(episodicChains),
      );
      const selectedForPrompt = await attachEvolutionChains(
        this.memoryStore,
        selected,
        {
          contextText,
          trustLevel: effectiveTrust,
          channelPrivacy,
          broadcast,
          channelMeta,
          canonicalContactId,
          operatorApproval,
          roomVisibility,
        },
        memory => isMemoryQuarantined(this.sessionQuarantineFilter, memory),
      );
      const selectedContactContextById = await buildSelectedContactContext(
        this.contactStore,
        selectedForPrompt,
        socialContext,
      );

      // Update access stats; fail closed if persistence fails.
      for (const s of selected) {
        try {
          await this.memoryStore.updateMemory(s.memory.id, {
            lastAccessed: Date.now(),
            accessCount: s.memory.accessCount + 1,
          });
        } catch (error) {
          throw new RetrievalIntegrityError(
            `Failed to update retrieval access stats for memory ${s.memory.id}`,
            {
              stage: 'selected_access_update',
              channelId,
              trustLevel: effectiveTrust,
              memoryId: s.memory.id,
            },
            error,
          );
        }
      }

      telemetry.count = selected.length + episodicEpisodeCount;
      telemetry.reason = 'ok';
      await this.emitRetrievalTelemetry(telemetry);
      return this.finalizeRetrievalPromptBlock({
        activeContextTarget,
        profile,
        selectedForPrompt,
        emotionalSnapshot,
        emotionalContinuityMemories,
        withheldSummary,
        socialContext,
        contactContextById: selectedContactContextById,
        episodicChains,
        telemetry,
      });
    } catch (error) {
      telemetry.reason = 'error';
      await this.emitRetrievalTelemetry(telemetry);
      const wrapped = error instanceof RetrievalIntegrityError
        ? error
        : new RetrievalIntegrityError(
          'Memory retrieval failed',
          {
            stage: 'retrieve',
            channelId,
            trustLevel: effectiveTrust,
          },
          error,
        );
      log.error('Retrieval integrity failure', {
        context: wrapped.context,
        error: toErrorMessage(wrapped),
        cause: toErrorMessage(wrapped.cause),
      });
      throw wrapped;
    }
  }

  async retrieveProactiveRecall(
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnSnapshot?: TurnMemorySnapshot,
    _turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    _scopeQuery?: MemoryScopeQuery,
  ): Promise<string> {
    return retrieveProactiveRecallWithDeps({
      memoryStore: this.memoryStore,
      sessionQuarantineFilter: this.sessionQuarantineFilter,
      proactiveRecallProbability: this.proactiveRecallProbability,
      proactiveRecallMinTurnsBetween: this.proactiveRecallMinTurnsBetween,
      proactiveTurnCounter: this.proactiveTurnCounter,
      lastProactiveRecallTurn: this.lastProactiveRecallTurn,
      setProactiveTurnCounter: value => {
        this.proactiveTurnCounter = value;
      },
      setLastProactiveRecallTurn: value => {
        this.lastProactiveRecallTurn = value;
      },
      resolveRoomVisibilityContext: (roomChannelId, roomChannelMeta, roomCanonicalContactId) => (
        this.resolveRoomVisibilityContext(roomChannelId, roomChannelMeta, roomCanonicalContactId, undefined)
      ),
      createAccessUpdateError: (memoryId, effectiveTrust, error) => new RetrievalIntegrityError(
        `Failed to update proactive recall access stats for memory ${memoryId}`,
        {
          stage: 'proactive_access_update',
          channelId,
          trustLevel: effectiveTrust,
          memoryId,
        },
        error,
      ),
      logIntegrityFailure: (wrapped, cause) => {
        log.error('Proactive recall integrity failure', {
          context: wrapped instanceof RetrievalIntegrityError ? wrapped.context : undefined,
          error: toErrorMessage(wrapped),
          cause: toErrorMessage(cause),
        });
      },
      channelId,
      trustLevel,
      channelMeta,
      canonicalContactId,
      turnSnapshot,
    });
  }

  private async resolveEpisodicChains(input: {
    contextText: string;
    channelId: string;
    trustLevel: TrustLevel;
    channelDisclosure: ReturnType<typeof classifyChannelDisclosure>;
    canonicalContactId?: string;
    scopeQuery?: MemoryScopeQuery;
  }): Promise<EpisodicRetrievalChain[]> {
    return resolveEpisodicChainsWithDeps({
      episodicStore: this.episodicStore,
      sessionQuarantineFilter: this.sessionQuarantineFilter,
      request: input,
      wrapError: error => new RetrievalIntegrityError(
        'Episodic landmark retrieval failed',
        {
          stage: 'episodic_retrieve',
          channelId: input.channelId,
          trustLevel: input.trustLevel,
        },
        error,
      ),
    });
  }

  private async emitRetrievalTelemetry(telemetry: RetrievalTelemetry): Promise<void> {
    await emitRetrievalTelemetryWithDeps({
      runtimeConfig: this.runtimeConfig,
      telemetryEnabled: this.telemetryEnabled,
      costTelemetry: this.costTelemetry,
      telemetry,
    });
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampTurnFrequency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

/** Exported for test access. */
export const __retrieval_internals = {
  SCORE_GUARANTEE_MIN_K,
  SCORE_GUARANTEE_FLOOR,
} as const;
