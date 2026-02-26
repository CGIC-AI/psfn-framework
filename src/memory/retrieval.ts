import type { MemoryProvider, EmbeddingService } from '../agent-loop.js';
import type { ContactProfileArtifact, MemoryStore } from './store.js';
import type { PurrMemory, MemoryPrivacyRiskBreakdown } from './types.js';
import { MEMORY_CONFIG, evaluateMemoryPrivacyRisk } from './types.js';
import type { SubstrateConfig } from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { TrustLevel, ChannelVisibility, SensitivityLevel } from '../trust/types.js';
import { countTokens } from '../llm/tokens.js';
import type { ContextBudgetConfigLike } from '../context-budget.js';
import {
  MEMORY_RETRIEVAL_MIN_ITEMS,
  resolveMemoryRetrievalBudget,
} from '../context-budget.js';
import {
  classifyChannel,
  getAllowedSensitivities,
  evaluateMemoryPolicy,
  type ChannelMeta,
} from '../trust/policy.js';
import {
  resolveBroadcastVisibilityScope,
  type BroadcastVisibilityScope,
} from '../broadcast/safety.js';
import { computeBoundarySimilarityBoost, isBoundaryMemory } from './boundary-log.js';
import { createComponentLogger } from '../logger.js';
import type { ContactStore } from '../contacts/store.js';
const log = createComponentLogger('Retrieval');

interface ScoredMemory {
  memory: PurrMemory & { similarity: number };
  baseScore: number;
  privacyRisk: number;
  privacyPenalty: number;
  privacyBreakdown: MemoryPrivacyRiskBreakdown;
  score: number;
}

interface RetrievalDecisionDiagnostics {
  candidateCount: number;
  policyAllowedCount: number;
  rejectedBySensitivity: number;
  rejectedByPolicy: number;
  rejectedByPolicyReason: Record<string, number>;
  rejectedByScore: number;
  selectedCount: number;
  topSelected: Array<{
    id: string;
    score: number;
    baseScore: number;
    privacyRisk: number;
    privacyPenalty: number;
    sensitivity: SensitivityLevel;
  }>;
}

interface RetrievalTelemetry {
  channelId: string;
  count: number;
  reason: 'ok' | 'empty_input' | 'no_candidates' | 'score_filtered' | 'trust_filtered' | 'error';
  trustLevel: TrustLevel;
  channelVisibility: string;
  candidateCount: number;
  rankedCount: number;
  returnedCount: number;
  retrievalLimit: number;
  retrievalThreshold: number;
  retrievalBudgetPct: number;
  retrievalTokenBudget: number;
  retrievalLimitMode: 'budget' | 'hard_limit';
  policyAllowedCount?: number;
  sensitivityRejectedCount?: number;
  policyRejectedCount?: number;
  scoreRejectedCount?: number;
  visibilityScope: BroadcastVisibilityScope | 'non_broadcast';
  operatorApproval: boolean;
  provenanceRefs: string[];
  profileIncluded?: boolean;
  emotionalSnapshotIncluded?: boolean;
  emotionalContinuityCount?: number;
}

interface ProactiveWeightedMemory {
  memory: PurrMemory;
  weight: number;
}

interface EmotionalSnapshot {
  baselineValence: number;
  moodValence: number;
  moodDrift: number;
  moodSamples: number;
  lastMoodUpdateEpochMs?: number;
}

export interface MemoryRetrieverConfig {
  retrievalLimit?: number;
  retrievalBudgetPct?: number;
  contextWindow?: number;
  retrievalThreshold?: number;
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
  ) {
    this.memoryStore = memoryStore;
    this.embeddingService = embeddingService;
    this.eventBus = eventBus;
    if (isSubstrateConfig(config)) {
      this.runtimeConfig = config;
      this.fallbackBudgetConfig = null;
      this.retrievalThreshold = MEMORY_CONFIG.retrievalThreshold;
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
        ...(retrieverConfig?.retrievalLimit !== undefined
          ? { memoryRetrievalLimit: retrieverConfig.retrievalLimit }
          : {}),
        ...(retrieverConfig?.retrievalBudgetPct !== undefined
          ? { memoryRetrievalBudgetPct: retrieverConfig.retrievalBudgetPct }
          : {}),
      };
      this.retrievalThreshold = retrieverConfig?.retrievalThreshold ?? MEMORY_CONFIG.retrievalThreshold;
      this.telemetryEnabled = retrieverConfig?.telemetryEnabled ?? true;
      this.proactiveRecallProbability = clampProbability(retrieverConfig?.proactiveRecallProbability ?? 0);
      this.proactiveRecallMinTurnsBetween = clampTurnFrequency(retrieverConfig?.proactiveRecallMinTurnsBetween ?? 2);
    }
    this.contactStore = contactStore ?? null;
    this.proactiveTurnCounter = 0;
    this.lastProactiveRecallTurn = Number.NEGATIVE_INFINITY;
  }

  private resolveRetrievalBudget(): ReturnType<typeof resolveMemoryRetrievalBudget> {
    if (this.runtimeConfig) {
      return resolveMemoryRetrievalBudget(this.runtimeConfig);
    }

    return resolveMemoryRetrievalBudget(
      this.fallbackBudgetConfig ?? {
        defaultContextWindow: 128_000,
        modelRoster: {},
      },
    );
  }

  async retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
  ): Promise<string> {
    const budget = this.resolveRetrievalBudget();
    const limit = budget.estimatedCount;
    const effectiveTrust = trustLevel ?? 'regular';
    const channelVisibility = classifyChannel(channelId, channelMeta);
    const visibilityScope = resolveBroadcastVisibilityScope(channelId, channelMeta) ?? 'non_broadcast';
    const operatorApproval = visibilityScope === 'approved_private_context';
    const telemetry: RetrievalTelemetry = {
      channelId,
      count: 0,
      reason: 'ok',
      trustLevel: effectiveTrust,
      channelVisibility,
      candidateCount: 0,
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
    const profile = canonicalContactId
      ? this.memoryStore.getContactProfile(canonicalContactId)
      : undefined;
    telemetry.profileIncluded = !!profile;
    const emotionalSnapshot = canonicalContactId
      ? this.resolveEmotionalSnapshot(canonicalContactId)
      : undefined;
    telemetry.emotionalSnapshotIncluded = !!emotionalSnapshot;

    const emptySelectedIds = new Set<string>();
    const fallbackEmotionalContinuity = canonicalContactId
      ? this.collectEmotionalContinuityMemories(
        canonicalContactId,
        effectiveTrust,
        channelVisibility,
        emptySelectedIds,
        operatorApproval,
      )
      : [];
    telemetry.emotionalContinuityCount = fallbackEmotionalContinuity.length;

    if (!contextText.trim()) {
      telemetry.reason = 'empty_input';
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile, [], {
        emotionalSnapshot,
        emotionalContinuityMemories: fallbackEmotionalContinuity,
      });
    }

    try {
      const embedding = await this.embeddingService.embed(contextText);
      const candidateLimit = Math.max(20, limit * (budget.mode === 'hard_limit' ? 2 : 3));

      const memories = this.memoryStore.searchByEmbedding(
        embedding,
        this.retrievalThreshold,
        candidateLimit,
      );
      telemetry.candidateCount = memories.length;

      if (memories.length === 0) {
        telemetry.reason = 'no_candidates';
        await this.emitRetrievalTelemetry(telemetry);
        return renderPromptBlock(profile, [], {
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
        });
      }

      const allowed = getAllowedSensitivities(effectiveTrust, channelVisibility);
      const diagnostics: RetrievalDecisionDiagnostics = {
        candidateCount: memories.length,
        policyAllowedCount: 0,
        rejectedBySensitivity: 0,
        rejectedByPolicy: 0,
        rejectedByPolicyReason: {},
        rejectedByScore: 0,
        selectedCount: 0,
        topSelected: [],
      };
      const policyAllowed: Array<PurrMemory & { similarity: number }> = [];

      for (const memory of memories) {
        if (!operatorApproval && !allowed.includes(memory.sensitivity)) {
          diagnostics.rejectedBySensitivity++;
          continue;
        }

        const policy = evaluateMemoryPolicy({
          trustLevel: effectiveTrust,
          channelVisibility,
          memorySensitivity: memory.sensitivity,
          consentFlags: memory.consentFlags,
          operatorApproval,
        });
        if (policy.decision !== 'allow') {
          diagnostics.rejectedByPolicy++;
          const reasonKey = `${policy.layer}:${policy.reason}`;
          diagnostics.rejectedByPolicyReason[reasonKey] = (diagnostics.rejectedByPolicyReason[reasonKey] ?? 0) + 1;
          continue;
        }

        policyAllowed.push(memory);
      }
      diagnostics.policyAllowedCount = policyAllowed.length;
      telemetry.policyAllowedCount = diagnostics.policyAllowedCount;
      telemetry.sensitivityRejectedCount = diagnostics.rejectedBySensitivity;
      telemetry.policyRejectedCount = diagnostics.rejectedByPolicy;

      if (policyAllowed.length === 0) {
        telemetry.reason = 'trust_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        log.debug('Retrieval decision rationale', {
          trustLevel: effectiveTrust,
          channelVisibility,
          ...diagnostics,
        });
        return renderPromptBlock(profile, [], {
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
        });
      }

      const scored = policyAllowed
        .map(memory => ({ memory, ...computeRetrievalScore(memory, contextText) }))
        .filter((candidate) => candidate.score > 0)
        .sort((a, b) => b.score - a.score);
      diagnostics.rejectedByScore = policyAllowed.length - scored.length;
      telemetry.scoreRejectedCount = diagnostics.rejectedByScore;

      const ranked = budget.mode === 'hard_limit'
        ? scored.slice(0, limit)
        : scored;
      telemetry.rankedCount = ranked.length;

      if (ranked.length === 0) {
        telemetry.reason = 'score_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        log.debug('Retrieval decision rationale', {
          trustLevel: effectiveTrust,
          channelVisibility,
          ...diagnostics,
        });
        return renderPromptBlock(profile, [], {
          emotionalSnapshot,
          emotionalContinuityMemories: fallbackEmotionalContinuity,
        });
      }

      const selected = budget.mode === 'hard_limit'
        ? ranked.slice(0, limit)
        : selectWithinTokenBudget(ranked, budget.tokenBudget);

      telemetry.returnedCount = selected.length;
      diagnostics.selectedCount = selected.length;
      diagnostics.topSelected = selected.slice(0, 3).map((item) => ({
        id: item.memory.id,
        score: Number(item.score.toFixed(4)),
        baseScore: Number(item.baseScore.toFixed(4)),
        privacyRisk: Number(item.privacyRisk.toFixed(4)),
        privacyPenalty: Number(item.privacyPenalty.toFixed(4)),
        sensitivity: item.memory.sensitivity,
      }));
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
        )
        : [];
      telemetry.emotionalContinuityCount = emotionalContinuityMemories.length;
      telemetry.provenanceRefs = collectSelectedProvenanceRefs(selected);

      // Update access stats (fire-and-forget)
      for (const s of selected) {
        try {
          this.memoryStore.updateMemory(s.memory.id, {
            lastAccessed: Date.now(),
            accessCount: s.memory.accessCount + 1,
          });
        } catch { /* ignore */ }
      }

      telemetry.count = selected.length;
      telemetry.reason = 'ok';
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile, selected, {
        emotionalSnapshot,
        emotionalContinuityMemories,
      });
    } catch (err) {
      log.error('Retrieval error', { error: String(err) });
      telemetry.reason = 'error';
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile, [], {
        emotionalSnapshot,
        emotionalContinuityMemories: fallbackEmotionalContinuity,
      });
    }
  }

  async retrieveProactiveRecall(
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
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
    const candidates = this.collectProactiveRecallCandidates(channelId, canonicalContactId);
    if (candidates.length === 0) return '';

    const allowed = getAllowedSensitivities(effectiveTrust, channelVisibility);
    const weighted = candidates
      .filter(memory => operatorApproval || allowed.includes(memory.sensitivity))
      .filter((memory) => {
        const policy = evaluateMemoryPolicy({
          trustLevel: effectiveTrust,
          channelVisibility,
          memorySensitivity: memory.sensitivity,
          consentFlags: memory.consentFlags,
          operatorApproval,
        });
        return policy.decision === 'allow';
      })
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
    } catch { /* ignore */ }

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
    const baselineValence = clamp(baselineRaw.valenceBaseline ?? baselineRaw.moodBaseline ?? 0, -1, 1);
    const moodValence = clamp(baselineRaw.moodValence ?? baselineRaw.sessionMoodValence ?? baselineValence, -1, 1);
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

  private collectEmotionalContinuityMemories(
    canonicalContactId: string,
    trustLevel: TrustLevel,
    channelVisibility: ChannelVisibility,
    selectedIds: ReadonlySet<string>,
    operatorApproval = false,
  ): PurrMemory[] {
    const source = this.memoryStore.getMemoriesByContact(canonicalContactId, 12);
    if (source.length === 0) return [];

    const allowed = getAllowedSensitivities(trustLevel, channelVisibility);

    return source
      .filter(memory => memory.type === 'emotional')
      .filter(memory => !selectedIds.has(memory.id))
      .filter((memory) => {
        if (!operatorApproval && !allowed.includes(memory.sensitivity)) return false;
        const policy = evaluateMemoryPolicy({
          trustLevel,
          channelVisibility,
          memorySensitivity: memory.sensitivity,
          consentFlags: memory.consentFlags,
          operatorApproval,
        });
        return policy.decision === 'allow';
      })
      .sort((left, right) => right.extractedAt - left.extractedAt)
      .slice(0, 3);
  }

  private collectProactiveRecallCandidates(
    channelId: string,
    canonicalContactId?: string,
  ): PurrMemory[] {
    if (canonicalContactId) {
      const byContact = this.memoryStore.getMemoriesByContact(canonicalContactId, 24);
      if (byContact.length > 0) return byContact;
    }

    const byChannel = this.memoryStore.getMemoriesByChannel(channelId, 24);
    if (byChannel.length > 0) return byChannel;

    return this.memoryStore
      .getAllActiveMemories()
      .sort((left, right) => right.lastAccessed - left.lastAccessed)
      .slice(0, 24);
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
      if (!this.isTelemetryEnabled()) {
        await this.eventBus.emit('memory.retrieval', {
          channelId: telemetry.channelId,
          count: telemetry.count,
        });
        return;
      }

      await this.eventBus.emit(
        'memory.retrieval',
        telemetry as { channelId: string; count: number },
      );
    } catch (err) {
      log.error('Failed to emit retrieval telemetry', {
        channelId: telemetry.channelId,
        error: String(err),
      });
    }
  }
}

function collectSelectedProvenanceRefs(scored: ScoredMemory[]): string[] {
  const refs = new Set<string>();
  for (const item of scored) {
    if (item.memory.sourceRef?.trim()) {
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
): {
  score: number;
  baseScore: number;
  privacyRisk: number;
  privacyPenalty: number;
  privacyBreakdown: MemoryPrivacyRiskBreakdown;
} {
  const ageDays = (Date.now() - memory.extractedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = 1 / (1 + ageDays / 30);
  const emotionalWeight = 1 + Math.abs(memory.emotionalValence) * 0.5;
  const typePriorityBoost = isBoundaryMemory(memory) ? 1.6 : 1;
  const boundarySimilarityBoost = isBoundaryMemory(memory)
    ? computeBoundarySimilarityBoost(contextText, memory)
    : 1;
  const baseScore = (
    memory.similarity *
    recencyBoost *
    emotionalWeight *
    memory.importance *
    memory.salience *
    typePriorityBoost *
    boundarySimilarityBoost
  );
  const privacyEvaluation = evaluateMemoryPrivacyRisk(memory);
  const privacyPenalty = baseScore * privacyEvaluation.risk * MEMORY_CONFIG.privacyRiskPenaltyWeight;
  const score = Math.max(0, baseScore - privacyPenalty);
  return {
    score,
    baseScore,
    privacyRisk: privacyEvaluation.risk,
    privacyPenalty,
    privacyBreakdown: privacyEvaluation.breakdown,
  };
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
  },
): string {
  const sections: string[] = [];
  if (profile && profile.summary.trim().length > 0) {
    sections.push(`Core profile for this person:\n${profile.summary.trim()}`);
  }
  if (options?.emotionalSnapshot) {
    sections.push(renderEmotionalSnapshot(options.emotionalSnapshot));
  }
  if ((options?.emotionalContinuityMemories?.length ?? 0) > 0) {
    sections.push(renderEmotionalContinuityMemories(options?.emotionalContinuityMemories ?? []));
  }
  if (scored.length > 0) {
    sections.push(formatMemoriesForPrompt(scored));
  }
  return sections.join('\n\n');
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

  return [
    'Emotional continuity snapshot:',
    `- Baseline tone: ${describeValence(snapshot.baselineValence)} (${snapshot.baselineValence.toFixed(2)})`,
    `- Current mood drift: ${describeValence(snapshot.moodValence)} (${snapshot.moodValence.toFixed(2)}), drift ${moodDrift}`,
    `- Learned signals: ${snapshot.moodSamples}, freshness: ${freshness}`,
  ].join('\n');
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
  return `Cross-session emotional continuity:\n${lines.join('\n')}`;
}

function formatMemoriesForPrompt(scored: ScoredMemory[]): string {
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
    sections.push(renderMemorySection(
      'What you remember about this person:',
      nonBoundaryMemories,
    ));
  }

  return sections.join('\n\n');
}

function renderMemorySection(heading: string, scored: ScoredMemory[]): string {
  const lines = scored.map(s => {
    const m = s.memory;
    const valence =
      m.emotionalValence > 0.3 ? ' (+)' :
      m.emotionalValence < -0.3 ? ' (-)' : '';
    return `- [${m.type}] ${m.text}${valence}`;
  });

  return `${heading}\n${lines.join('\n')}`;
}

function clamp(val: number, min: number, max: number): number {
  if (!Number.isFinite(val)) return (min + max) / 2;
  return Math.max(min, Math.min(max, val));
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

function renderProactiveRecall(memory: PurrMemory): string {
  const valenceSuffix =
    memory.emotionalValence > 0.3 ? ' (+)' :
    memory.emotionalValence < -0.3 ? ' (-)' : '';
  return [
    'Spontaneous recall:',
    `- [${memory.type}] ${memory.text}${valenceSuffix}`,
  ].join('\n');
}
