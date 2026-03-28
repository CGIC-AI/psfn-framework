import type {
  MemoryProvider,
  EmbeddingService,
  LLMProvider,
  RetrievalVADInput,
} from '../agent/contracts.js';
import type { ContactProfileArtifact, MemoryStore } from './store.js';
import type { PurrMemory, MemoryPrivacyRiskBreakdown, MemoryScopeQuery } from './types.js';
import { MEMORY_CONFIG, evaluateMemoryPrivacyRisk } from './types.js';
import { DEFAULT_MOOD_CONGRUENCE_WEIGHT, type SubstrateConfig } from '../types.js';
import type { EventBus } from '../shared/event-bus.js';
import {
  isHighIntimacySensitivityLevel,
  type TrustLevel,
  type ChannelVisibility,
  type SensitivityLevel,
} from '../trust/types.js';
import { countTokens } from '../llm/tokens.js';
import type { ContextBudgetConfigLike } from '../shared/context-budget.js';
import {
  MEMORY_RETRIEVAL_MIN_ITEMS,
  resolveMemoryRetrievalBudget,
  type ContextBudgetTurnCharacteristics,
} from '../shared/context-budget.js';
import {
  classifyChannel,
  evaluateMemoryPolicy,
  type DisclosureBoundaryDirective,
  type ChannelMeta,
} from '../trust/policy.js';
import {
  resolveBroadcastVisibilityScope,
  type BroadcastVisibilityScope,
} from '../broadcast/safety.js';
import { computeBoundarySimilarityBoost, isBoundaryMemory } from './boundary-log.js';
import { createComponentLogger } from '../shared/logger.js';
import type { ContactStore } from '../contacts/store.js';
import type { Contact, SocialRelationshipEdge } from '../contacts/types.js';
import type { EmotionalSnapshot } from '../contacts/store/emotional-baseline.js';
import type { TurnMemorySnapshot } from '../turns/snapshot.js';
import { getRequestContext } from '../llm/request-context.js';
import { evaluateCompositionalPolicyForChannelId } from '../compositional/policy.js';
import {
  buildSnapshotVersionPointer,
  cloneContactProfileArtifact,
  cloneEmotionalSnapshot,
  cloneMemory,
  cloneScoredMemory,
} from '../turns/snapshot.js';
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
  createEmptyMemoryWithheldSummary,
  formatMemoryWithheldReasonLabel,
  incrementMemoryWithheldReason,
  listMemoryWithheldReasonEntries,
  serializeMemoryWithheldSummary,
  type MemoryWithheldReasonCounts,
  type MemoryWithheldReasonTag,
  type MemoryWithheldSummary,
} from './withheld-summary.js';
import {
  computeMemoryScopeMatchStrength,
  memoryMatchesScopeQuery,
  normalizeMemoryScopeQuery,
} from './types.js';
import { wrapPromptSectionXml } from '../prompt/sections.js';
const log = createComponentLogger('Retrieval');

/**
 * Minimum number of memories guaranteed to surface even if privacy penalties
 * zero their composite score. These are rescued by raw embedding similarity.
 * Without this, memories that pass trust policy but have high privacy-risk
 * penalties (confidential + private-source + sensitive tags) would silently
 * disappear from context despite being allowed by the trust engine.
 */
const SCORE_GUARANTEE_MIN_K = 3;

/**
 * Floor multiplier for rescued memories. Their score becomes
 * similarity * SCORE_GUARANTEE_FLOOR, which is intentionally low
 * so naturally-scored memories always rank higher.
 */
const SCORE_GUARANTEE_FLOOR = 0.01;
const WITHHOLD_BOUNDARY_TAGS = new Set([
  'withhold',
  'withheld',
  'boundary_withhold',
  'do_not_disclose',
  'no_disclose',
  'private_boundary',
]);
const CONSENT_REQUIRED_BOUNDARY_TAGS = new Set([
  'consent_required',
  'requires_consent',
  'disclosure_requires_consent',
  'gate_consent',
]);

interface ScoredMemory {
  memory: PurrMemory & { similarity: number };
  baseScore: number;
  evidenceSupport: number;
  contradictionPenaltyMultiplier: number;
  explicitlyQueried: boolean;
  lowConfidenceSingleSourceSuppressed: boolean;
  evidenceSourceCount: number;
  privacyRisk: number;
  privacyPenalty: number;
  privacyBreakdown: MemoryPrivacyRiskBreakdown;
  score: number;
}

interface RetrievalDecisionDiagnostics {
  candidateCount: number;
  policyAllowedCount: number;
  rejectedByContactScope: number;
  rejectedBySensitivity: number;
  rejectedByPolicy: number;
  rejectedByPolicyReasonTag: Record<string, number>;
  rejectedByScore: number;
  selectedCount: number;
  topSelected: Array<{
    id: string;
    score: number;
    baseScore: number;
    evidenceSupport: number;
    contradictionPenaltyMultiplier: number;
    lowConfidenceSingleSourceSuppressed: boolean;
    explicitlyQueried: boolean;
    privacyRisk: number;
    privacyPenalty: number;
    sensitivity: SensitivityLevel;
  }>;
  contradictionAdjustedCount: number;
  lowConfidenceSuppressedCount: number;
  explicitQueryOverrideCount: number;
}

interface RetrievalTelemetry {
  channelId: string;
  count: number;
  reason: 'ok' | 'empty_input' | 'no_candidates' | 'score_filtered' | 'trust_filtered' | 'error';
  retrievalSource: 'embedding' | 'lexical_fallback';
  trustLevel: TrustLevel;
  channelVisibility: string;
  candidateCount: number;
  semanticCandidateCount: number;
  lexicalCandidateCount: number;
  rankedCount: number;
  returnedCount: number;
  retrievalLimit: number;
  retrievalThreshold: number;
  retrievalBudgetPct: number;
  retrievalTokenBudget: number;
  retrievalLimitMode: 'budget' | 'hard_limit';
  policyAllowedCount?: number;
  contactScopeRejectedCount?: number;
  sensitivityRejectedCount?: number;
  policyRejectedCount?: number;
  policyRejectedReasonTags?: Record<string, number>;
  withheldCount?: number;
  withheldReasonCounts?: MemoryWithheldReasonCounts;
  scoreRejectedCount?: number;
  scoreGuaranteedCount?: number;
  evidenceSupportAverage?: number;
  contradictionAdjustedCount?: number;
  lowConfidenceSuppressedCount?: number;
  explicitQueryOverrideCount?: number;
  visibilityScope: BroadcastVisibilityScope | 'non_broadcast';
  operatorApproval: boolean;
  provenanceRefs: string[];
  profileIncluded?: boolean;
  emotionalSnapshotIncluded?: boolean;
  emotionalContinuityCount?: number;
  topSimilarity?: number;
  bottomSimilarity?: number;
  topScore?: number;
  bottomScore?: number;
  budgetCappedCount?: number;
  selectedTypes?: Record<string, number>;
  compositionalMode?: 'disabled_policy' | 'llm_unavailable' | 'insufficient_candidates' | 'malformed_or_failed' | 'applied';
  compositionalCandidateCount?: number;
  compositionalEvaluationBatchCount?: number;
  compositionalFinalistCount?: number;
}

interface CompositionalRetrievalDecision {
  ranked: ScoredMemory[] | null;
  mode: NonNullable<RetrievalTelemetry['compositionalMode']>;
  candidateCount: number;
  evaluationBatchCount: number;
  finalistCount: number;
}

interface ProactiveWeightedMemory {
  memory: PurrMemory;
  weight: number;
}

interface RetrievalContactContext {
  contactId: string;
  displayName: string;
  trustLevel: TrustLevel;
  relationshipType: string;
  relationshipLabels: string[];
  relatedToCanonical: boolean;
}

interface RetrievalSocialContext {
  canonicalContactId: string;
  canonicalDisplayName: string;
  relatedContactsById: ReadonlyMap<string, RetrievalContactContext>;
}

type RetrievalAccessRejectionKind = 'contact_scope' | 'sensitivity' | 'policy';

interface RetrievalAccessDecision {
  allowed: boolean;
  rejectionKind?: RetrievalAccessRejectionKind;
  withheldReason?: MemoryWithheldReasonTag;
}

function violatesHighIntimacyContactScope(
  memory: Pick<PurrMemory, 'sensitivity' | 'contactId'>,
  canonicalContactId?: string,
): boolean {
  if (!isHighIntimacySensitivityLevel(memory.sensitivity)) return false;
  if (!canonicalContactId) return false;
  return memory.contactId !== canonicalContactId;
}

function evaluateRetrievalAccessDecision(
  memory: Pick<PurrMemory, 'sensitivity' | 'contactId' | 'consentFlags' | 'tags'>,
  options: {
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
  },
): RetrievalAccessDecision {
  if (violatesHighIntimacyContactScope(memory, options.canonicalContactId)) {
    return {
      allowed: false,
      rejectionKind: 'contact_scope',
      withheldReason: 'contact_scope.high_intimacy',
    };
  }

  const policy = evaluateMemoryPolicy({
    trustLevel: options.trustLevel,
    channelVisibility: options.channelVisibility,
    memorySensitivity: memory.sensitivity,
    consentFlags: memory.consentFlags,
    disclosureBoundary: resolveDisclosureBoundaryDirective(memory, options.channelMeta),
    operatorApproval: options.operatorApproval,
  });
  if (policy.decision === 'allow') {
    return { allowed: true };
  }

  if (
    policy.reasonTag === 'trust.ceiling_exceeded'
    || policy.reasonTag === 'visibility.channel_restricted'
  ) {
    return {
      allowed: false,
      rejectionKind: 'sensitivity',
      withheldReason: policy.reasonTag,
    };
  }

  return {
    allowed: false,
    rejectionKind: 'policy',
    withheldReason: policy.reasonTag as Exclude<MemoryWithheldReasonTag, 'contact_scope.high_intimacy'>,
  };
}

function summarizeWithheldMemories<T extends Pick<PurrMemory, 'id' | 'sensitivity' | 'contactId' | 'consentFlags' | 'tags'>>(
  memories: readonly T[],
  options: {
    trustLevel: TrustLevel;
    channelVisibility: ChannelVisibility;
    channelMeta?: ChannelMeta;
    canonicalContactId?: string;
    operatorApproval?: boolean;
  },
): { summary?: MemoryWithheldSummary; withheldIds: string[] } {
  const summary = createEmptyMemoryWithheldSummary();
  const withheldIds = new Set<string>();
  const seenIds = new Set<string>();

  for (const memory of memories) {
    if (seenIds.has(memory.id)) continue;
    seenIds.add(memory.id);

    const decision = evaluateRetrievalAccessDecision(memory, options);
    if (!decision.allowed && decision.withheldReason) {
      incrementMemoryWithheldReason(summary, decision.withheldReason);
      withheldIds.add(memory.id);
    }
  }

  return {
    ...(summary.totalCount > 0 ? { summary } : {}),
    withheldIds: [...withheldIds],
  };
}

type RetrievalIntegrityErrorStage =
  | 'retrieve'
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
  private memoryStore: MemoryStore;
  private embeddingService: EmbeddingService;
  private runtimeConfig: SubstrateConfig | null;
  private fallbackBudgetConfig: ContextBudgetConfigLike | null;
  private retrievalThreshold: number;
  private eventBus?: EventBus;
  private contactStore: ContactStore | null;
  private telemetryEnabled: boolean;
  private llmProvider: LLMProvider | null;
  private moodCongruenceWeight: number;
  private proactiveRecallProbability: number;
  private proactiveRecallMinTurnsBetween: number;
  private proactiveTurnCounter: number;
  private lastProactiveRecallTurn: number;

  constructor(
    memoryStore: MemoryStore,
    embeddingService: EmbeddingService,
    config?: MemoryRetrieverConfig | SubstrateConfig,
    eventBus?: EventBus,
    contactStore?: ContactStore | null,
    llmProvider?: LLMProvider | null,
  ) {
    this.memoryStore = memoryStore;
    this.embeddingService = embeddingService;
    this.eventBus = eventBus;
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
    this.proactiveTurnCounter = 0;
    this.lastProactiveRecallTurn = Number.NEGATIVE_INFINITY;
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

  async captureTurnMemorySnapshot(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
    turnBudgetCharacteristics?: ContextBudgetTurnCharacteristics,
    scopeQuery?: MemoryScopeQuery,
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
    const profile = canonicalContactId
      ? this.memoryStore.getContactProfile(canonicalContactId)
      : undefined;
    const emotionalSnapshot = canonicalContactId
      ? this.resolveEmotionalSnapshot(canonicalContactId)
      : undefined;
    const contactEmotionalMemories = canonicalContactId
      ? this.collectContactEmotionalMemories(canonicalContactId)
      : [];

    let semanticCandidates: Array<PurrMemory & { similarity: number }> = [];
    let lexicalCandidates: Array<PurrMemory & { similarity: number }> = [];

    if (contextText.trim().length > 0) {
      const embedding = await this.embeddingService.embed(contextText);
      const candidateLimit = Math.max(40, limit * 4);
      semanticCandidates = this.memoryStore.searchByEmbedding(
        embedding,
        this.retrievalThreshold,
        candidateLimit,
        normalizedScopeQuery,
      )
        .filter(memory => !isInternalMemoryArtifact(memory))
        .map(cloneScoredMemory);
      if (semanticCandidates.length === 0) {
        lexicalCandidates = this.memoryStore
          .searchByText(contextText, candidateLimit, normalizedScopeQuery)
          .filter(memory => !isInternalMemoryArtifact(memory))
          .map(cloneScoredMemory);
      }
    }

    const proactiveCandidates = this.collectProactiveRecallCandidates(channelId, canonicalContactId).map(cloneMemory);
    const retrievalCandidates = semanticCandidates.length > 0 ? semanticCandidates : lexicalCandidates;
    const {
      summary: withheldSummary,
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

    return {
      channelId,
      ...(profile ? { profile: cloneContactProfileArtifact(profile) } : {}),
      ...(emotionalSnapshot ? { emotionalSnapshot: cloneEmotionalSnapshot(emotionalSnapshot) } : {}),
      contactEmotionalMemories: contactEmotionalMemories.map(cloneMemory),
      semanticCandidates,
      lexicalCandidates,
      proactiveCandidates,
      ...(withheldSummary ? { withheldSummary } : {}),
      ...(withheldCandidateIds.length > 0 ? { withheldCandidateIds } : {}),
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
        proactiveCandidates.map(memory => memory.id).join(','),
        serializeMemoryWithheldSummary(withheldSummary),
      ]),
    };
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
  ): Promise<string> {
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
      ? this.resolveRetrievalSocialContext(canonicalContactId, effectiveTrust, channelVisibility)
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
    const profile = turnSnapshot?.profile
      ? cloneContactProfileArtifact(turnSnapshot.profile)
      : canonicalContactId
        ? this.memoryStore.getContactProfile(canonicalContactId)
        : undefined;
    telemetry.profileIncluded = !!profile;
    const emotionalSnapshot = turnSnapshot?.emotionalSnapshot
      ? cloneEmotionalSnapshot(turnSnapshot.emotionalSnapshot)
      : canonicalContactId
        ? this.resolveEmotionalSnapshot(canonicalContactId)
        : undefined;
    telemetry.emotionalSnapshotIncluded = !!emotionalSnapshot;
    const contactEmotionalSource = turnSnapshot?.contactEmotionalMemories.map(cloneMemory)
      ?? (canonicalContactId ? this.collectContactEmotionalMemories(canonicalContactId) : []);
    const proactiveSource = turnSnapshot?.proactiveCandidates.map(cloneMemory) ?? [];
    let withheldSummary = cloneMemoryWithheldSummary(turnSnapshot?.withheldSummary);

    const emptySelectedIds = new Set<string>();
    const fallbackEmotionalContinuity = canonicalContactId
      ? this.collectEmotionalContinuityMemories(
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
      if (!withheldSummary) {
        withheldSummary = summarizeWithheldMemories(
          contactEmotionalSource,
          {
            trustLevel: effectiveTrust,
            channelVisibility,
            channelMeta,
            canonicalContactId,
            operatorApproval,
          },
        ).summary;
      }
      telemetry.reason = 'empty_input';
      telemetry.withheldCount = withheldSummary?.totalCount ?? 0;
      if (withheldSummary?.reasonCounts && Object.keys(withheldSummary.reasonCounts).length > 0) {
        telemetry.withheldReasonCounts = { ...withheldSummary.reasonCounts };
      }
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile, [], {
        emotionalSnapshot,
        emotionalContinuityMemories: fallbackEmotionalContinuity,
        withheldSummary,
        socialContext,
      });
    }

    try {
      let semanticMemories = (turnSnapshot?.semanticCandidates.map(cloneScoredMemory) ?? [])
        .filter(memory => !isInternalMemoryArtifact(memory));
      if (semanticMemories.length === 0 && !turnSnapshot) {
        const embedding = await this.embeddingService.embed(contextText);
        const candidateLimit = Math.max(40, limit * 4);
        semanticMemories = this.memoryStore.searchByEmbedding(
          embedding,
          this.retrievalThreshold,
          candidateLimit,
          normalizedScopeQuery,
        ).filter(memory => !isInternalMemoryArtifact(memory));
      }
      telemetry.semanticCandidateCount = semanticMemories.length;

      let memories = semanticMemories;
      if (semanticMemories.length === 0) {
        const lexicalMemories = (turnSnapshot?.lexicalCandidates.map(cloneScoredMemory)
          ?? this.memoryStore.searchByText(
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
          if (!withheldSummary) {
            withheldSummary = summarizeWithheldMemories(
              [...contactEmotionalSource, ...proactiveSource],
              {
                trustLevel: effectiveTrust,
                channelVisibility,
                channelMeta,
                canonicalContactId,
                operatorApproval,
              },
            ).summary;
          }
          telemetry.reason = 'no_candidates';
          telemetry.withheldCount = withheldSummary?.totalCount ?? 0;
          if (withheldSummary?.reasonCounts && Object.keys(withheldSummary.reasonCounts).length > 0) {
            telemetry.withheldReasonCounts = { ...withheldSummary.reasonCounts };
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
          return renderPromptBlock(profile, [], {
            emotionalSnapshot,
            emotionalContinuityMemories: fallbackEmotionalContinuity,
            withheldSummary,
            socialContext,
          });
        }
      }
      telemetry.candidateCount = memories.length;
      if (!withheldSummary) {
        withheldSummary = summarizeWithheldMemories(
          [...memories, ...contactEmotionalSource, ...proactiveSource],
          {
            trustLevel: effectiveTrust,
            channelVisibility,
            channelMeta,
            canonicalContactId,
            operatorApproval,
          },
        ).summary;
      }
      telemetry.withheldCount = withheldSummary?.totalCount ?? 0;
      if (withheldSummary?.reasonCounts && Object.keys(withheldSummary.reasonCounts).length > 0) {
        telemetry.withheldReasonCounts = { ...withheldSummary.reasonCounts };
      }

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
        return renderPromptBlock(profile, [], {
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
          withheldSummary,
          socialContext,
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
          }),
        }))
        .sort((a, b) => b.score - a.score);
      const rerankDecision = await this.applyCompositionalRetrievalRanking(
        contextText,
        channelId,
        allScored,
      );
      const scoredCandidates = this.applySocialContextRankingAdjustments(
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

      const positiveScored = scoredCandidates.filter(c => c.score > 0);
      const zeroScored = scoredCandidates.filter(c => c.score <= 0);
      diagnostics.rejectedByScore = zeroScored.length;
      telemetry.scoreRejectedCount = diagnostics.rejectedByScore;

      // Guarantee: if we have policy-allowed memories with high similarity but
      // zero composite score (privacy penalty zeroed them out), rescue the top
      // SCORE_GUARANTEE_MIN_K by similarity so they still surface.
      let scoreGuaranteedCount = 0;
      if (positiveScored.length < SCORE_GUARANTEE_MIN_K && zeroScored.length > 0) {
        const needed = SCORE_GUARANTEE_MIN_K - positiveScored.length;
        const rescued = zeroScored
          .sort((a, b) => b.memory.similarity - a.memory.similarity)
          .slice(0, needed)
          .map(item => ({
            ...item,
            // Assign a minimal positive score so they sort after naturally-scored
            // memories but still appear in the output.
            score: item.memory.similarity * SCORE_GUARANTEE_FLOOR,
          }));
        positiveScored.push(...rescued);
        positiveScored.sort((a, b) => b.score - a.score);
        scoreGuaranteedCount = rescued.length;
      }
      telemetry.scoreGuaranteedCount = scoreGuaranteedCount;

      const scored = positiveScored;

      const ranked = scored;
      telemetry.rankedCount = ranked.length;

      if (ranked.length > 0) {
        telemetry.topScore = ranked[0].score;
        telemetry.bottomScore = ranked[ranked.length - 1].score;
      }

      if (ranked.length === 0) {
        telemetry.reason = 'score_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        log.info('Retrieval: all policy-allowed memories scored zero', {
          channelId,
          trustLevel: effectiveTrust,
          policyAllowedCount: diagnostics.policyAllowedCount,
        });
        return renderPromptBlock(profile, [], {
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
          withheldSummary,
          socialContext,
        });
      }

      const selected = selectWithinTokenBudget(ranked, budget.tokenBudget);

      telemetry.returnedCount = selected.length;
      telemetry.budgetCappedCount = Math.max(0, ranked.length - selected.length);
      telemetry.selectedTypes = countSelectedMemoryTypes(selected);
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
        pipeline: `${diagnostics.candidateCount} candidates -> ${diagnostics.policyAllowedCount} policy-allowed -> ${scored.length} scored -> ${ranked.length} ranked -> ${selected.length} selected`,
        rejectedByContactScope: diagnostics.rejectedByContactScope,
        rejectedBySensitivity: diagnostics.rejectedBySensitivity,
        rejectedByPolicy: diagnostics.rejectedByPolicy,
        rejectedByPolicyReasonTags: diagnostics.rejectedByPolicyReasonTag,
        withheldCount: telemetry.withheldCount,
        withheldReasonCounts: telemetry.withheldReasonCounts,
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
        ? this.collectEmotionalContinuityMemories(
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
      telemetry.provenanceRefs = collectSelectedProvenanceRefs(
        selected,
        telemetry.retrievalSource,
      );
      const selectedContactContextById = this.buildSelectedContactContext(selected, socialContext);

      // Update access stats; fail closed if persistence fails.
      for (const s of selected) {
        try {
          this.memoryStore.updateMemory(s.memory.id, {
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

      telemetry.count = selected.length;
      telemetry.reason = 'ok';
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile, selected, {
        emotionalSnapshot,
        emotionalContinuityMemories,
        withheldSummary,
        socialContext,
        contactContextById: selectedContactContextById,
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
      ?? this.collectProactiveRecallCandidates(channelId, canonicalContactId);
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
      this.memoryStore.updateMemory(selected.id, {
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

  private resolveEmotionalSnapshot(contactId: string): EmotionalSnapshot | undefined {
    if (!this.contactStore) return undefined;

    const snapshotStore = this.contactStore as ContactStore & {
      getEmotionalSnapshot?: (id: string) => EmotionalSnapshot | undefined;
    };
    if (typeof snapshotStore.getEmotionalSnapshot === 'function') {
      return snapshotStore.getEmotionalSnapshot(contactId);
    }

    const contact = this.contactStore.getById(contactId);
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

  private resolveRetrievalSocialContext(
    canonicalContactId: string,
    trustLevel: TrustLevel,
    channelVisibility: ChannelVisibility,
  ): RetrievalSocialContext | undefined {
    if (!this.contactStore) return undefined;

    const canonicalContact = this.contactStore.getById(canonicalContactId);
    if (!canonicalContact) return undefined;

    const canonicalEntity = this.contactStore.getSocialGraphEntityByContactId(canonicalContactId);
    if (!canonicalEntity) {
      return {
        canonicalContactId,
        canonicalDisplayName: canonicalContact.displayName,
        relatedContactsById: new Map(),
      };
    }

    const edges = this.contactStore.listSocialRelationshipEdges({
      contactId: canonicalContactId,
      viewerTrustLevel: trustLevel,
      viewerChannelVisibility: channelVisibility,
    });
    const relatedContactsById = new Map<string, RetrievalContactContext>();
    for (const edge of edges) {
      const relatedContact = this.resolveRelatedContactFromEdge(
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

  private resolveRelatedContactFromEdge(
    canonicalEntityId: string,
    edge: SocialRelationshipEdge,
  ): Contact | undefined {
    if (!this.contactStore) return undefined;

    const otherEntityId = edge.sourceEntityId === canonicalEntityId
      ? edge.targetEntityId
      : edge.sourceEntityId;
    const otherEntity = this.contactStore.getSocialGraphEntityById(otherEntityId);
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

  private buildSelectedContactContext(
    selected: readonly ScoredMemory[],
    socialContext?: RetrievalSocialContext,
  ): ReadonlyMap<string, RetrievalContactContext> | undefined {
    if (!this.contactStore) {
      return socialContext?.relatedContactsById;
    }

    const contexts = new Map<string, RetrievalContactContext>(socialContext?.relatedContactsById ?? []);
    for (const item of selected) {
      const contactId = item.memory.contactId?.trim();
      if (!contactId || contactId === socialContext?.canonicalContactId || contexts.has(contactId)) {
        continue;
      }
      const contact = this.contactStore.getById(contactId);
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

  private applySocialContextRankingAdjustments(
    candidates: readonly ScoredMemory[],
    contextText: string,
    socialContext?: RetrievalSocialContext,
  ): ScoredMemory[] {
    if (!socialContext) return [...candidates];

    const queryTokens = new Set(tokenizeForExplicitMatch(contextText));
    return candidates
      .map((candidate) => ({
        ...candidate,
        score: candidate.score * this.resolveSocialContextScoreMultiplier(
          candidate.memory,
          queryTokens,
          socialContext,
        ),
      }))
      .sort((left, right) => right.score - left.score);
  }

  private resolveSocialContextScoreMultiplier(
    memory: Pick<PurrMemory, 'contactId'>,
    queryTokens: ReadonlySet<string>,
    socialContext: RetrievalSocialContext,
  ): number {
    const contactId = memory.contactId?.trim();
    if (!contactId) return 1;
    if (contactId === socialContext.canonicalContactId) return 1.1;

    const related = socialContext.relatedContactsById.get(contactId);
    if (related) {
      return querySuggestsContactFocus(queryTokens, related) ? 1.05 : 0.85;
    }

    const contact = this.contactStore?.getById(contactId);
    if (contact && querySuggestsContactFocus(queryTokens, {
      contactId,
      displayName: contact.displayName,
      trustLevel: contact.trustLevel,
      relationshipType: contact.relationshipType,
      relationshipLabels: [],
      relatedToCanonical: false,
    })) {
      return 0.9;
    }

    return 0.45;
  }

  private collectEmotionalContinuityMemories(
    canonicalContactId: string,
    trustLevel: TrustLevel,
    channelVisibility: ChannelVisibility,
    selectedIds: ReadonlySet<string>,
    operatorApproval = false,
    channelMeta?: ChannelMeta,
    sourceOverride?: readonly PurrMemory[],
  ): PurrMemory[] {
    const source = (sourceOverride?.map(cloneMemory) ?? this.collectContactEmotionalMemories(canonicalContactId))
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

  private collectContactEmotionalMemories(canonicalContactId: string): PurrMemory[] {
    return this.memoryStore
      .getMemoriesByContact(canonicalContactId, 12)
      .filter(memory => !isInternalMemoryArtifact(memory));
  }

  private collectProactiveRecallCandidates(
    channelId: string,
    canonicalContactId?: string,
  ): PurrMemory[] {
    if (canonicalContactId) {
      const byContact = this.memoryStore
        .getMemoriesByContact(canonicalContactId, 24)
        .filter(memory => !isInternalMemoryArtifact(memory));
      if (byContact.length > 0) return byContact;
    }

    const byChannel = this.memoryStore
      .getMemoriesByChannel(channelId, 24)
      .filter(memory => !isInternalMemoryArtifact(memory));
    if (byChannel.length > 0) return byChannel;

    return this.memoryStore
      .getAllActiveMemories()
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

    if (!this.eventBus) return;

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
      await this.eventBus.emit(
        'memory.retrieval',
        {
          ...telemetry,
          candidates: telemetry.candidateCount,
          ranked: telemetry.rankedCount,
          returned: telemetry.returnedCount,
          ...correlation,
        } as { channelId: string; count: number },
      );
    } catch (err) {
      log.error('Failed to emit retrieval telemetry', {
        channelId: telemetry.channelId,
        error: String(err),
      });
    }
  }
}

function countSelectedMemoryTypes(scored: ScoredMemory[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of scored) {
    counts[item.memory.type] = (counts[item.memory.type] ?? 0) + 1;
  }
  return counts;
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeBoundaryTag(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
}

function hasBoundaryDirectiveTag(
  tags: readonly string[],
  candidates: ReadonlySet<string>,
): boolean {
  for (const rawTag of tags) {
    const normalized = normalizeBoundaryTag(rawTag);
    if (normalized.length === 0) continue;
    if (candidates.has(normalized)) return true;
  }
  return false;
}

function resolveDisclosureBoundaryDirective(
  memory: Pick<PurrMemory, 'tags'>,
  channelMeta?: ChannelMeta,
): DisclosureBoundaryDirective | undefined {
  const withhold = hasBoundaryDirectiveTag(memory.tags, WITHHOLD_BOUNDARY_TAGS);
  const consentRequired = hasBoundaryDirectiveTag(memory.tags, CONSENT_REQUIRED_BOUNDARY_TAGS);
  if (!withhold && !consentRequired) return undefined;

  return {
    withhold,
    consentRequired,
    consentGranted: channelMeta?.disclosureConsentGranted === true,
  };
}

function collectSelectedProvenanceRefs(
  scored: ScoredMemory[],
  retrievalSource: 'embedding' | 'lexical_fallback' = 'embedding',
): string[] {
  const refs = new Set<string>();
  if (retrievalSource === 'lexical_fallback') {
    refs.add('retrieval:lexical_fallback');
  }
  for (const item of scored) {
    if (item.memory.sourceRef.trim()) {
      refs.add(item.memory.sourceRef.trim());
    }
    for (const provenanceRef of item.memory.provenanceRefs ?? []) {
      const normalized = provenanceRef.trim();
      if (normalized) refs.add(normalized);
    }
  }
  return [...refs];
}

function computeRetrievalScore(
  memory: PurrMemory & { similarity: number },
  contextText: string,
  options?: {
    currentVAD?: RetrievalVADInput;
    moodCongruenceWeight: number;
    scopeQuery?: MemoryScopeQuery;
  },
): {
  score: number;
  baseScore: number;
  evidenceSupport: number;
  contradictionPenaltyMultiplier: number;
  explicitlyQueried: boolean;
  lowConfidenceSingleSourceSuppressed: boolean;
  evidenceSourceCount: number;
  privacyRisk: number;
  privacyPenalty: number;
  privacyBreakdown: MemoryPrivacyRiskBreakdown;
} {
  const ageDays = (Date.now() - memory.extractedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = 1 / (1 + ageDays / 30);
  const emotionalWeight = 1 + Math.abs(memory.emotionalValence) * 0.5;
  const moodCongruenceFactor = computeMoodCongruenceFactor(
    memory.formationVAD,
    options?.currentVAD,
    options?.moodCongruenceWeight ?? DEFAULT_MOOD_CONGRUENCE_WEIGHT,
  );
  const typePriorityBoost = isBoundaryMemory(memory) ? 1.6 : 1;
  const boundarySimilarityBoost = isBoundaryMemory(memory)
    ? computeBoundarySimilarityBoost(contextText, memory)
    : 1;
  const scopeMatchStrength = computeMemoryScopeMatchStrength(memory, options?.scopeQuery);
  const scopeBoost = 1 + (scopeMatchStrength * 0.35);
  const accessReinforcementBoost = deriveAccessReinforcement(memory);
  const rawBaseScore = (
    memory.similarity *
    recencyBoost *
    emotionalWeight *
    memory.importance *
    memory.salience *
    moodCongruenceFactor *
    typePriorityBoost *
    boundarySimilarityBoost *
    scopeBoost *
    accessReinforcementBoost
  );
  const evidence = deriveEvidenceSupport(memory);
  const contradictionPenaltyMultiplier = deriveContradictionPenalty(memory);
  const explicitlyQueried = hasExplicitMemoryMention(contextText, memory.text);
  const lowConfidenceSingleSourceSuppressed = (
    evidence.sourceCount <= 1
    && memory.confidence < 0.45
    && !explicitlyQueried
  );
  const evidenceBoost = 0.45 + (evidence.support * 0.55);
  const baseScore = rawBaseScore * evidenceBoost * contradictionPenaltyMultiplier;
  const privacyEvaluation = evaluateMemoryPrivacyRisk(memory);
  const privacyPenalty = baseScore * privacyEvaluation.risk * MEMORY_CONFIG.privacyRiskPenaltyWeight;
  let score = Math.max(0, baseScore - privacyPenalty);
  if (lowConfidenceSingleSourceSuppressed) {
    // Keep weak single-source memories available for rescue/explicit retrieval,
    // but prevent them from dominating ranked outputs by default.
    const dominanceCap = memory.similarity * 0.02;
    score = Math.min(score, dominanceCap);
  }
  return {
    score,
    baseScore,
    evidenceSupport: evidence.support,
    contradictionPenaltyMultiplier,
    explicitlyQueried,
    lowConfidenceSingleSourceSuppressed,
    evidenceSourceCount: evidence.sourceCount,
    privacyRisk: privacyEvaluation.risk,
    privacyPenalty,
    privacyBreakdown: privacyEvaluation.breakdown,
  };
}

function computeMoodCongruenceFactor(
  formationVAD: RetrievalVADInput | undefined,
  currentVAD: RetrievalVADInput | undefined,
  moodCongruenceWeight: number,
): number {
  if (moodCongruenceWeight <= 0) return 1;
  if (!isFiniteRetrievalVAD(formationVAD) || !isFiniteRetrievalVAD(currentVAD)) return 1;
  const similarity = computeVADSimilarity(formationVAD, currentVAD);
  return 1 + (moodCongruenceWeight * similarity);
}

function computeVADSimilarity(
  left: RetrievalVADInput,
  right: RetrievalVADInput,
): number {
  const deltaValence = clamp(left.valence, -1, 1) - clamp(right.valence, -1, 1);
  const deltaArousal = clamp(left.arousal, -1, 1) - clamp(right.arousal, -1, 1);
  const deltaDominance = clamp(left.dominance, -1, 1) - clamp(right.dominance, -1, 1);
  const distance = Math.sqrt(
    (deltaValence ** 2)
    + (deltaArousal ** 2)
    + (deltaDominance ** 2),
  );
  const maxDistance = 2 * Math.sqrt(3);
  return clamp(1 - (distance / maxDistance), 0, 1);
}

function isFiniteRetrievalVAD(vad: RetrievalVADInput | undefined): vad is RetrievalVADInput {
  if (!vad) return false;
  return Number.isFinite(vad.valence)
    && Number.isFinite(vad.arousal)
    && Number.isFinite(vad.dominance);
}

function deriveEvidenceSupport(
  memory: Pick<PurrMemory, 'confidence' | 'sourceRef' | 'provenanceRefs' | 'accessCount'>,
): { support: number; sourceCount: number } {
  const confidence = clamp(memory.confidence, 0, 1);
  const sourceCount = countDistinctEvidenceSources(memory);
  const sourceSupport = clamp(0.25 + (Math.min(4, sourceCount) / 4) * 0.75, 0, 1);
  const reinforcement = clamp(memory.accessCount / 8, 0, 1);
  const support = clamp(
    (confidence * 0.6)
    + (sourceSupport * 0.3)
    + (reinforcement * 0.1),
    0.05,
    1,
  );
  return { support, sourceCount };
}

function deriveAccessReinforcement(
  memory: Pick<PurrMemory, 'lastAccessed' | 'extractedAt' | 'accessCount'>,
): number {
  const effectiveLastAccessed = Number.isFinite(memory.lastAccessed)
    ? memory.lastAccessed
    : memory.extractedAt;
  const ageMs = Math.max(0, Date.now() - effectiveLastAccessed);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const freshnessDays = Math.max(1, MEMORY_CONFIG.retrievalAccessFreshnessDays);
  const countCap = Math.max(1, MEMORY_CONFIG.retrievalAccessCountCap);
  const freshness = clamp(1 / (1 + ageDays / freshnessDays), 0, 1);
  const reinforcement = clamp(memory.accessCount / countCap, 0, 1);
  const combinedSignal = clamp(
    (freshness * MEMORY_CONFIG.retrievalAccessFreshnessWeight)
    + (reinforcement * (1 - MEMORY_CONFIG.retrievalAccessFreshnessWeight)),
    0,
    1,
  );
  return 1 + (combinedSignal * MEMORY_CONFIG.retrievalAccessReinforcementMaxBoost);
}

function deriveContradictionPenalty(
  memory: Pick<PurrMemory, 'supersededBy' | 'tags'>,
): number {
  const normalizedTags = new Set(memory.tags.map(tag => tag.trim().toLowerCase()).filter(Boolean));
  const hasContradictionHint = [...normalizedTags].some(tag => (
    tag === 'contradicted'
    || tag === 'contradiction'
    || tag === 'disputed'
    || tag === 'retracted'
    || tag === 'hallucinated'
    || tag.includes('contradict')
    || tag.includes('disput')
  ));
  if (memory.supersededBy) return 0.25;
  if (hasContradictionHint) return 0.55;
  return 1;
}

function countDistinctEvidenceSources(
  memory: Pick<PurrMemory, 'sourceRef' | 'provenanceRefs'>,
): number {
  const sourceSet = new Set<string>();
  const normalizedSourceRef = normalizeEvidenceSource(memory.sourceRef);
  if (normalizedSourceRef) sourceSet.add(normalizedSourceRef);
  for (const ref of memory.provenanceRefs ?? []) {
    const normalized = normalizeEvidenceSource(ref);
    if (normalized) sourceSet.add(normalized);
  }
  return sourceSet.size;
}

function normalizeEvidenceSource(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return '';
  const firstSeparator = trimmed.indexOf(':');
  if (firstSeparator <= 0) return trimmed;
  return trimmed.slice(0, firstSeparator + 1);
}

function hasExplicitMemoryMention(contextText: string, memoryText: string): boolean {
  const contextTokens = tokenizeForExplicitMatch(contextText);
  if (contextTokens.length === 0) return false;

  const memoryTokenSet = new Set(tokenizeForExplicitMatch(memoryText));
  if (memoryTokenSet.size === 0) return false;

  let overlap = 0;
  let hasLongOverlap = false;
  for (const token of contextTokens) {
    if (!memoryTokenSet.has(token)) continue;
    overlap++;
    if (token.length >= 6) {
      hasLongOverlap = true;
    }
  }

  if (overlap >= 2 && hasLongOverlap) return true;
  return overlap >= 3;
}

function tokenizeForExplicitMatch(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map(token => token.trim())
    .filter(token => token.length >= 4);
}

function estimateMemoryPromptTokens(memory: PurrMemory): number {
  return Math.max(1, countTokens(`[${memory.type}] ${memory.text}`));
}

function selectWithinTokenBudget(scored: ScoredMemory[], tokenBudget: number): ScoredMemory[] {
  if (scored.length === 0) return [];
  if (tokenBudget <= 0) return scored.slice(0, MEMORY_RETRIEVAL_MIN_ITEMS);

  let usedTokens = 0;
  const selected: ScoredMemory[] = [];
  for (const item of scored) {
    const itemTokens = estimateMemoryPromptTokens(item.memory);
    if (selected.length >= MEMORY_RETRIEVAL_MIN_ITEMS && usedTokens + itemTokens > tokenBudget) {
      break;
    }
    selected.push(item);
    usedTokens += itemTokens;
  }
  return selected;
}

function renderPromptBlock(
  profile: ContactProfileArtifact | undefined,
  scored: ScoredMemory[] = [],
  options?: {
    emotionalSnapshot?: EmotionalSnapshot;
    emotionalContinuityMemories?: PurrMemory[];
    withheldSummary?: MemoryWithheldSummary;
    socialContext?: RetrievalSocialContext;
    contactContextById?: ReadonlyMap<string, RetrievalContactContext>;
  },
): string {
  const sections: string[] = [];
  if (profile && profile.summary.trim().length > 0) {
    sections.push(wrapPromptSectionXml({
      id: 'core_profile',
      content: `Core profile for this person:\n${profile.summary.trim()}`,
    }));
  }
  if ((options?.socialContext?.relatedContactsById.size ?? 0) > 0) {
    sections.push(renderSocialContext(options.socialContext!));
  }
  if (options?.emotionalSnapshot) {
    sections.push(renderEmotionalSnapshot(options.emotionalSnapshot));
  }
  if ((options?.emotionalContinuityMemories?.length ?? 0) > 0) {
    sections.push(renderEmotionalContinuityMemories(options?.emotionalContinuityMemories ?? []));
  }
  if (options?.withheldSummary && options.withheldSummary.totalCount > 0) {
    sections.push(renderWithheldSummary(options.withheldSummary));
  }
  if (scored.length > 0) {
    sections.push(formatMemoriesForPrompt(
      scored,
      options?.socialContext,
      options?.contactContextById,
    ));
  }
  return sections.join('\n\n');
}

function renderSocialContext(context: RetrievalSocialContext): string {
  const lines = [...context.relatedContactsById.values()]
    .sort((left, right) => left.displayName.localeCompare(right.displayName))
    .map(contact => {
      const relation = contact.relationshipLabels.length > 0
        ? contact.relationshipLabels.join(', ')
        : 'known relation';
      return `- ${contact.displayName} is a separate person connected to ${context.canonicalDisplayName} as ${relation}.`;
  });
  lines.push(`- Keep memories about related people attributed to the named person instead of merging them into ${context.canonicalDisplayName}.`);
  return wrapPromptSectionXml({
    id: 'relationship_context',
    content: `Relationship context for this person:\n${lines.join('\n')}`,
  });
}

function renderEmotionalSnapshot(snapshot: EmotionalSnapshot): string {
  const moodDrift = snapshot.moodDrift >= 0
    ? `+${snapshot.moodDrift.toFixed(2)}`
    : snapshot.moodDrift.toFixed(2);
  const ageMs = snapshot.lastMoodUpdateEpochMs !== undefined
    ? Math.max(0, Date.now() - snapshot.lastMoodUpdateEpochMs)
    : null;
  const freshness = ageMs === null
    ? 'unknown'
    : ageMs <= (6 * 60 * 60 * 1000)
      ? 'active-session'
      : 'historical';

  return wrapPromptSectionXml({
    id: 'emotional_continuity_snapshot',
    content: [
    'Emotional continuity snapshot:',
    `- Baseline tone: ${describeValence(snapshot.baselineValence)} (${snapshot.baselineValence.toFixed(2)})`,
    `- Current mood drift: ${describeValence(snapshot.moodValence)} (${snapshot.moodValence.toFixed(2)}), drift ${moodDrift}`,
    `- Learned signals: ${snapshot.moodSamples}, freshness: ${freshness}`,
    ].join('\n'),
  });
}

function describeValence(valence: number): string {
  if (valence >= 0.55) return 'strongly positive';
  if (valence >= 0.2) return 'positive';
  if (valence <= -0.55) return 'strongly negative';
  if (valence <= -0.2) return 'negative';
  return 'neutral';
}

function renderEmotionalContinuityMemories(memories: PurrMemory[]): string {
  const lines = memories.map(memory => {
    const marker = memory.emotionalValence >= 0.25
      ? ' (+)'
      : memory.emotionalValence <= -0.25
        ? ' (-)'
        : '';
    return `- [emotional] ${memory.text}${marker}`;
  });
  return wrapPromptSectionXml({
    id: 'cross_session_emotional_continuity',
    content: `Cross-session emotional continuity:\n${lines.join('\n')}`,
  });
}

function renderWithheldSummary(summary: MemoryWithheldSummary): string {
  const detailLine = listMemoryWithheldReasonEntries(summary.reasonCounts)
    .map(({ reason, count }) => `${count} ${formatMemoryWithheldReasonLabel(reason)}`)
    .join(', ');
  const plural = summary.totalCount === 1 ? 'memory was' : 'memories were';
  return wrapPromptSectionXml({
    id: 'memory_context_note',
    content: [
      'Memory context note:',
      `- ${summary.totalCount} candidate ${plural} kept out of this turn's memory context.`,
      ...(detailLine ? [`- Reasons: ${detailLine}.`] : []),
      '- Do not infer or disclose missing details. Ask for consent or clarification if needed.',
    ].join('\n'),
  });
}

function formatMemoriesForPrompt(
  scored: ScoredMemory[],
  socialContext?: RetrievalSocialContext,
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>,
): string {
  const boundaryMemories = scored.filter(item => isBoundaryMemory(item.memory));
  const nonBoundaryMemories = scored.filter(item => !isBoundaryMemory(item.memory));
  const sections: string[] = [];

  if (boundaryMemories.length > 0) {
    sections.push(renderMemorySection(
      'Active safety boundaries from prior refusals:',
      boundaryMemories,
    ));
  }
  if (nonBoundaryMemories.length > 0) {
    if (socialContext) {
      sections.push(...renderSociallyScopedMemorySections(
        nonBoundaryMemories,
        socialContext,
        contactContextById,
      ));
    } else {
      sections.push(renderMemorySection(
        'Relevant memories for this person:',
        nonBoundaryMemories,
      ));
    }
  }

  return sections.join('\n\n');
}

function renderSociallyScopedMemorySections(
  scored: ScoredMemory[],
  socialContext: RetrievalSocialContext,
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>,
): string[] {
  const canonical: ScoredMemory[] = [];
  const related: ScoredMemory[] = [];
  const separatePeople: ScoredMemory[] = [];

  for (const item of scored) {
    const contactId = item.memory.contactId?.trim();
    if (!contactId || contactId === socialContext.canonicalContactId) {
      canonical.push(item);
      continue;
    }
    if (socialContext.relatedContactsById.has(contactId)) {
      related.push(item);
      continue;
    }
    separatePeople.push(item);
  }

  const sections: string[] = [];
  if (canonical.length > 0) {
    sections.push(renderMemorySection('Relevant memories for this person:', canonical));
  }
  if (related.length > 0) {
    sections.push(renderAttributedMemorySection(
      'Relevant memories about other people in their social context:',
      related,
      contactContextById,
    ));
  }
  if (separatePeople.length > 0) {
    sections.push(renderAttributedMemorySection(
      'Relevant memories about other separate people:',
      separatePeople,
      contactContextById,
    ));
  }

  return sections;
}

function renderMemorySection(heading: string, scored: ScoredMemory[]): string {
  const lines = scored.map(s => {
    const m = s.memory;
    const valence =
      m.emotionalValence > 0.3 ? ' (+)' :
      m.emotionalValence < -0.3 ? ' (-)' : '';
    return `- [${m.type}] ${m.text}${valence}`;
  });

  return wrapPromptSectionXml({
    id: heading === 'Active safety boundaries from prior refusals:'
      ? 'active_safety_boundaries'
      : heading === 'Relevant memories for this person:'
        ? 'relevant_memories'
        : 'memory_section',
    content: `${heading}\n${lines.join('\n')}`,
  });
}

function renderAttributedMemorySection(
  heading: string,
  scored: ScoredMemory[],
  contactContextById?: ReadonlyMap<string, RetrievalContactContext>,
): string {
  const lines = scored.map(s => {
    const memory = s.memory;
    const valence =
      memory.emotionalValence > 0.3 ? ' (+)' :
      memory.emotionalValence < -0.3 ? ' (-)' : '';
    const descriptor = memory.contactId ? contactContextById?.get(memory.contactId) : undefined;
    const subjectPrefix = descriptor
      ? `${descriptor.displayName}${formatContactDescriptorSuffix(descriptor)}: `
      : '';
    return `- [${memory.type}] ${subjectPrefix}${memory.text}${valence}`;
  });
  return wrapPromptSectionXml({
    id: heading.includes('social context')
      ? 'social_context_memories'
      : 'separate_people_memories',
    content: `${heading}\n${lines.join('\n')}`,
  });
}

function formatContactDescriptorSuffix(descriptor: RetrievalContactContext): string {
  const cues: string[] = [];
  if (descriptor.relatedToCanonical && descriptor.relationshipLabels.length > 0) {
    cues.push(descriptor.relationshipLabels.join(', '));
  } else if (descriptor.relationshipType.trim().length > 0) {
    cues.push(descriptor.relationshipType);
  }
  cues.push(`${descriptor.trustLevel} contact`);
  return ` [${cues.join('; ')}]`;
}

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
}

function resolveMoodCongruenceWeight(value: number | undefined): number {
  if (value === undefined) return DEFAULT_MOOD_CONGRUENCE_WEIGHT;
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`moodCongruenceWeight must be a finite number between 0 and 1; received ${String(value)}`);
  }
  return value;
}

function clampProbability(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function clampTurnFrequency(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function computeProactiveRecallWeight(memory: PurrMemory): number {
  const now = Date.now();
  const lastAccessed = Number.isFinite(memory.lastAccessed) ? memory.lastAccessed : memory.extractedAt;
  const ageMs = Math.max(0, now - lastAccessed);
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  const recencyWeight = 1 / (1 + ageDays / 14);
  const emotionalSignificance = 1 + Math.abs(memory.emotionalValence) * 2;
  const salienceWeight = Math.max(0.1, memory.salience);
  const importanceWeight = Math.max(0.1, memory.importance);

  return recencyWeight * emotionalSignificance * salienceWeight * importanceWeight;
}

function selectWeightedMemory(weighted: ProactiveWeightedMemory[]): PurrMemory | undefined {
  if (weighted.length === 0) return undefined;
  const totalWeight = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (totalWeight <= 0) return undefined;

  let draw = Math.random() * totalWeight;
  for (const item of weighted) {
    draw -= item.weight;
    if (draw <= 0) return item.memory;
  }
  return weighted[weighted.length - 1]?.memory;
}

/** Exported for test access. */
export const __retrieval_internals = {
  SCORE_GUARANTEE_MIN_K,
  SCORE_GUARANTEE_FLOOR,
} as const;

function renderProactiveRecall(memory: PurrMemory): string {
  const valenceSuffix =
    memory.emotionalValence > 0.3 ? ' (+)' :
    memory.emotionalValence < -0.3 ? ' (-)' : '';
  return [
    'Spontaneous recall:',
    `- [${memory.type}] ${memory.text}${valenceSuffix}`,
  ].join('\n');
}

function normalizeRelationCue(value: string): string {
  return value.trim().toLowerCase().replace(/_/g, ' ');
}

function mergeRetrievalContactContext(
  existing: RetrievalContactContext | undefined,
  incoming: RetrievalContactContext,
): RetrievalContactContext {
  if (!existing) return incoming;
  return {
    ...existing,
    relationshipLabels: [...new Set([
      ...existing.relationshipLabels,
      ...incoming.relationshipLabels,
    ])],
    relatedToCanonical: existing.relatedToCanonical || incoming.relatedToCanonical,
  };
}

function querySuggestsContactFocus(
  queryTokens: ReadonlySet<string>,
  contact: Pick<RetrievalContactContext, 'displayName' | 'relationshipType' | 'relationshipLabels'>,
): boolean {
  if (queryTokens.size === 0) return false;

  const cues = new Set<string>([
    ...tokenizeForExplicitMatch(contact.displayName),
    ...tokenizeForExplicitMatch(normalizeRelationCue(contact.relationshipType)),
  ]);
  for (const label of contact.relationshipLabels) {
    for (const token of tokenizeForExplicitMatch(label)) {
      cues.add(token);
    }
  }

  for (const cue of cues) {
    if (queryTokens.has(cue)) {
      return true;
    }
  }
  return false;
}
