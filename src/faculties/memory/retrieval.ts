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
import type { ContextManifestMemorySeed } from '../../core/session/context-manifest.js';
import type { SubstrateConfig } from '../../system/config/runtime-config-contracts.js';
import type { EventBus } from '../../shared/event-bus.js';
import {
  type TrustLevel,
  type ChannelVisibility,
  isHighTierTrustLevel,
} from '../../system/trust/types.js';
import type { ContextBudgetConfigLike } from '../../shared/context-budget.js';
import {
  resolveMemoryRetrievalBudget,
  type ContextBudgetTurnCharacteristics,
} from '../../shared/context-budget.js';
import {
  classifyChannel,
  type ChannelMeta,
} from '../../system/trust/policy.js';
import { resolveBroadcastVisibilityScope } from '../../system/trust/broadcast-safety.js';
import { createComponentLogger } from '../../shared/logger.js';
import type { ContactStorePort } from '../../core/contacts/contact-store-port.js';
import type { Contact, SocialRelationshipEdge } from '../../core/contacts/types.js';
import type { EmotionalSnapshot } from '../../core/contacts/store/emotional-baseline.js';
import type { TurnMemorySnapshot } from '../../core/turns/snapshot.js';
import {
  normalizeCostTelemetryPort,
  type CostTelemetryInput,
  type CostTelemetryPort,
} from '../../shared/telemetry/cost-telemetry-port.js';
import { getRequestContext } from '../../primitives/llm/request-context.js';
import { evaluateCompositionalPolicyForChannelId } from '../../system/capabilities/compositional-policy.js';
import {
  buildSnapshotVersionPointer,
  cloneContactProfileArtifact,
  cloneEmotionalSnapshot,
  cloneMemory,
  cloneScoredMemory,
} from '../../core/turns/snapshot.js';
import {
  composeRetrievalRanking,
  RETRIEVAL_COMPOSITION_BATCH_SIZE,
  RETRIEVAL_COMPOSITION_FINALIST_LIMIT,
  RETRIEVAL_COMPOSITION_MAX_CANDIDATES,
  type RetrievalComposeCandidate,
} from './retrieval-compose.js';
import { isInternalMemoryArtifact } from './internal-artifacts.js';
import {
  cloneMemoryWithheldSummary,
  serializeMemoryWithheldSummary,
  type MemoryWithheldSummary,
} from './withheld-summary.js';
import {
  memoryMatchesScopeQuery,
  normalizeMemoryScopeQuery,
} from './types.js';
import {
  evaluateRetrievalAccessDecision,
  summarizeWithheldMemories,
} from './retrieval/access.js';
import {
  resolveGuaranteedSelectionFloor,
  selectWithinRelevanceAndTokenBudget,
} from './retrieval/budget.js';
import {
  renderProactiveRecall,
  renderPromptBlock,
} from './retrieval/formatting.js';
import type {
  ActiveMemoryContextRequest,
  ActiveMemoryContextSnapshot,
} from './active-context.js';
import {
  resolveActiveMemoryContextIdentity,
} from './active-context.js';
import {
  cloneRetrievalCallerContext,
  cloneRetrievalModeInput,
  serializeRetrievalModes,
} from './retrieval/modes.js';
import {
  cloneEpisodicRetrievalChain,
  collectEpisodicChainProvenanceRefs,
  countEpisodicChainEpisodes,
  retrieveEpisodicChains,
  type EpisodicRetrievalChain,
  type EpisodicRetrievalStore,
} from './retrieval/episodic.js';
import {
  computeProactiveRecallWeight,
  selectWeightedMemory,
} from './retrieval/proactive.js';
import {
  applyScoreGuarantee,
  clamp,
  collectSelectedProvenanceRefs,
  computeRetrievalScore,
  countSelectedMemoryTypes,
  resolveMoodCongruenceWeight,
  SCORE_GUARANTEE_FLOOR,
  SCORE_GUARANTEE_MIN_K,
  tokenizeForExplicitMatch,
} from './retrieval/scoring.js';
import {
  mergeRetrievalContactContext,
  normalizeRelationCue,
  querySuggestsContactFocus,
} from './retrieval/social.js';
import type {
  CompositionalRetrievalDecision,
  RetrievalContactContext,
  RetrievalDecisionDiagnostics,
  RetrievalSocialContext,
  RetrievalTelemetry,
  ScoredMemory,
} from './retrieval/types.js';
const log = createComponentLogger('Retrieval');
const RECENT_MEMORY_AUGMENT_SCAN_LIMIT = 96;
const RECENT_MEMORY_AUGMENT_SELECTED_LIMIT = 12;
const RECENT_MEMORY_AUGMENT_MIN_OVERLAP = 2;
const RECENT_MEMORY_AUGMENT_BASE_SIMILARITY = 0.62;
const EVOLUTION_CHAIN_SELECTED_LIMIT = 3;
const EVOLUTION_CHAIN_PER_MEMORY_LIMIT = 3;
const ACTIVE_MEMORY_ENTRY_LIMIT_MULTIPLIER = 2;
const ACTIVE_MEMORY_ENTRY_MIN_LIMIT = 12;
const ACTIVE_MEMORY_MISS_LIMIT = 3;
const ACTIVE_MEMORY_MISS_DECAY = 0.72;
const EVOLUTION_CHAIN_USEFUL_HINT = /\b(history|lineage|changed|change|updated|update|previous|old|correction|corrected|conflict|contradict|superseded|why)\b/i;

function hasCountEntries(record: Record<string, number | undefined> | undefined): boolean {
  return !!record && Object.values(record).some(count => count !== undefined && count > 0);
}

function applyWithheldSummaryTelemetry(
  telemetry: RetrievalTelemetry,
  withheldSummary: MemoryWithheldSummary | undefined,
): void {
  telemetry.withheldCount = withheldSummary?.totalCount ?? 0;
  const reasonCounts = withheldSummary?.reasonCounts;
  if (hasCountEntries(reasonCounts)) {
    telemetry.withheldReasonCounts = { ...reasonCounts };
  }
  const relevanceBands = withheldSummary?.relevanceBands;
  if (hasCountEntries(relevanceBands)) {
    telemetry.withheldRelevanceBands = { ...relevanceBands };
  }
}

function collectContactProfileProvenanceRefs(profile: ContactProfileArtifact | undefined): string[] {
  if (!profile) return [];
  const refs = new Set<string>();
  const contactId = profile.contactId.trim();
  if (contactId) {
    refs.add(`contact_profile:${contactId}`);
  }
  for (const sourceMemoryId of profile.sourceMemoryIds) {
    const normalized = sourceMemoryId.trim();
    if (normalized) {
      refs.add(`contact_profile_source_memory:${normalized}`);
    }
  }
  return [...refs];
}

function mergeProvenanceRefs(...groups: Array<readonly string[] | undefined>): string[] {
  const refs = new Set<string>();
  for (const group of groups) {
    for (const ref of group ?? []) {
      const normalized = ref.trim();
      if (normalized) refs.add(normalized);
    }
  }
  return [...refs];
}

function mergeScoredMemoryCandidates(
  primary: Array<PurrMemory & { similarity: number }>,
  augment: Array<PurrMemory & { similarity: number }>,
): Array<PurrMemory & { similarity: number }> {
  if (augment.length === 0) return primary;
  const byId = new Map<string, PurrMemory & { similarity: number }>();
  for (const memory of primary) {
    byId.set(memory.id, memory);
  }
  for (const memory of augment) {
    const existing = byId.get(memory.id);
    if (!existing || memory.similarity > existing.similarity) {
      byId.set(memory.id, memory);
    }
  }
  return [...byId.values()].sort((left, right) => (
    right.similarity - left.similarity
    || right.salience - left.salience
    || right.extractedAt - left.extractedAt
  ));
}

function mergeMemoryWithheldSummaries(
  ...summaries: Array<MemoryWithheldSummary | undefined>
): MemoryWithheldSummary | undefined {
  let merged: MemoryWithheldSummary | undefined;
  for (const summary of summaries) {
    if (!summary || summary.totalCount <= 0) continue;
    merged ??= { totalCount: 0, reasonCounts: {}, relevanceBands: {} };
    merged.totalCount += summary.totalCount;
    for (const [reason, count] of Object.entries(summary.reasonCounts)) {
      if (!count || count <= 0) continue;
      const reasonKey = reason as keyof MemoryWithheldSummary['reasonCounts'];
      merged.reasonCounts[reasonKey] = (merged.reasonCounts[reasonKey] ?? 0) + count;
    }
    for (const [band, count] of Object.entries(summary.relevanceBands ?? {})) {
      if (!count || count <= 0) continue;
      const bandKey = band as keyof NonNullable<MemoryWithheldSummary['relevanceBands']>;
      merged.relevanceBands ??= {};
      merged.relevanceBands[bandKey] = (merged.relevanceBands[bandKey] ?? 0) + count;
    }
  }
  return merged;
}

interface ContactProfileAccessResult {
  profile?: ContactProfileArtifact;
  withheldSummary?: MemoryWithheldSummary;
  withheldSourceMemoryIds: string[];
}

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

interface ActiveMemoryEntry {
  scored: ScoredMemory;
  retainedScore: number;
  firstSelectedAt: number;
  lastSelectedAt: number;
  missCount: number;
}

interface ActiveMemoryState {
  snapshot: ActiveMemoryContextSnapshot;
  entries: Map<string, ActiveMemoryEntry>;
  profile?: ContactProfileArtifact;
  emotionalSnapshot?: EmotionalSnapshot;
  emotionalContinuityMemories: PurrMemory[];
  withheldSummary?: MemoryWithheldSummary;
  socialContext?: RetrievalSocialContext;
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
  episodicChains: EpisodicRetrievalChain[];
  refreshSerial: number;
  maxEntries: number;
}

interface ActiveMemoryRefreshTarget {
  request: ActiveMemoryContextRequest;
  startedAt: number;
  identity: ReturnType<typeof resolveActiveMemoryContextIdentity>;
}

interface ActiveMemoryRefreshLoop {
  latestRequest?: ActiveMemoryContextRequest;
  running: Promise<ActiveMemoryContextSnapshot | null>;
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

  constructor(
    memoryStore: MemoryStorePort,
    embeddingService: EmbeddingProviderPort,
    config?: MemoryRetrieverConfig | SubstrateConfig,
    costTelemetry?: CostTelemetryInput,
    contactStore?: ContactStorePort | null,
    llmProvider?: LLMProviderPort | null,
    episodicStore?: EpisodicRetrievalStore | null,
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
    this.proactiveTurnCounter = 0;
    this.lastProactiveRecallTurn = Number.NEGATIVE_INFINITY;
    this.activeMemoryContexts = new Map();
    this.activeMemoryRefreshLoops = new Map();
  }

  private resolveRetrievalBudget(
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
  ): ReturnType<typeof resolveMemoryRetrievalBudget> {
    if (this.runtimeConfig) {
      return resolveMemoryRetrievalBudget(this.runtimeConfig, {
        ...(turnBudgetCharacteristics ? { turn: turnBudgetCharacteristics } : {}),
      });
    }

    return resolveMemoryRetrievalBudget(
      this.fallbackBudgetConfig ?? {
        defaultContextWindow: 128_000,
        modelRoster: {},
      },
      {
        ...(turnBudgetCharacteristics ? { turn: turnBudgetCharacteristics } : {}),
      },
    );
  }

  getActiveMemoryContext(request: ActiveMemoryContextRequest): ActiveMemoryContextSnapshot | null {
    const identity = resolveActiveMemoryContextIdentity(request);
    const state = this.activeMemoryContexts.get(identity.key);
    if (!state) return null;
    return this.cloneActiveMemorySnapshot(state.snapshot);
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
        {
          request,
          startedAt,
          identity,
        },
      );
      return this.cloneActiveMemorySnapshot(this.activeMemoryContexts.get(identity.key)?.snapshot ?? null);
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
    return this.cloneActiveMemorySnapshot(state.snapshot);
  }

  private cloneActiveMemorySnapshot(
    snapshot: ActiveMemoryContextSnapshot | null,
  ): ActiveMemoryContextSnapshot | null {
    if (!snapshot) return null;
    return {
      ...snapshot,
      selectedMemoryIds: [...snapshot.selectedMemoryIds],
      ...(snapshot.manifestSeed
        ? {
          manifestSeed: {
            ...snapshot.manifestSeed,
            ...(snapshot.manifestSeed.selectedTypes
              ? { selectedTypes: { ...snapshot.manifestSeed.selectedTypes } }
              : {}),
            ...(snapshot.manifestSeed.policyRejectedReasonTags
              ? { policyRejectedReasonTags: { ...snapshot.manifestSeed.policyRejectedReasonTags } }
              : {}),
            ...(snapshot.manifestSeed.withheldReasonCounts
              ? { withheldReasonCounts: { ...snapshot.manifestSeed.withheldReasonCounts } }
              : {}),
            ...(snapshot.manifestSeed.withheldRelevanceBands
              ? { withheldRelevanceBands: { ...snapshot.manifestSeed.withheldRelevanceBands } }
              : {}),
          },
        }
        : {}),
    };
  }

  private async resolveContactProfileAccess(
    profile: ContactProfileArtifact | undefined,
    options: {
      trustLevel: TrustLevel;
      channelVisibility: ChannelVisibility;
      channelMeta?: ChannelMeta;
      canonicalContactId?: string;
      operatorApproval?: boolean;
    },
  ): Promise<ContactProfileAccessResult> {
    if (!profile) {
      return { withheldSourceMemoryIds: [] };
    }

    const sourceMemoryIds = profile.sourceMemoryIds
      .map(id => id.trim())
      .filter(Boolean);
    if (sourceMemoryIds.length === 0 || typeof this.memoryStore.getById !== 'function') {
      return { profile: cloneContactProfileArtifact(profile), withheldSourceMemoryIds: [] };
    }

    const sourceMemories = (
      await Promise.all(sourceMemoryIds.map(id => this.memoryStore.getById(id)))
    )
      .filter((memory): memory is PurrMemory => Boolean(memory))
      .map(memory => ({ ...memory, similarity: 1 }));
    if (sourceMemories.length === 0) {
      return { profile: cloneContactProfileArtifact(profile), withheldSourceMemoryIds: [] };
    }

    const { summary, withheldIds } = summarizeWithheldMemories(sourceMemories, options);
    if (withheldIds.length === 0) {
      return { profile: cloneContactProfileArtifact(profile), withheldSourceMemoryIds: [] };
    }

    return {
      withheldSummary: summary,
      withheldSourceMemoryIds: withheldIds,
    };
  }

  private async collectRecentLexicalMemoryCandidates(
    contextText: string,
    existingIds: ReadonlySet<string>,
    scopeQuery: MemoryScopeQuery | undefined,
  ): Promise<Array<PurrMemory & { similarity: number }>> {
    const contextTokens = new Set(tokenizeForExplicitMatch(contextText));
    if (contextTokens.size === 0) return [];

    const recentMemories = await this.memoryStore.listActiveMemories({
      limit: RECENT_MEMORY_AUGMENT_SCAN_LIMIT,
    });
    const candidates: Array<PurrMemory & { similarity: number }> = [];
    for (const memory of recentMemories) {
      if (existingIds.has(memory.id)) continue;
      if (isInternalMemoryArtifact(memory)) continue;
      if (scopeQuery?.mode === 'only' && !memoryMatchesScopeQuery(memory, scopeQuery)) continue;

      const memoryTokens = new Set([
        ...tokenizeForExplicitMatch(memory.text),
        ...memory.tags.flatMap(tag => tokenizeForExplicitMatch(tag)),
      ]);
      let overlap = 0;
      let longOverlap = false;
      for (const token of contextTokens) {
        if (!memoryTokens.has(token)) continue;
        overlap++;
        if (token.length >= 6) {
          longOverlap = true;
        }
      }
      if (overlap < RECENT_MEMORY_AUGMENT_MIN_OVERLAP || !longOverlap) continue;

      const overlapWeight = Math.min(0.24, overlap * 0.035);
      const salienceWeight = clamp(memory.salience, 0, 1) * 0.08;
      const importanceWeight = clamp(memory.importance, 0, 1) * 0.06;
      const similarity = Math.min(
        0.92,
        RECENT_MEMORY_AUGMENT_BASE_SIMILARITY + overlapWeight + salienceWeight + importanceWeight,
      );
      candidates.push({ ...cloneMemory(memory), similarity });
    }

    return candidates
      .sort((left, right) => (
        right.similarity - left.similarity
        || right.extractedAt - left.extractedAt
      ))
      .slice(0, RECENT_MEMORY_AUGMENT_SELECTED_LIMIT);
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
    const normalizedScopeQuery = normalizeMemoryScopeQuery(scopeQuery);
    const effectiveBudgetTurn = turnBudgetCharacteristics ?? {
      channelId,
      ...(channelMeta?.isDirectMessage !== undefined ? { isDirectMessage: channelMeta.isDirectMessage } : {}),
      messageText: contextText,
    };
    const budget = this.resolveRetrievalBudget(effectiveBudgetTurn);
    const limit = budget.estimatedCount;
    const effectiveTrust = trustLevel ?? 'regular';
    const channelVisibility = classifyChannel(channelId, channelMeta);
    const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
    const operatorApproval = visibilityScope === 'approved_private_context';
    const rawProfile = canonicalContactId
      ? await this.memoryStore.getContactProfile(canonicalContactId)
      : undefined;
    const profileAccess = await this.resolveContactProfileAccess(rawProfile, {
      trustLevel: effectiveTrust,
      channelVisibility,
      channelMeta,
      canonicalContactId,
      operatorApproval,
    });
    const profile = profileAccess.profile;
    const emotionalSnapshot = canonicalContactId
      ? await this.resolveEmotionalSnapshot(canonicalContactId)
      : undefined;
    const contactEmotionalMemories = canonicalContactId
      ? await this.collectContactEmotionalMemories(canonicalContactId)
      : [];

    let semanticCandidates: Array<PurrMemory & { similarity: number }> = [];
    let lexicalCandidates: Array<PurrMemory & { similarity: number }> = [];

    if (contextText.trim().length > 0) {
      const embedding = await this.embeddingService.embed(contextText);
      const candidateLimit = Math.max(40, limit * 4);
      semanticCandidates = await this.memoryStore.searchByEmbedding(
        embedding,
        this.retrievalThreshold,
        candidateLimit,
        normalizedScopeQuery,
      );
      semanticCandidates = semanticCandidates
        .filter(memory => !isInternalMemoryArtifact(memory))
        .map(cloneScoredMemory);
      if (semanticCandidates.length === 0) {
        lexicalCandidates = (await this.memoryStore
          .searchByText(contextText, candidateLimit, normalizedScopeQuery))
          .filter(memory => !isInternalMemoryArtifact(memory))
          .map(cloneScoredMemory);
      }
      const recentLexicalCandidates = await this.collectRecentLexicalMemoryCandidates(
        contextText,
        new Set([
          ...semanticCandidates.map(memory => memory.id),
          ...lexicalCandidates.map(memory => memory.id),
        ]),
        normalizedScopeQuery,
      );
      semanticCandidates = mergeScoredMemoryCandidates(semanticCandidates, recentLexicalCandidates);
    }

    const proactiveCandidates = (await this.collectProactiveRecallCandidates(
      channelId,
      canonicalContactId,
    )).map(cloneMemory);
    const episodicChains = await this.resolveEpisodicChains({
      contextText,
      channelId,
      trustLevel: effectiveTrust,
      channelVisibility,
      canonicalContactId,
      scopeQuery: normalizedScopeQuery,
    });
    const retrievalCandidates = semanticCandidates.length > 0 ? semanticCandidates : lexicalCandidates;
    const {
      summary: candidateWithheldSummary,
      withheldIds: withheldCandidateIds,
    } = summarizeWithheldMemories(
      [...retrievalCandidates, ...contactEmotionalMemories, ...proactiveCandidates],
      {
        trustLevel: effectiveTrust,
        channelVisibility,
        channelMeta,
        canonicalContactId,
        operatorApproval,
      },
    );
    const withheldSummary = mergeMemoryWithheldSummaries(
      candidateWithheldSummary,
      profileAccess.withheldSummary,
    );
    const withheldIds = [...new Set([
      ...withheldCandidateIds,
      ...profileAccess.withheldSourceMemoryIds,
    ])];

    return {
      channelId,
      ...(profile ? { profile: cloneContactProfileArtifact(profile) } : {}),
      ...(emotionalSnapshot ? { emotionalSnapshot: cloneEmotionalSnapshot(emotionalSnapshot) } : {}),
      contactEmotionalMemories: contactEmotionalMemories.map(cloneMemory),
      semanticCandidates,
      lexicalCandidates,
      episodicChains: episodicChains.map(cloneEpisodicRetrievalChain),
      proactiveCandidates,
      ...(withheldSummary ? { withheldSummary } : {}),
      ...(withheldIds.length > 0 ? { withheldCandidateIds: withheldIds } : {}),
      ...(callerContext ? { callerContext: cloneRetrievalCallerContext(callerContext) } : {}),
      ...((retrievalMode ?? callerContext?.retrievalMode) !== undefined
        ? { retrievalMode: cloneRetrievalModeInput(retrievalMode ?? callerContext?.retrievalMode) }
        : {}),
      versionPointer: buildSnapshotVersionPointer([
        channelId,
        effectiveTrust,
        channelVisibility,
        visibilityScope,
        operatorApproval ? 'approved' : 'default',
        profile?.updatedAt,
        emotionalSnapshot?.lastMoodUpdateEpochMs,
        contactEmotionalMemories.map(memory => memory.id).join(','),
        semanticCandidates.map(memory => `${memory.id}:${memory.similarity.toFixed(4)}`).join(','),
        lexicalCandidates.map(memory => `${memory.id}:${memory.similarity.toFixed(4)}`).join(','),
        episodicChains.map(chain => `${chain.rootEpisodeId}:${chain.score.toFixed(4)}:${chain.episodes.map(episode => episode.id).join(',')}`).join(','),
        proactiveCandidates.map(memory => memory.id).join(','),
        serializeMemoryWithheldSummary(withheldSummary),
        serializeRetrievalModes(callerContext, retrievalMode),
      ]),
    };
  }

  private cloneScoredPromptMemory(input: ScoredMemory): ScoredMemory {
    return {
      ...input,
      memory: cloneScoredMemory(input.memory),
      privacyBreakdown: { ...input.privacyBreakdown },
      ...(input.evolutionChain
        ? {
          evolutionChain: input.evolutionChain.map(link => ({
            ...link,
            memory: cloneMemory(link.memory),
          })),
        }
        : {}),
    };
  }

  private buildManifestSeedFromTelemetry(telemetry: RetrievalTelemetry): ContextManifestMemorySeed {
    return {
      reason: telemetry.reason,
      retrievalSource: telemetry.retrievalSource,
      candidateCount: telemetry.candidateCount,
      policyAllowedCount: telemetry.policyAllowedCount ?? 0,
      rankedCount: telemetry.rankedCount,
      returnedCount: telemetry.returnedCount,
      retrievalLimit: telemetry.retrievalLimit,
      retrievalBudgetPct: telemetry.retrievalBudgetPct,
      retrievalTokenBudget: telemetry.retrievalTokenBudget,
      retrievalLimitMode: telemetry.retrievalLimitMode,
      ...(telemetry.contactScopeRejectedCount !== undefined
        ? { contactScopeRejectedCount: telemetry.contactScopeRejectedCount }
        : {}),
      sensitivityRejectedCount: telemetry.sensitivityRejectedCount ?? 0,
      policyRejectedCount: telemetry.policyRejectedCount ?? 0,
      ...(telemetry.policyRejectedReasonTags
        ? { policyRejectedReasonTags: { ...telemetry.policyRejectedReasonTags } }
        : {}),
      ...(telemetry.withheldCount !== undefined ? { withheldCount: telemetry.withheldCount } : {}),
      ...(telemetry.withheldReasonCounts
        ? { withheldReasonCounts: { ...telemetry.withheldReasonCounts } }
        : {}),
      ...(telemetry.withheldRelevanceBands
        ? { withheldRelevanceBands: { ...telemetry.withheldRelevanceBands } }
        : {}),
      scoreRejectedCount: telemetry.scoreRejectedCount ?? 0,
      budgetCappedCount: telemetry.budgetCappedCount ?? 0,
      ...(telemetry.selectedTypes ? { selectedTypes: { ...telemetry.selectedTypes } } : {}),
      ...(telemetry.compositionalMode ? { compositionalMode: telemetry.compositionalMode } : {}),
    };
  }

  private finalizeRetrievalPromptBlock(input: {
    activeContextTarget?: ActiveMemoryRefreshTarget;
    profile?: ContactProfileArtifact;
    selectedForPrompt?: ScoredMemory[];
    emotionalSnapshot?: EmotionalSnapshot;
    emotionalContinuityMemories?: PurrMemory[];
    withheldSummary?: MemoryWithheldSummary;
    socialContext?: RetrievalSocialContext;
    contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
    episodicChains?: EpisodicRetrievalChain[];
    telemetry: RetrievalTelemetry;
  }): string {
    const block = renderPromptBlock(input.profile, input.selectedForPrompt ?? [], {
      emotionalSnapshot: input.emotionalSnapshot,
      emotionalContinuityMemories: input.emotionalContinuityMemories,
      withheldSummary: input.withheldSummary,
      socialContext: input.socialContext,
      contactContextById: input.contactContextById,
      episodicChains: input.episodicChains,
    });

    if (!input.activeContextTarget) {
      return block;
    }

    return this.applyActiveMemoryContextRefresh({
      target: input.activeContextTarget,
      profile: input.profile,
      selectedForPrompt: input.selectedForPrompt ?? [],
      emotionalSnapshot: input.emotionalSnapshot,
      emotionalContinuityMemories: input.emotionalContinuityMemories ?? [],
      withheldSummary: input.withheldSummary,
      socialContext: input.socialContext,
      contactContextById: input.contactContextById,
      episodicChains: input.episodicChains ?? [],
      manifestSeed: this.buildManifestSeedFromTelemetry(input.telemetry),
    }).contextBlock;
  }

  private applyActiveMemoryContextRefresh(input: {
    target: ActiveMemoryRefreshTarget;
    profile?: ContactProfileArtifact;
    selectedForPrompt: ScoredMemory[];
    emotionalSnapshot?: EmotionalSnapshot;
    emotionalContinuityMemories: PurrMemory[];
    withheldSummary?: MemoryWithheldSummary;
    socialContext?: RetrievalSocialContext;
    contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
    episodicChains: EpisodicRetrievalChain[];
    manifestSeed: ContextManifestMemorySeed;
  }): ActiveMemoryContextSnapshot {
    const { target } = input;
    const now = Date.now();
    const existing = this.activeMemoryContexts.get(target.identity.key);
    const previousEntries = existing?.entries ?? new Map<string, ActiveMemoryEntry>();
    const nextEntries = new Map<string, ActiveMemoryEntry>();
    const selectedIds = new Set(input.selectedForPrompt.map(item => item.memory.id));
    const maxEntries = Math.max(
      ACTIVE_MEMORY_ENTRY_MIN_LIMIT,
      (input.manifestSeed.retrievalLimit ?? ACTIVE_MEMORY_ENTRY_MIN_LIMIT) * ACTIVE_MEMORY_ENTRY_LIMIT_MULTIPLIER,
      input.selectedForPrompt.length,
    );

    for (const [id, entry] of previousEntries.entries()) {
      if (selectedIds.has(id)) continue;
      const missCount = entry.missCount + 1;
      if (missCount >= ACTIVE_MEMORY_MISS_LIMIT) continue;
      const retainedScore = entry.retainedScore * ACTIVE_MEMORY_MISS_DECAY;
      nextEntries.set(id, {
        ...entry,
        scored: this.cloneScoredPromptMemory(entry.scored),
        retainedScore,
        missCount,
      });
    }

    for (const scored of input.selectedForPrompt) {
      const id = scored.memory.id;
      const previous = previousEntries.get(id);
      nextEntries.set(id, {
        scored: this.cloneScoredPromptMemory(scored),
        retainedScore: Math.max(scored.score, previous?.retainedScore ?? 0),
        firstSelectedAt: previous?.firstSelectedAt ?? now,
        lastSelectedAt: now,
        missCount: 0,
      });
    }

    const rankedEntries = [...nextEntries.entries()]
      .sort(([, left], [, right]) => (
        right.retainedScore - left.retainedScore
        || right.lastSelectedAt - left.lastSelectedAt
        || right.scored.memory.importance - left.scored.memory.importance
      ))
      .slice(0, maxEntries);
    const cappedEntries = new Map(rankedEntries);
    const selectedForActivePrompt = rankedEntries.map(([, entry]) => this.cloneScoredPromptMemory(entry.scored));
    const profile = input.profile ?? existing?.profile;
    const emotionalSnapshot = input.emotionalSnapshot ?? existing?.emotionalSnapshot;
    const emotionalContinuityMemories = input.emotionalContinuityMemories.length > 0
      ? input.emotionalContinuityMemories.map(memory => cloneMemory(memory))
      : existing?.emotionalContinuityMemories.map(memory => cloneMemory(memory)) ?? [];
    const withheldSummary = input.withheldSummary ?? existing?.withheldSummary;
    const socialContext = input.socialContext ?? existing?.socialContext;
    const contactContextById = input.contactContextById ?? existing?.contactContextById;
    const episodicChains = input.episodicChains.length > 0
      ? input.episodicChains.map(cloneEpisodicRetrievalChain)
      : existing?.episodicChains.map(cloneEpisodicRetrievalChain) ?? [];
    const contextBlock = renderPromptBlock(profile, selectedForActivePrompt, {
      emotionalSnapshot,
      emotionalContinuityMemories,
      withheldSummary,
      socialContext,
      contactContextById,
      episodicChains,
    });
    const selectedMemoryIds = [...cappedEntries.keys()];
    const refreshSerial = (existing?.refreshSerial ?? 0) + 1;
    const snapshot: ActiveMemoryContextSnapshot = {
      key: target.identity.key,
      subjectKey: target.identity.subjectKey,
      channelId: target.request.channelId,
      trustLevel: target.identity.trustLevel,
      channelVisibility: target.identity.channelVisibility,
      visibilityScope: target.identity.visibilityScope,
      contextBlock,
      contextChars: contextBlock.length,
      selectedMemoryIds,
      generatedAt: now,
      lastRefreshStartedAt: target.startedAt,
      lastRefreshCompletedAt: now,
      refreshStatus: 'ready',
      versionPointer: buildSnapshotVersionPointer([
        target.identity.key,
        refreshSerial,
        selectedMemoryIds.join(','),
        contextBlock,
      ]),
      manifestSeed: {
        ...input.manifestSeed,
        reason: input.manifestSeed.reason ?? 'active_projection',
        returnedCount: selectedMemoryIds.length,
      },
    };

    this.activeMemoryContexts.set(target.identity.key, {
      snapshot,
      entries: cappedEntries,
      ...(profile ? { profile: cloneContactProfileArtifact(profile) } : {}),
      ...(emotionalSnapshot ? { emotionalSnapshot: cloneEmotionalSnapshot(emotionalSnapshot) } : {}),
      emotionalContinuityMemories,
      ...(withheldSummary ? { withheldSummary: cloneMemoryWithheldSummary(withheldSummary) } : {}),
      ...(socialContext ? { socialContext } : {}),
      ...(contactContextById ? { contactContextById } : {}),
      episodicChains,
      refreshSerial,
      maxEntries,
    });
    void this.eventBus?.emit('memory.active_context.refresh', {
      channelId: target.request.channelId,
      key: target.identity.key,
      phase: 'ready',
      selectedMemoryIds,
      contextChars: contextBlock.length,
      timestamp: now,
    }).catch((emitError: unknown) => {
      log.debug('Failed to emit active memory refresh event', {
        key: target.identity.key,
        channelId: target.request.channelId,
        error: toErrorMessage(emitError),
      });
    });
    return snapshot;
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
    const channelVisibility = classifyChannel(channelId, channelMeta);
    const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
    const operatorApproval = visibilityScope === 'approved_private_context';
    const socialContext = canonicalContactId
      ? await this.resolveRetrievalSocialContext(canonicalContactId, effectiveTrust, channelVisibility)
      : undefined;
    const telemetry: RetrievalTelemetry = {
      channelId,
      count: 0,
      reason: 'ok',
      retrievalSource: 'embedding',
      trustLevel: effectiveTrust,
      channelVisibility,
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
      channelVisibility,
      channelMeta,
      canonicalContactId,
      operatorApproval,
    });
    const profile = profileAccess.profile;
    telemetry.profileIncluded = !!profile;
    telemetry.provenanceRefs = collectContactProfileProvenanceRefs(profile);
    const emotionalSnapshot = turnSnapshot?.emotionalSnapshot
      ? cloneEmotionalSnapshot(turnSnapshot.emotionalSnapshot)
      : canonicalContactId
        ? await this.resolveEmotionalSnapshot(canonicalContactId)
        : undefined;
    telemetry.emotionalSnapshotIncluded = !!emotionalSnapshot;
    const contactEmotionalSource = turnSnapshot?.contactEmotionalMemories.map(cloneMemory)
      ?? (canonicalContactId ? await this.collectContactEmotionalMemories(canonicalContactId) : []);
    const proactiveSource = turnSnapshot?.proactiveCandidates.map(cloneMemory) ?? [];
    const episodicChains = Array.isArray(turnSnapshot?.episodicChains)
      ? turnSnapshot.episodicChains.map(cloneEpisodicRetrievalChain)
      : await this.resolveEpisodicChains({
        contextText,
        channelId,
        trustLevel: effectiveTrust,
        channelVisibility,
        canonicalContactId,
        scopeQuery: normalizedScopeQuery,
      });
    const episodicEpisodeCount = countEpisodicChainEpisodes(episodicChains);
    telemetry.episodicChainCount = episodicChains.length;
    telemetry.episodicEpisodeCount = episodicEpisodeCount;
    const snapshotWithheldSummary = cloneMemoryWithheldSummary(turnSnapshot?.withheldSummary);
    let withheldSummary = mergeMemoryWithheldSummaries(
      snapshotWithheldSummary,
      profileAccess.withheldSummary,
    );

    const emptySelectedIds = new Set<string>();
    const fallbackEmotionalContinuity = canonicalContactId
      ? await this.collectEmotionalContinuityMemories(
        canonicalContactId,
        effectiveTrust,
        channelVisibility,
        emptySelectedIds,
        operatorApproval,
        channelMeta,
        contactEmotionalSource,
      )
      : [];
    telemetry.emotionalContinuityCount = fallbackEmotionalContinuity.length;

    if (!contextText.trim()) {
      if (!snapshotWithheldSummary) {
        withheldSummary = mergeMemoryWithheldSummaries(summarizeWithheldMemories(
          contactEmotionalSource,
          {
            trustLevel: effectiveTrust,
            channelVisibility,
            channelMeta,
            canonicalContactId,
            operatorApproval,
          },
        ).summary, profileAccess.withheldSummary);
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
      if (!turnSnapshot) {
        const recentLexicalCandidates = await this.collectRecentLexicalMemoryCandidates(
          contextText,
          new Set(semanticMemories.map(memory => memory.id)),
          normalizedScopeQuery,
        );
        semanticMemories = mergeScoredMemoryCandidates(semanticMemories, recentLexicalCandidates);
      }
      telemetry.semanticCandidateCount = semanticMemories.length;

      let memories = semanticMemories;
      if (semanticMemories.length === 0) {
        const lexicalMemories = (turnSnapshot?.lexicalCandidates.map(cloneScoredMemory)
          ?? await this.memoryStore.searchByText(
            contextText,
            Math.max(40, limit * 4),
            normalizedScopeQuery,
          )).filter(memory => !isInternalMemoryArtifact(memory));
        telemetry.lexicalCandidateCount = lexicalMemories.length;
        if (lexicalMemories.length > 0) {
          memories = lexicalMemories;
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
            withheldSummary = mergeMemoryWithheldSummaries(summarizeWithheldMemories(
              [...contactEmotionalSource, ...proactiveSource],
              {
                trustLevel: effectiveTrust,
                channelVisibility,
                channelMeta,
                canonicalContactId,
                operatorApproval,
              },
            ).summary, profileAccess.withheldSummary);
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
        withheldSummary = mergeMemoryWithheldSummaries(summarizeWithheldMemories(
          [...memories, ...contactEmotionalSource, ...proactiveSource],
          {
            trustLevel: effectiveTrust,
            channelVisibility,
            channelMeta,
            canonicalContactId,
            operatorApproval,
          },
        ).summary, profileAccess.withheldSummary);
      }
      applyWithheldSummaryTelemetry(telemetry, withheldSummary);

      if (memories.length > 0) {
        telemetry.topSimilarity = memories[0].similarity;
        telemetry.bottomSimilarity = memories[memories.length - 1].similarity;
      }

      const diagnostics: RetrievalDecisionDiagnostics = {
        candidateCount: memories.length,
        policyAllowedCount: 0,
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
          channelVisibility,
          channelMeta,
          canonicalContactId,
          operatorApproval,
        });
        if (!accessDecision.allowed) {
          if (accessDecision.rejectionKind === 'contact_scope') {
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
          channelVisibility,
          candidateCount: diagnostics.candidateCount,
          rejectedByContactScope: diagnostics.rejectedByContactScope,
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
      const rerankDecision = await this.applyCompositionalRetrievalRanking(
        contextText,
        channelId,
        allScored,
      );
      const scoredCandidates = await this.applySocialContextRankingAdjustments(
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
        channelVisibility,
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
        channelVisibility,
        ...diagnostics,
      });
      const selectedIds = new Set(selected.map(item => item.memory.id));
      const emotionalContinuityMemories = canonicalContactId
        ? await this.collectEmotionalContinuityMemories(
          canonicalContactId,
          effectiveTrust,
          channelVisibility,
          selectedIds,
          operatorApproval,
          channelMeta,
          turnSnapshot?.contactEmotionalMemories,
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
      const selectedForPrompt = await this.attachEvolutionChains(selected, {
        contextText,
        trustLevel: effectiveTrust,
        channelVisibility,
        channelMeta,
        canonicalContactId,
        operatorApproval,
      });
      const selectedContactContextById = await this.buildSelectedContactContext(selectedForPrompt, socialContext);

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
    if (this.proactiveRecallProbability <= 0) return '';

    const currentTurn = ++this.proactiveTurnCounter;
    if (currentTurn - this.lastProactiveRecallTurn <= this.proactiveRecallMinTurnsBetween) {
      return '';
    }

    if (Math.random() > this.proactiveRecallProbability) {
      return '';
    }

    const effectiveTrust = trustLevel ?? 'regular';
    const channelVisibility = classifyChannel(channelId, channelMeta);
    const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
    const operatorApproval = visibilityScope === 'approved_private_context';
    const candidates = turnSnapshot?.proactiveCandidates.map(cloneMemory)
      ?? await this.collectProactiveRecallCandidates(channelId, canonicalContactId);
    if (candidates.length === 0) return '';

    const weighted = candidates
      .filter((memory) => evaluateRetrievalAccessDecision(memory, {
        trustLevel: effectiveTrust,
        channelVisibility,
        channelMeta,
        canonicalContactId,
        operatorApproval,
      }).allowed)
      .map(memory => ({
        memory,
        weight: computeProactiveRecallWeight(memory),
      }))
      .filter(item => item.weight > 0)
      .sort((left, right) => right.weight - left.weight);

    if (weighted.length === 0) return '';

    const selected = selectWeightedMemory(weighted);
    if (!selected) return '';

    this.lastProactiveRecallTurn = currentTurn;
    try {
      await this.memoryStore.updateMemory(selected.id, {
        lastAccessed: Date.now(),
        accessCount: selected.accessCount + 1,
      });
    } catch (error) {
      const wrapped = new RetrievalIntegrityError(
        `Failed to update proactive recall access stats for memory ${selected.id}`,
        {
          stage: 'proactive_access_update',
          channelId,
          trustLevel: effectiveTrust,
          memoryId: selected.id,
        },
        error,
      );
      log.error('Proactive recall integrity failure', {
        context: wrapped.context,
        error: toErrorMessage(wrapped),
        cause: toErrorMessage(wrapped.cause),
      });
      throw wrapped;
    }

    return renderProactiveRecall(selected);
  }

  private async resolveEpisodicChains(input: {
    contextText: string;
    channelId: string;
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
    canonicalContactId?: string;
    scopeQuery?: MemoryScopeQuery;
  }): Promise<EpisodicRetrievalChain[]> {
    if (!this.episodicStore) {
      return [];
    }

    try {
      return (await retrieveEpisodicChains(this.episodicStore, input))
        .map(cloneEpisodicRetrievalChain);
    } catch (error) {
      throw new RetrievalIntegrityError(
        'Episodic landmark retrieval failed',
        {
          stage: 'episodic_retrieve',
          channelId: input.channelId,
          trustLevel: input.trustLevel,
        },
        error,
      );
    }
  }

  private async resolveEmotionalSnapshot(contactId: string): Promise<EmotionalSnapshot | undefined> {
    if (!this.contactStore) return undefined;

    const directSnapshot = await this.contactStore.getEmotionalSnapshot(contactId);
    if (directSnapshot) return directSnapshot;

    const contact = await this.contactStore.getById(contactId);
    if (!contact?.emotionalBaseline) return undefined;

    const baselineRaw = contact.emotionalBaseline;
    const baselineValence = clamp(baselineRaw.valenceBaseline, -1, 1);
    const moodValence = clamp(baselineRaw.moodValence, -1, 1);
    const moodDrift = Number.isFinite(baselineRaw.moodDrift)
      ? clamp(baselineRaw.moodDrift, -1, 1)
      : clamp(moodValence - baselineValence, -1, 1);
    const moodSamples = Number.isFinite(baselineRaw.moodSamples)
      ? Math.max(0, Math.floor(baselineRaw.moodSamples))
      : 0;
    const lastMoodUpdateEpochMs = Number.isFinite(baselineRaw.lastMoodUpdateEpochMs)
      ? Math.max(0, Math.floor(baselineRaw.lastMoodUpdateEpochMs))
      : undefined;

    if (
      moodSamples === 0
      && Math.abs(baselineValence) < 1e-6
      && Math.abs(moodValence) < 1e-6
      && lastMoodUpdateEpochMs === undefined
    ) {
      return undefined;
    }

    return {
      baselineValence,
      moodValence,
      moodDrift,
      moodSamples,
      lastMoodUpdateEpochMs,
    };
  }

  private async resolveRetrievalSocialContext(
    canonicalContactId: string,
    trustLevel: TrustLevel,
    channelVisibility: ChannelVisibility,
  ): Promise<RetrievalSocialContext | undefined> {
    if (!this.contactStore) return undefined;

    const canonicalContact = await this.contactStore.getById(canonicalContactId);
    if (!canonicalContact) return undefined;

    const canonicalEntity = await this.contactStore.getSocialGraphEntityByContactId(canonicalContactId);
    if (!canonicalEntity) {
      return {
        canonicalContactId,
        canonicalDisplayName: canonicalContact.displayName,
        relatedContactsById: new Map(),
      };
    }

    const edges = await this.contactStore.listSocialRelationshipEdges({
      contactId: canonicalContactId,
      viewerTrustLevel: trustLevel,
      viewerChannelVisibility: channelVisibility,
    });
    const relatedContactsById = new Map<string, RetrievalContactContext>();
    for (const edge of edges) {
      const relatedContact = await this.resolveRelatedContactFromEdge(
        canonicalEntity.id,
        edge,
      );
      if (!relatedContact) continue;

      const existing = relatedContactsById.get(relatedContact.id);
      relatedContactsById.set(
        relatedContact.id,
        mergeRetrievalContactContext(
          existing,
          this.buildRelatedContactContext(relatedContact, edge),
        ),
      );
    }

    return {
      canonicalContactId,
      canonicalDisplayName: canonicalContact.displayName,
      relatedContactsById,
    };
  }

  private async resolveRelatedContactFromEdge(
    canonicalEntityId: string,
    edge: SocialRelationshipEdge,
  ): Promise<Contact | undefined> {
    if (!this.contactStore) return undefined;

    const otherEntityId = edge.sourceEntityId === canonicalEntityId
      ? edge.targetEntityId
      : edge.sourceEntityId;
    const otherEntity = await this.contactStore.getSocialGraphEntityById(otherEntityId);
    if (!otherEntity?.contactId) return undefined;
    return this.contactStore.getById(otherEntity.contactId);
  }

  private buildRelatedContactContext(
    contact: Contact,
    edge: SocialRelationshipEdge,
  ): RetrievalContactContext {
    return {
      contactId: contact.id,
      displayName: contact.displayName,
      trustLevel: contact.trustLevel,
      relationshipType: contact.relationshipType,
      relationshipLabels: [normalizeRelationCue(edge.relationshipType)],
      relatedToCanonical: true,
    };
  }

  private async buildSelectedContactContext(
    selected: readonly ScoredMemory[],
    socialContext?: RetrievalSocialContext,
  ): Promise<ReadonlyMap<string, RetrievalContactContext> | undefined> {
    if (!this.contactStore) {
      return socialContext?.relatedContactsById;
    }

    const contexts = new Map<string, RetrievalContactContext>(socialContext?.relatedContactsById ?? []);
    for (const item of selected) {
      const contactId = item.memory.contactId?.trim();
      if (!contactId || contactId === socialContext?.canonicalContactId || contexts.has(contactId)) {
        continue;
      }
      const contact = await this.contactStore.getById(contactId);
      if (!contact) continue;
      contexts.set(contactId, {
        contactId,
        displayName: contact.displayName,
        trustLevel: contact.trustLevel,
        relationshipType: contact.relationshipType,
        relationshipLabels: [],
        relatedToCanonical: false,
      });
    }

    return contexts.size > 0 ? contexts : undefined;
  }

  private shouldExpandEvolutionChains(input: {
    contextText: string;
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
  }): boolean {
    return input.channelVisibility === 'private'
      && isHighTierTrustLevel(input.trustLevel)
      && EVOLUTION_CHAIN_USEFUL_HINT.test(input.contextText);
  }

  private async attachEvolutionChains(
    selected: readonly ScoredMemory[],
    options: {
      contextText: string;
      trustLevel: TrustLevel;
      channelVisibility: ChannelVisibility;
      channelMeta?: ChannelMeta;
      canonicalContactId?: string;
      operatorApproval: boolean;
    },
  ): Promise<ScoredMemory[]> {
    if (!this.shouldExpandEvolutionChains(options)) {
      return [...selected];
    }

    const expanded = [...selected];
    const selectedIds = new Set(expanded.map(item => item.memory.id));
    for (let index = 0; index < Math.min(expanded.length, EVOLUTION_CHAIN_SELECTED_LIMIT); index++) {
      const item = expanded[index];
      const links = (await this.memoryStore.getEvolutionLinksForSourceMemory(item.memory.id))
        .slice(0, EVOLUTION_CHAIN_PER_MEMORY_LIMIT);
      const chain: NonNullable<ScoredMemory['evolutionChain']> = [];
      for (const link of links) {
        if (selectedIds.has(link.targetMemoryId)) continue;
        const target = await this.memoryStore.getById(link.targetMemoryId);
        if (!target || target.deletedAt !== undefined) continue;
        const accessDecision = evaluateRetrievalAccessDecision(target, {
          trustLevel: options.trustLevel,
          channelVisibility: options.channelVisibility,
          channelMeta: options.channelMeta,
          canonicalContactId: options.canonicalContactId,
          operatorApproval: options.operatorApproval,
        });
        if (!accessDecision.allowed) continue;
        chain.push({
          relation: link.relation,
          confidence: link.confidence,
          reason: link.reason,
          memory: target,
        });
      }
      if (chain.length > 0) {
        expanded[index] = {
          ...item,
          evolutionChain: chain,
        };
      }
    }

    return expanded;
  }

  private async applySocialContextRankingAdjustments(
    candidates: readonly ScoredMemory[],
    contextText: string,
    socialContext?: RetrievalSocialContext,
  ): Promise<ScoredMemory[]> {
    if (!socialContext) return [...candidates];

    const queryTokens = new Set(tokenizeForExplicitMatch(contextText));
    const adjusted = await Promise.all(candidates.map(async candidate => ({
      ...candidate,
      score: candidate.score * await this.resolveSocialContextScoreMultiplier(
        candidate.memory,
        queryTokens,
        socialContext,
      ),
    })));
    return adjusted.sort((left, right) => right.score - left.score);
  }

  private async resolveSocialContextScoreMultiplier(
    memory: Pick<PurrMemory, 'contactId'>,
    queryTokens: ReadonlySet<string>,
    socialContext: RetrievalSocialContext,
  ): Promise<number> {
    const contactId = memory.contactId?.trim();
    if (!contactId) return 1;
    if (contactId === socialContext.canonicalContactId) return 1.1;

    const related = socialContext.relatedContactsById.get(contactId);
    if (related) {
      return querySuggestsContactFocus(queryTokens, related) ? 1.05 : 0.85;
    }

    const contact = this.contactStore ? await this.contactStore.getById(contactId) : undefined;
    if (contact && querySuggestsContactFocus(queryTokens, {
      displayName: contact.displayName,
      relationshipType: contact.relationshipType,
      relationshipLabels: [],
    })) {
      return 0.9;
    }

    return 0.45;
  }

  private async collectEmotionalContinuityMemories(
    canonicalContactId: string,
    trustLevel: TrustLevel,
    channelVisibility: ChannelVisibility,
    selectedIds: ReadonlySet<string>,
    operatorApproval = false,
    channelMeta?: ChannelMeta,
    sourceOverride?: readonly PurrMemory[],
  ): Promise<PurrMemory[]> {
    const source = (sourceOverride?.map(cloneMemory) ?? await this.collectContactEmotionalMemories(canonicalContactId))
      .filter(memory => !isInternalMemoryArtifact(memory));
    if (source.length === 0) return [];

    return source
      .filter(memory => memory.type === 'emotional')
      .filter(memory => !selectedIds.has(memory.id))
      .filter((memory) => evaluateRetrievalAccessDecision(memory, {
        trustLevel,
        channelVisibility,
        channelMeta,
        canonicalContactId,
        operatorApproval,
      }).allowed)
      .sort((left, right) => right.extractedAt - left.extractedAt)
      .slice(0, 3);
  }

  private async collectContactEmotionalMemories(canonicalContactId: string): Promise<PurrMemory[]> {
    return (await this.memoryStore
      .getMemoriesByContact(canonicalContactId, 12))
      .filter(memory => !isInternalMemoryArtifact(memory));
  }

  private async collectProactiveRecallCandidates(
    channelId: string,
    canonicalContactId?: string,
  ): Promise<PurrMemory[]> {
    if (canonicalContactId) {
      const byContact = (await this.memoryStore
        .getMemoriesByContact(canonicalContactId, 24))
        .filter(memory => !isInternalMemoryArtifact(memory));
      if (byContact.length > 0) return byContact;
    }

    const byChannel = (await this.memoryStore
      .getMemoriesByChannel(channelId, 24))
      .filter(memory => !isInternalMemoryArtifact(memory));
    if (byChannel.length > 0) return byChannel;

    return (await this.memoryStore
      .getAllActiveMemories())
      .filter(memory => !isInternalMemoryArtifact(memory))
      .sort((left, right) => right.lastAccessed - left.lastAccessed)
      .slice(0, 24);
  }

  private shouldUseCompositionalRetrieval(channelId: string): boolean {
    if (!this.runtimeConfig || !this.llmProvider) return false;

    return evaluateCompositionalPolicyForChannelId({
      policy: this.runtimeConfig.compositionalPolicy,
      capabilityTier: this.runtimeConfig.capabilityTier,
      channelId,
      purpose: 'retrieval',
    }).allowed;
  }

  private async applyCompositionalRetrievalRanking(
    contextText: string,
    channelId: string,
    candidates: ScoredMemory[],
  ): Promise<CompositionalRetrievalDecision> {
    const compositionalCandidateCount = Math.min(candidates.length, RETRIEVAL_COMPOSITION_MAX_CANDIDATES);
    const finalistCount = compositionalCandidateCount < 2
      ? compositionalCandidateCount
      : Math.min(RETRIEVAL_COMPOSITION_FINALIST_LIMIT, compositionalCandidateCount);
    const evaluationBatchCount = compositionalCandidateCount < 2
      ? 0
      : Math.ceil(compositionalCandidateCount / RETRIEVAL_COMPOSITION_BATCH_SIZE);

    if (!this.shouldUseCompositionalRetrieval(channelId)) {
      return {
        ranked: null,
        mode: 'disabled_policy',
        candidateCount: compositionalCandidateCount,
        evaluationBatchCount,
        finalistCount,
      };
    }
    if (candidates.length < 2) {
      return {
        ranked: null,
        mode: 'insufficient_candidates',
        candidateCount: compositionalCandidateCount,
        evaluationBatchCount,
        finalistCount,
      };
    }
    if (!this.llmProvider) {
      return {
        ranked: null,
        mode: 'llm_unavailable',
        candidateCount: compositionalCandidateCount,
        evaluationBatchCount,
        finalistCount,
      };
    }

    const decision = await composeRetrievalRanking({
      llmClient: this.llmProvider,
      query: contextText,
      channelId,
      candidates: candidates.map((candidate): RetrievalComposeCandidate => ({
        id: candidate.memory.id,
        text: candidate.memory.text,
        type: candidate.memory.type,
        score: candidate.score,
        similarity: candidate.memory.similarity,
        importance: candidate.memory.importance,
        confidence: candidate.memory.confidence,
        salience: candidate.memory.salience,
        evidenceSupport: candidate.evidenceSupport,
        explicitlyQueried: candidate.explicitlyQueried,
      })),
    });
    if (!decision) {
      return {
        ranked: null,
        mode: 'malformed_or_failed',
        candidateCount: compositionalCandidateCount,
        evaluationBatchCount,
        finalistCount,
      };
    }

    const finalOrderIndex = new Map(
      decision.finalOrder.map((id, index) => [id, index] as const),
    );

    return {
      ranked: candidates
      .map((candidate) => {
        const relevance = decision.relevanceById.get(candidate.memory.id) ?? 0;
        const finalIndex = finalOrderIndex.get(candidate.memory.id);
        let multiplier = 1 + (relevance * 0.75);
        if (finalIndex !== undefined && decision.finalOrder.length > 0) {
          const composeWeight = (decision.finalOrder.length - finalIndex) / decision.finalOrder.length;
          multiplier += composeWeight * 1.25;
        }

        return {
          ...candidate,
          score: candidate.score * multiplier,
        };
      })
      .sort((left, right) => right.score - left.score),
      mode: 'applied',
      candidateCount: compositionalCandidateCount,
      evaluationBatchCount,
      finalistCount,
    };
  }

  private isTelemetryEnabled(): boolean {
    return this.runtimeConfig?.memoryRetrievalTelemetryEnabled ?? this.telemetryEnabled;
  }

  private async emitRetrievalTelemetry(telemetry: RetrievalTelemetry): Promise<void> {
    if (this.isTelemetryEnabled()) {
      log.debug('Retrieval stats', telemetry);
    }

    if (!this.costTelemetry) return;

    try {
      const requestContext = getRequestContext();
      const correlation = requestContext
        ? {
          ...(requestContext.turnId ? { turnId: requestContext.turnId } : {}),
          ...(requestContext.requestId ? { requestId: requestContext.requestId } : {}),
          callType: requestContext.callType ?? 'memory',
          purpose: 'memory.retrieval',
          originType: requestContext.originType ?? requestContext.callType ?? 'memory',
          originStage: requestContext.originStage ?? 'memory.retrieval',
          ...(requestContext.toolName ? { toolName: requestContext.toolName } : {}),
          ...(requestContext.toolCallId ? { toolCallId: requestContext.toolCallId } : {}),
        }
        : {};
      await this.costTelemetry.recordMemoryRetrieval(
        {
          ...telemetry,
          candidates: telemetry.candidateCount,
          ranked: telemetry.rankedCount,
          returned: telemetry.returnedCount,
          ...correlation,
        },
      );
    } catch (err) {
      log.error('Failed to emit retrieval telemetry', {
        channelId: telemetry.channelId,
        error: String(err),
      });
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
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
