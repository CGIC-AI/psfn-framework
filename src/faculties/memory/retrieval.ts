import type {
  MemoryProvider,
  LLMProviderPort,
  RetrievalVADInput,
} from '../../core/agent/contracts.js';
import type { EmbeddingProviderPort } from '../../shared/contracts/embedding-provider.js';
import { MemorySubjectAuthorizationDeniedError } from '../../shared/contracts/memory-subject.js';
import { createHash } from 'node:crypto';
import {
  createTurnRetrievalQueryEmbedding as createTurnRetrievalQueryEmbeddingValue,
  type TurnRetrievalQueryEmbedding,
} from '../../shared/retrieval-query-embedding.js';
import { resolveEmbeddingProviderProvenanceFromConfig } from './embedding.js';
import {
  getRuntimeTrustPolicy,
  getRuntimeTrustPolicyRevision,
} from '../../system/trust/runtime-policy.js';
import { getRuntimeChannelEnvelopeLabelsRevision } from '../../system/trust/runtime-channel-labels.js';
import type {
  RecentContactShapeArtifact,
  EmbeddingSearchAuthorization,
  MemoryStorePort,
} from './memory-store-port.js';
import type {
  PurrMemory,
  MemoryScopeQuery,
  RetrievalAccessScope,
  RetrievalCallerContext,
  RetrievalModeInput,
} from './types.js';
import { MEMORY_CONFIG } from './types.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import {
  resolveMemoryRetrievalPolicy,
  type MemoryRetrievalPolicy,
} from '../../system/config/memory-retrieval-policy.js';
import {
  resolveMemoryPresentationProfile,
  type MemoryPresentationProfile,
} from '../../system/config/memory-presentation-profile.js';
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
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { ConversationScope } from '../../core/session/conversation-scope.js';
import type { TurnMemorySnapshot } from '../../core/turns/snapshot.js';
import {
  normalizeCostTelemetryPort,
  type CostTelemetryInput,
  type CostTelemetryPort,
} from '../../shared/telemetry/cost-telemetry-port.js';
import {
  cloneRecentContactShapeArtifact,
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
  type RecentContactShapeAccessResult,
  resolveRecentContactShapeAccess as resolveRecentContactShapeAccessWithDeps,
  resolveRoomVisibilityContext as resolveRoomVisibilityContextWithDeps,
} from './retrieval/access-context.js';
import { resolveAuthorizedRetrievalAccessScope } from './retrieval/access-scope.js';
import {
  cloneActiveMemorySnapshot,
  type ActiveMemoryRefreshLoop,
  type ActiveMemoryRefreshFingerprint,
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
  collectRecentContactShapeProvenanceRefs,
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
  type MemoryQuarantineCandidate,
  type MemorySessionQuarantineFilter,
} from './retrieval/session-quarantine.js';
import { isMemoryOwnedByCompanion } from './companion-provenance.js';
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
import {
  createSubjectAuthorizedMemoryStore,
  memorySubjectAccessContextFromCorrelation,
} from './subject-authorized-store.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import type {
  RetrievalContactContext,
  RetrievalDecisionDiagnostics,
  RetrievalSocialContext,
  RetrievalTelemetry,
  ScoredMemory,
} from './retrieval/types.js';
import type { RolledOutSessionBoundary } from '../../core/session/rolled-out-session-boundary.js';
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
  override readonly cause: unknown;

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
  memoryRetrievalPolicy?: MemoryRetrievalPolicy;
  memoryPresentationProfile?: MemoryPresentationProfile;
}

function isSubstrateConfig(config: MemoryRetrieverConfig | SubstrateConfig | undefined): config is SubstrateConfig {
  return !!config && typeof config === 'object' && 'defaultContextWindow' in config;
}

function activeMemoryRefreshFingerprintsEqual(
  left: ActiveMemoryRefreshFingerprint | undefined,
  right: ActiveMemoryRefreshFingerprint | undefined,
): boolean {
  return left !== undefined
    && right !== undefined
    && left.contextHash === right.contextHash
    && left.corpusVersion === right.corpusVersion
    && left.accessPolicyHash === right.accessPolicyHash;
}

interface ResolvedActiveMemoryRefreshCacheState {
  fingerprint?: ActiveMemoryRefreshFingerprint;
  accessPolicyHash?: string;
  roomVisibility?: RetrievalRoomVisibilityContext;
}

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
  private activeMemoryContexts: Map<string, ActiveMemoryState>;
  private activeMemoryRefreshLoops: Map<string, ActiveMemoryRefreshLoop>;
  private sessionQuarantineFilter: MemorySessionQuarantineFilter | null;
  private fallbackMemoryRetrievalPolicy: MemoryRetrievalPolicy | undefined;
  private fallbackMemoryPresentationProfile: MemoryPresentationProfile | undefined;
  private enforceSubjectAuthorization: boolean;
  private biographicalProjection: Pick<MemoryProvider, 'projectBiographicalContext'> | null;

  constructor(
    memoryStore: MemoryStorePort,
    embeddingService: EmbeddingProviderPort,
    config?: MemoryRetrieverConfig | SubstrateConfig,
    costTelemetry?: CostTelemetryInput,
    contactStore?: ContactStorePort | null,
    llmProvider?: LLMProviderPort | null,
    episodicStore?: EpisodicRetrievalStore | null,
    sessionQuarantineFilter?: MemorySessionQuarantineFilter | null,
    enforceSubjectAuthorization = false,
    biographicalProjection?: Pick<MemoryProvider, 'projectBiographicalContext'> | null,
  ) {
    this.memoryStore = memoryStore;
    this.embeddingService = embeddingService;
    this.costTelemetry = normalizeCostTelemetryPort(costTelemetry);
    if (isSubstrateConfig(config)) {
      this.runtimeConfig = config;
      this.fallbackMemoryRetrievalPolicy = undefined;
      this.fallbackMemoryPresentationProfile = undefined;
      this.fallbackBudgetConfig = null;
      this.retrievalThreshold = MEMORY_CONFIG.retrievalThreshold;
      this.moodCongruenceWeight = resolveMoodCongruenceWeight(config.moodCongruenceWeight);
      this.telemetryEnabled = config.memoryRetrievalTelemetryEnabled ?? true;
    } else {
      const retrieverConfig = config as MemoryRetrieverConfig | undefined;
      this.runtimeConfig = null;
      this.fallbackMemoryRetrievalPolicy = retrieverConfig?.memoryRetrievalPolicy;
      this.fallbackMemoryPresentationProfile = retrieverConfig?.memoryPresentationProfile;
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
    }
    this.contactStore = contactStore ?? null;
    this.llmProvider = llmProvider ?? null;
    this.episodicStore = episodicStore ?? null;
    this.sessionQuarantineFilter = sessionQuarantineFilter ?? null;
    this.enforceSubjectAuthorization = enforceSubjectAuthorization;
    this.biographicalProjection = biographicalProjection ?? null;
    this.activeMemoryContexts = new Map();
    this.activeMemoryRefreshLoops = new Map();
  }

  async projectBiographicalContext(
    request: Parameters<NonNullable<MemoryProvider['projectBiographicalContext']>>[0],
  ): Promise<Awaited<ReturnType<NonNullable<MemoryProvider['projectBiographicalContext']>>>> {
    const project = this.biographicalProjection?.projectBiographicalContext;
    if (!project) {
      return {
        promptSection: '',
        disclosureSources: [],
        admittedClaimIds: [],
        withheldCount: 0,
      };
    }
    return await project.call(this.biographicalProjection, request);
  }

  /**
   * Explicit authorization stance for the raw embedding search path (a27w.3).
   * When subject enforcement is on, `productMemoryStore` is the subject-
   * authorized projection and this asserts enforcement (so a raw store wired
   * here by mistake fails closed). When the retriever was explicitly constructed
   * without enforcement, this is the auditable system-internal opt-out.
   */
  private embeddingSearchAuthorization(): EmbeddingSearchAuthorization {
    return {
      authorization: this.enforceSubjectAuthorization
        ? 'subject-enforced'
        : 'bypass-system-internal',
    };
  }

  private productMemoryStore(canonicalContactId?: string): MemoryStorePort {
    if (!this.enforceSubjectAuthorization) return this.memoryStore;
    const context = memorySubjectAccessContextFromCorrelation(getRequestContext());
    return createSubjectAuthorizedMemoryStore(this.memoryStore, {
      ...context,
      ...(canonicalContactId ? { viewerContactId: canonicalContactId } : {}),
      includeCompanionPrivateRecallCandidates: Boolean(canonicalContactId),
      companionInternal: !canonicalContactId && context.companionInternal === true,
    });
  }

  private filterIneligibleMemories<T extends MemoryQuarantineCandidate>(
    memories: readonly T[],
  ): { memories: T[]; summary?: MemoryWithheldSummary; withheldIds: string[] } {
    const quarantine = filterQuarantinedMemories(this.sessionQuarantineFilter, memories);
    const owned: T[] = [];
    const withheldIds = new Set(quarantine.withheldIds);
    for (const memory of quarantine.memories) {
      if (isMemoryOwnedByCompanion(memory, this.runtimeConfig?.companionId)) {
        owned.push(memory);
      } else {
        withheldIds.add(memory.id);
      }
    }
    return {
      memories: owned,
      ...(quarantine.summary ? { summary: quarantine.summary } : {}),
      withheldIds: [...withheldIds],
    };
  }

  private isMemoryUnavailable(memory: MemoryQuarantineCandidate): boolean {
    return isMemoryQuarantined(this.sessionQuarantineFilter, memory)
      || !isMemoryOwnedByCompanion(memory, this.runtimeConfig?.companionId);
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
    const productStore = this.productMemoryStore(input.access.canonicalContactId);
    const result = await computeSharedBackground(
      {
        memoryStore: {
          getById: async (id) => {
            const memory = await productStore.getById(id);
            return memory && isMemoryOwnedByCompanion(memory, this.runtimeConfig?.companionId)
              ? memory
              : undefined;
          },
          getByIds: async ids => (await productStore.getByIds(ids)).filter(memory => (
            isMemoryOwnedByCompanion(memory, this.runtimeConfig?.companionId)
          )),
          listMemories: async options => (await productStore.listMemories(options)).filter(memory => (
            isMemoryOwnedByCompanion(memory, this.runtimeConfig?.companionId)
          )),
        },
        contactStore: this.contactStore,
      },
      {
        contactAId: input.contactAId,
        contactBId: input.contactBId,
        access: input.access,
        ...(input.limit !== undefined ? { limit: input.limit } : {}),
      },
    );
    return result;
  }

  private resolveRetrievalBudget(
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): ReturnType<typeof resolveMemoryRetrieverBudget> {
    return resolveMemoryRetrieverBudget(this.runtimeConfig, this.fallbackBudgetConfig, turnBudgetCharacteristics);
  }

  private resolveMemoryRetrievalPolicy(): MemoryRetrievalPolicy {
    return resolveMemoryRetrievalPolicy(
      this.runtimeConfig?.memoryRetrievalPolicy ?? this.fallbackMemoryRetrievalPolicy,
    );
  }

  private resolveMemoryPresentationProfile(): MemoryPresentationProfile {
    return resolveMemoryPresentationProfile(
      this.runtimeConfig?.memoryPresentationProfile ?? this.fallbackMemoryPresentationProfile,
    );
  }

  createTurnRetrievalQueryEmbedding(input: {
    turnId: string;
    requestId: string;
    companionId: string;
    channelId: string;
    canonicalContactId?: string;
    queryText: string;
  }): TurnRetrievalQueryEmbedding {
    if (!this.runtimeConfig) {
      throw new Error('Turn retrieval query embedding requires canonical runtime embedding configuration');
    }
    const provenance = resolveEmbeddingProviderProvenanceFromConfig(
      this.runtimeConfig,
      this.embeddingService.dims,
    );
    return createTurnRetrievalQueryEmbeddingValue({
      ...input,
      provenance,
      embed: text => this.embeddingService.embed(text),
    });
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

  async refreshActiveMemoryContext(request: ActiveMemoryContextRequest): Promise<ActiveMemoryContextSnapshot | null> {
    const stableRequest: ActiveMemoryContextRequest = {
      ...request,
      ...(request.channelMeta ? { channelMeta: { ...request.channelMeta } } : {}),
    };
    const identity = resolveActiveMemoryContextIdentity(stableRequest);
    const cacheState = await this.resolveActiveMemoryRefreshCacheState(stableRequest);
    const { fingerprint, accessPolicyHash, roomVisibility } = cacheState;
    const existing = this.activeMemoryRefreshLoops.get(identity.key);
    if (existing) {
      if (
        activeMemoryRefreshFingerprintsEqual(existing.runningFingerprint, fingerprint)
        || activeMemoryRefreshFingerprintsEqual(existing.latestWork?.fingerprint, fingerprint)
      ) {
        return existing.running;
      }
      existing.latestWork = {
        request: stableRequest,
        fingerprint,
        accessPolicyHash,
        roomVisibility,
      };
      return existing.running;
    }

    const loop: ActiveMemoryRefreshLoop = {
      ...(fingerprint ? { runningFingerprint: fingerprint } : {}),
      running: Promise.resolve(null),
    };
    loop.running = this.runActiveMemoryRefreshLoop(identity.key, {
      request: stableRequest,
      fingerprint,
      accessPolicyHash,
      roomVisibility,
    })
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
    initialWork: {
      request: ActiveMemoryContextRequest;
      fingerprint?: ActiveMemoryRefreshFingerprint;
      accessPolicyHash?: string;
      roomVisibility?: RetrievalRoomVisibilityContext;
    },
  ): Promise<ActiveMemoryContextSnapshot | null> {
    let nextWork: typeof initialWork | undefined = initialWork;
    let latestSnapshot: ActiveMemoryContextSnapshot | null = null;
    while (nextWork) {
      const activeLoop = this.activeMemoryRefreshLoops.get(key);
      if (activeLoop) {
        activeLoop.runningFingerprint = nextWork.fingerprint;
      }
      latestSnapshot = await this.performActiveMemoryRefresh(
        nextWork.request,
        nextWork.fingerprint,
        nextWork.accessPolicyHash,
        nextWork.roomVisibility,
      );
      const loop = this.activeMemoryRefreshLoops.get(key);
      nextWork = loop?.latestWork;
      if (loop) {
        delete loop.latestWork;
      }
    }
    return latestSnapshot;
  }

  private async performActiveMemoryRefresh(
    request: ActiveMemoryContextRequest,
    fingerprint: ActiveMemoryRefreshFingerprint | undefined,
    accessPolicyHash: string | undefined,
    roomVisibility: RetrievalRoomVisibilityContext | undefined,
  ): Promise<ActiveMemoryContextSnapshot | null> {
    const identity = resolveActiveMemoryContextIdentity(request);
    const existing = this.activeMemoryContexts.get(identity.key);
    if (
      existing?.snapshot.refreshStatus === 'ready'
      && activeMemoryRefreshFingerprintsEqual(existing.completedRefreshFingerprint, fingerprint)
    ) {
      return cloneActiveMemorySnapshot(existing.snapshot);
    }
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
          request.retrievalQueryEmbedding
            ? {
              value: request.retrievalQueryEmbedding,
              turnId: request.turnId ?? '',
              requestId: request.requestId ?? '',
              companionId: request.companionId ?? '',
            }
            : undefined,
          roomVisibility,
          request.rolledOutSessionBoundary,
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
          fingerprint,
          accessPolicyHash,
          roomVisibility,
        },
      );
      return cloneActiveMemorySnapshot(this.activeMemoryContexts.get(identity.key)?.snapshot ?? null);
    } catch (error) {
      return this.markActiveMemoryDegraded(identity.key, request.channelId, startedAt, error);
    }
  }

  private async resolveActiveMemoryRefreshCacheState(
    request: ActiveMemoryContextRequest,
  ): Promise<ResolvedActiveMemoryRefreshCacheState> {
    let accessPolicyHash: string | undefined;
    let roomVisibility: RetrievalRoomVisibilityContext | undefined;
    try {
      if (
        this.sessionQuarantineFilter
        && typeof this.sessionQuarantineFilter.getRetiredLogicalSessionIds !== 'function'
      ) {
        return {};
      }
      roomVisibility = await this.resolveRoomVisibilityContext(
        request.channelId,
        request.channelMeta,
        request.canonicalContactId,
        request.conversationScope,
      );
      const channelDisclosure = classifyChannelDisclosure(request.channelId, request.channelMeta);
      const visibilityScope = resolveBroadcastVisibilityScope(request.channelId, request.channelMeta)
        ?? 'non_broadcast';
      const conversationScope = request.conversationScope;
      const normalizedAccessState = {
        trustLevel: request.trustLevel ?? 'regular',
        channelId: request.channelId.trim(),
        canonicalContactId: request.canonicalContactId?.trim() || null,
        channelMeta: {
          isDirectMessage: request.channelMeta?.isDirectMessage ?? null,
          disclosureConsentGranted: request.channelMeta?.disclosureConsentGranted ?? null,
          privacyLevel: request.channelMeta?.privacyLevel ?? null,
          broadcastApprovalToken: request.channelMeta?.broadcastApprovalToken?.trim() || null,
        },
        channelDisclosure,
        visibilityScope,
        operatorApproval: visibilityScope === 'approved_private_context',
        roomVisibility: {
          currentChannelId: roomVisibility.currentChannelId.trim(),
          currentIsDirectMessage: roomVisibility.currentIsDirectMessage ?? null,
          canonicalContactRoomIds: [...(roomVisibility.canonicalContactRoomIds ?? [])]
            .map(roomId => roomId.trim())
            .filter(Boolean)
            .sort(),
        },
        conversationScope: conversationScope
          ? {
            kind: conversationScope.kind,
            key: conversationScope.key,
            channelId: conversationScope.channelId,
            envelope: conversationScope.envelope,
            recentSpeakers: conversationScope.recentSpeakers.map(speaker => ({
              authorId: speaker.authorId,
              name: speaker.name,
            })),
            ...(conversationScope.kind === 'dm'
              ? { contact: conversationScope.contact }
              : {
                roomName: conversationScope.roomName ?? null,
                memberCountHint: conversationScope.memberCountHint ?? null,
              }),
          }
          : null,
        retiredLogicalSessionIds: this.sessionQuarantineFilter
          ? [...this.sessionQuarantineFilter.getRetiredLogicalSessionIds!()]
            .map(sessionId => sessionId.trim())
            .filter(Boolean)
            .sort()
          : [],
        channelEnvelopeLabelsRevision: getRuntimeChannelEnvelopeLabelsRevision(),
        trustPolicyRevision: getRuntimeTrustPolicyRevision(),
        trustPolicy: getRuntimeTrustPolicy(),
        memoryRetrievalPolicy: this.resolveMemoryRetrievalPolicy(),
      };
      accessPolicyHash = createHash('sha256')
        .update(JSON.stringify(normalizedAccessState), 'utf8')
        .digest('hex');
    } catch (error) {
      log.debug('Active memory refresh cache disabled: access policy could not be fingerprinted safely', {
        channelId: request.channelId,
        error: toErrorMessage(error),
      });
      return {};
    }

    let corpusVersion: number | undefined;
    try {
      corpusVersion = await this.memoryStore.getRetrievalCorpusVersion?.();
    } catch (error) {
      log.debug('Active memory refresh cache disabled: corpus version is not safely readable', {
        channelId: request.channelId,
        error: toErrorMessage(error),
      });
      return { accessPolicyHash, roomVisibility };
    }
    if (!Number.isSafeInteger(corpusVersion) || (corpusVersion ?? -1) < 0) {
      return { accessPolicyHash, roomVisibility };
    }
    return {
      accessPolicyHash,
      roomVisibility,
      fingerprint: {
        contextHash: createHash('sha256').update(JSON.stringify({
          contextText: request.contextText,
          sessionChannelId: request.sessionChannelId?.trim() || null,
          rolledOutSessionBoundary: request.rolledOutSessionBoundary ?? null,
        }), 'utf8').digest('hex'),
        corpusVersion: corpusVersion!,
        accessPolicyHash,
      },
    };
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

  private async resolveRecentContactShapeAccess(
    recentContactShape: RecentContactShapeArtifact | undefined,
    options: {
      accessScope?: RetrievalAccessScope;
      trustLevel: TrustLevel;
      channelPrivacy: ChannelPrivacy;
      broadcast: boolean;
      channelMeta?: ChannelMeta;
      canonicalContactId?: string;
      operatorApproval?: boolean;
      roomVisibility?: RetrievalRoomVisibilityContext;
    },
    memoryStore: MemoryStorePort = this.memoryStore,
  ): Promise<RecentContactShapeAccessResult> {
    return resolveRecentContactShapeAccessWithDeps({
      memoryStore,
      sessionQuarantineFilter: this.sessionQuarantineFilter,
      recentContactShape,
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
    retrievalQueryEmbedding?: {
      value: TurnRetrievalQueryEmbedding;
      turnId: string;
      requestId: string;
      companionId: string;
    },
    roomVisibility?: RetrievalRoomVisibilityContext,
    rolledOutSessionBoundary?: RolledOutSessionBoundary,
  ): Promise<TurnMemorySnapshot> {
    const productMemoryStore = this.productMemoryStore(canonicalContactId);
    return captureTurnMemorySnapshotWithDeps(
      {
        contextText,
        channelId,
        ...(rolledOutSessionBoundary ? { rolledOutSessionBoundary } : {}),
        trustLevel,
        channelMeta,
        canonicalContactId,
        turnBudgetCharacteristics,
        scopeQuery,
        callerContext,
        retrievalMode,
        ...(retrievalQueryEmbedding ? { retrievalQueryEmbedding } : {}),
        ...(roomVisibility ? { roomVisibility } : {}),
      },
      {
        memoryStore: productMemoryStore,
        embeddingService: this.embeddingService,
        ...(this.runtimeConfig
          ? {
            embeddingProvenance: resolveEmbeddingProviderProvenanceFromConfig(
              this.runtimeConfig,
              this.embeddingService.dims,
            ),
          }
          : {}),
        retrievalThreshold: this.retrievalThreshold,
        embeddingSearchAuthorization: this.embeddingSearchAuthorization(),
        resolveMemoryRetrievalPolicy: () => this.resolveMemoryRetrievalPolicy(),
        resolveRetrievalBudget: turn => this.resolveRetrievalBudget(turn),
        resolveRoomVisibilityContext: (roomChannelId, roomChannelMeta, roomCanonicalContactId) => (
          this.resolveRoomVisibilityContext(roomChannelId, roomChannelMeta, roomCanonicalContactId, undefined)
        ),
        resolveRecentContactShapeAccess: (shape, options) => (
          this.resolveRecentContactShapeAccess(shape, options, productMemoryStore)
        ),
        resolveEmotionalSnapshot: contactId => resolveEmotionalSnapshot(this.contactStore, contactId),
        collectContactEmotionalMemories: contactId => collectContactEmotionalMemories(productMemoryStore, contactId),
        collectProactiveRecallCandidates: (proactiveChannelId, proactiveContactId) => (
          collectProactiveRecallCandidates(productMemoryStore, proactiveChannelId, proactiveContactId)
        ),
        resolveEpisodicChains: episodicInput => this.resolveEpisodicChains(episodicInput),
        filterQuarantinedMemories: memories => this.filterIneligibleMemories(memories),
        filterQuarantinedEpisodicChains: chains => (
          filterQuarantinedEpisodicChains(this.sessionQuarantineFilter, chains)
        ),
      },
    );
  }

  private finalizeRetrievalPromptBlock(input: {
    activeContextTarget?: ActiveMemoryRefreshTarget;
    recentContactShape?: RecentContactShapeArtifact;
    recentContactShapeSourceMemories?: PurrMemory[];
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
      memoryRetrievalPolicy: this.resolveMemoryRetrievalPolicy(),
      memoryPresentationProfile: this.resolveMemoryPresentationProfile(),
      eventBus: this.eventBus,
      isMemoryQuarantined: memory => this.isMemoryUnavailable(memory),
      filterQuarantinedMemories: memories => this.filterIneligibleMemories(memories).memories,
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
    const retrievalStartedAt = performance.now();
    const productMemoryStore = this.productMemoryStore(canonicalContactId);
    const hasDirectRetrievalContext = callerContext !== undefined || retrievalMode !== undefined;
    const effectiveCallerContext = hasDirectRetrievalContext
      ? callerContext
      : turnSnapshot?.callerContext;
    const effectiveRetrievalMode = hasDirectRetrievalContext
      ? retrievalMode
      : turnSnapshot?.retrievalMode;
    const effectiveAccessScope = resolveAuthorizedRetrievalAccessScope(
      channelId,
      effectiveCallerContext?.accessScope,
    );
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const effectiveBudgetTurn = turnBudgetCharacteristics ?? {
      channelId,
      ...(channelMeta?.isDirectMessage !== undefined ? { isDirectMessage: channelMeta.isDirectMessage } : {}),
      messageText: contextText,
    };
    const budget = this.resolveRetrievalBudget(effectiveBudgetTurn);
    const memoryRetrievalPolicy = this.resolveMemoryRetrievalPolicy();
    const limit = budget.estimatedCount;
    const effectiveTrust = trustLevel ?? 'regular';
    const channelDisclosure = classifyChannelDisclosure(channelId, channelMeta);
    const { channelPrivacy, broadcast } = channelDisclosure;
    const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
    const operatorApproval = visibilityScope === 'approved_private_context';
    const roomVisibility = activeContextTarget?.roomVisibility
      ?? await this.resolveRoomVisibilityContext(
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
      accessScope: effectiveAccessScope,
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
      recentContactShapeIncluded: false,
      emotionalSnapshotIncluded: false,
      emotionalContinuityCount: 0,
      embeddingCalls: 0,
      searchCalls: 0,
      stageTimingsMs: {},
    };
    const emitTelemetry = async (): Promise<void> => {
      telemetry.stageTimingsMs.total = Math.max(0, performance.now() - retrievalStartedAt);
      await this.emitRetrievalTelemetry(telemetry);
    };
    const rawRecentContactShape = turnSnapshot?.recentContactShape
      ? cloneRecentContactShapeArtifact(turnSnapshot.recentContactShape)
      : canonicalContactId
        ? await productMemoryStore.getRecentContactShape(canonicalContactId)
        : undefined;
    const shapeAccess = await this.resolveRecentContactShapeAccess(rawRecentContactShape, {
      accessScope: effectiveAccessScope,
      trustLevel: effectiveTrust,
      channelPrivacy,
      broadcast,
      channelMeta,
      canonicalContactId,
      operatorApproval,
      roomVisibility,
    }, productMemoryStore);
    const recentContactShape = shapeAccess.recentContactShape;
    const recentContactShapeSourceMemories = shapeAccess.authorizedSourceMemories;
    telemetry.recentContactShapeIncluded = !!recentContactShape;
    telemetry.provenanceRefs = collectRecentContactShapeProvenanceRefs(recentContactShape);
    const emotionalSnapshot = turnSnapshot?.emotionalSnapshot
      ? cloneEmotionalSnapshot(turnSnapshot.emotionalSnapshot)
      : canonicalContactId
        ? await resolveEmotionalSnapshot(this.contactStore, canonicalContactId)
        : undefined;
      telemetry.emotionalSnapshotIncluded = !!emotionalSnapshot;
      const contactQuarantine = this.filterIneligibleMemories(
        turnSnapshot?.contactEmotionalMemories.map(cloneMemory)
        ?? (canonicalContactId ? await collectContactEmotionalMemories(productMemoryStore, canonicalContactId) : []),
      );
      const contactEmotionalSource = contactQuarantine.memories;
      const proactiveQuarantine = this.filterIneligibleMemories(
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
        shapeAccess.withheldSummary,
        contactQuarantine.summary,
        proactiveQuarantine.summary,
      );

    const emptySelectedIds = new Set<string>();
    const fallbackEmotionalContinuity = canonicalContactId
      ? await collectEmotionalContinuityMemories(
        productMemoryStore,
        canonicalContactId,
        effectiveTrust,
        channelDisclosure,
        emptySelectedIds,
        operatorApproval,
        channelMeta,
        contactEmotionalSource,
        roomVisibility,
        memories => this.filterIneligibleMemories(memories).memories,
        effectiveAccessScope,
      )
      : [];
    telemetry.emotionalContinuityCount = fallbackEmotionalContinuity.length;
    telemetry.stageTimingsMs.preparation = Math.max(0, performance.now() - retrievalStartedAt);

    if (!contextText.trim()) {
      if (!snapshotWithheldSummary) {
        withheldSummary = mergeMemoryWithheldSummaries(
          withheldSummary,
          summarizeWithheldMemories(
            contactEmotionalSource,
            {
              accessScope: effectiveAccessScope,
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
      await emitTelemetry();
      return this.finalizeRetrievalPromptBlock({
        activeContextTarget,
        recentContactShape,
        recentContactShapeSourceMemories,
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
        const embeddingStartedAt = performance.now();
        telemetry.embeddingCalls += 1;
        const embedding = await this.embeddingService.embed(contextText);
        addRetrievalStageTiming(telemetry, 'embedding', embeddingStartedAt);
        const candidateLimit = Math.max(40, limit * 4);
        const vectorSearchStartedAt = performance.now();
        telemetry.searchCalls += 1;
        semanticMemories = await productMemoryStore.searchByEmbedding(
          embedding,
          this.retrievalThreshold,
          candidateLimit,
          normalizedScopeQuery,
          this.embeddingSearchAuthorization(),
          );
          addRetrievalStageTiming(telemetry, 'vector_search', vectorSearchStartedAt);
          semanticMemories = semanticMemories.filter(memory => !isInternalMemoryArtifact(memory));
        }
        const semanticQuarantine = this.filterIneligibleMemories(semanticMemories);
        semanticMemories = semanticQuarantine.memories;
        if (!turnSnapshot) {
          const recentLexicalStartedAt = performance.now();
          telemetry.searchCalls += 1;
          const recentLexicalCandidates = await collectRecentLexicalMemoryCandidates({
            memoryStore: productMemoryStore,
            contextText,
            existingIds: new Set(semanticMemories.map(memory => memory.id)),
            scopeQuery: normalizedScopeQuery,
            memoryRetrievalPolicy,
          });
          addRetrievalStageTiming(telemetry, 'lexical_search', recentLexicalStartedAt);
          semanticMemories = mergeScoredMemoryCandidates(semanticMemories, recentLexicalCandidates);
          const mergedSemanticQuarantine = this.filterIneligibleMemories(semanticMemories);
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
          const lexicalSearchStartedAt = performance.now();
          if (!turnSnapshot) telemetry.searchCalls += 1;
          const lexicalMemories = (turnSnapshot?.lexicalCandidates.map(cloneScoredMemory)
            ?? await productMemoryStore.searchByText(
              contextText,
            Math.max(40, limit * 4),
              normalizedScopeQuery,
            )).filter(memory => !isInternalMemoryArtifact(memory));
          addRetrievalStageTiming(telemetry, 'lexical_search', lexicalSearchStartedAt);
          const lexicalQuarantine = this.filterIneligibleMemories(lexicalMemories);
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
                    accessScope: effectiveAccessScope,
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
            await emitTelemetry();
            return this.finalizeRetrievalPromptBlock({
              activeContextTarget,
              recentContactShape,
              recentContactShapeSourceMemories,
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
          await emitTelemetry();
          return this.finalizeRetrievalPromptBlock({
            activeContextTarget,
            recentContactShape,
            recentContactShapeSourceMemories,
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
              accessScope: effectiveAccessScope,
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
        telemetry.topSimilarity = memories[0]?.similarity;
        telemetry.bottomSimilarity = memories[memories.length - 1]?.similarity;
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

      const policyFilterStartedAt = performance.now();
      for (const memory of memories) {
        if (normalizedScopeQuery?.mode === 'only' && !memoryMatchesScopeQuery(memory, normalizedScopeQuery)) {
          continue;
        }
        const accessDecision = evaluateRetrievalAccessDecision(memory, {
          accessScope: effectiveAccessScope,
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
      addRetrievalStageTiming(telemetry, 'policy_filter', policyFilterStartedAt);
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
          await emitTelemetry();
          return this.finalizeRetrievalPromptBlock({
            activeContextTarget,
            recentContactShape,
            recentContactShapeSourceMemories,
            emotionalSnapshot,
            emotionalContinuityMemories: fallbackEmotionalContinuity,
            withheldSummary,
            socialContext,
            episodicChains,
            telemetry,
          });
        }
        telemetry.reason = 'trust_filtered';
        await emitTelemetry();
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
          recentContactShape,
          recentContactShapeSourceMemories,
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
      const rankingStartedAt = performance.now();
      const allScored = policyAllowed
        .map(memory => ({
          memory,
          ...computeRetrievalScore(memory, contextText, {
            currentVAD,
            moodCongruenceWeight: this.moodCongruenceWeight,
            scopeQuery: normalizedScopeQuery,
            callerContext: effectiveCallerContext,
            retrievalMode: effectiveRetrievalMode,
            memoryRetrievalPolicy,
            taskKind: effectiveBudgetTurn.taskKind,
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
      addRetrievalStageTiming(telemetry, 'ranking', rankingStartedAt);
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

      const scoreGuarantee = applyScoreGuarantee(scoredCandidates, memoryRetrievalPolicy);
      diagnostics.rejectedByScore = scoreGuarantee.rejectedByScore;
      telemetry.scoreRejectedCount = diagnostics.rejectedByScore;
      const scoreGuaranteedCount = scoreGuarantee.scoreGuaranteedCount;
      telemetry.scoreGuaranteedCount = scoreGuaranteedCount;

      const scored = scoreGuarantee.scored;

      const ranked = scored;
      telemetry.rankedCount = ranked.length;

      if (ranked.length > 0) {
        telemetry.topScore = ranked[0]?.score;
        telemetry.bottomScore = ranked[ranked.length - 1]?.score;
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
          await emitTelemetry();
          return this.finalizeRetrievalPromptBlock({
            activeContextTarget,
            recentContactShape,
            recentContactShapeSourceMemories,
            emotionalSnapshot,
            emotionalContinuityMemories: fallbackEmotionalContinuity,
            withheldSummary,
            socialContext,
            episodicChains,
            telemetry,
          });
        }
        telemetry.reason = 'score_filtered';
        await emitTelemetry();
        log.info('Retrieval: all policy-allowed memories scored zero', {
          channelId,
          trustLevel: effectiveTrust,
          policyAllowedCount: diagnostics.policyAllowedCount,
        });
        return this.finalizeRetrievalPromptBlock({
          activeContextTarget,
          recentContactShape,
          recentContactShapeSourceMemories,
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
          withheldSummary,
          socialContext,
          episodicChains,
          telemetry,
        });
      }

      const selectionStartedAt = performance.now();
      const guaranteedSelectionFloor = resolveGuaranteedSelectionFloor(
        ranked.length,
        scoreGuaranteedCount,
        memoryRetrievalPolicy,
      );
      const selection = selectWithinRelevanceAndTokenBudget(
        ranked,
        budget.tokenBudget,
        guaranteedSelectionFloor,
        memoryRetrievalPolicy,
      );
      const selected = selection.selected;
      addRetrievalStageTiming(telemetry, 'selection', selectionStartedAt);

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
        accessScope: effectiveAccessScope,
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
      const enrichmentStartedAt = performance.now();
      const selectedIds = new Set(selected.map(item => item.memory.id));
      const emotionalContinuityMemories = canonicalContactId
        ? await collectEmotionalContinuityMemories(
          productMemoryStore,
          canonicalContactId,
          effectiveTrust,
          channelDisclosure,
          selectedIds,
          operatorApproval,
          channelMeta,
          turnSnapshot?.contactEmotionalMemories,
          roomVisibility,
          memories => this.filterIneligibleMemories(memories).memories,
          effectiveAccessScope,
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
        productMemoryStore,
        selected,
        {
          contextText,
          accessScope: effectiveAccessScope,
          trustLevel: effectiveTrust,
          channelPrivacy,
          broadcast,
          channelMeta,
          canonicalContactId,
          operatorApproval,
          roomVisibility,
        },
        memory => this.isMemoryUnavailable(memory),
      );
      const selectedContactContextById = await buildSelectedContactContext(
        this.contactStore,
        selectedForPrompt,
        socialContext,
      );
      addRetrievalStageTiming(telemetry, 'enrichment', enrichmentStartedAt);

      // Update access stats; fail closed if persistence fails.
      //
      // One exception: a subject-authorization refusal. These counters are
      // bookkeeping on memories this retrieval already selected, scored and
      // rendered into the prompt, so the access decision has been made
      // upstream. Memories whose subject classification is `unattributed` or
      // `ambiguous` are legitimately recallable but are outside the *mutation*
      // authorization set, and treating that refusal as fatal discards the
      // entire active memory context — a companion with many unattributed
      // memories then reads as having none at all. Skip those counters and
      // keep the context; every other persistence failure stays fatal.
      const accessUpdateStartedAt = performance.now();
      let accessStatAuthorizationSkips = 0;
      for (const s of selected) {
        try {
          await productMemoryStore.updateMemory(s.memory.id, {
            lastAccessed: Date.now(),
            accessCount: s.memory.accessCount + 1,
          });
        } catch (error) {
          if (error instanceof MemorySubjectAuthorizationDeniedError) {
            accessStatAuthorizationSkips += 1;
            continue;
          }
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
      if (accessStatAuthorizationSkips > 0) {
        telemetry.accessStatAuthorizationSkips = accessStatAuthorizationSkips;
      }
      addRetrievalStageTiming(telemetry, 'access_update', accessUpdateStartedAt);

      telemetry.count = selected.length + episodicEpisodeCount;
      telemetry.reason = 'ok';
      await emitTelemetry();
      return this.finalizeRetrievalPromptBlock({
        activeContextTarget,
        recentContactShape,
        recentContactShapeSourceMemories,
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
      await emitTelemetry();
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

  private async resolveEpisodicChains(input: {
    contextText: string;
    channelId: string;
    rolledOutSessionBoundary?: RolledOutSessionBoundary;
    trustLevel: TrustLevel;
    channelDisclosure: ReturnType<typeof classifyChannelDisclosure>;
    canonicalContactId?: string;
    scopeQuery?: MemoryScopeQuery;
  }): Promise<EpisodicRetrievalChain[]> {
    return resolveEpisodicChainsWithDeps({
      episodicStore: this.episodicStore,
      sessionQuarantineFilter: this.sessionQuarantineFilter,
      request: { ...input, memoryRetrievalPolicy: this.resolveMemoryRetrievalPolicy() },
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

function addRetrievalStageTiming(
  telemetry: RetrievalTelemetry,
  stage: Exclude<keyof RetrievalTelemetry['stageTimingsMs'], 'total' | 'preparation'>,
  startedAt: number,
): void {
  const elapsedMs = Math.max(0, performance.now() - startedAt);
  telemetry.stageTimingsMs[stage] = (telemetry.stageTimingsMs[stage] ?? 0) + elapsedMs;
}

/** Exported for test access. */
export const __retrieval_internals = {
  SCORE_GUARANTEE_MIN_K,
  SCORE_GUARANTEE_FLOOR,
} as const;
