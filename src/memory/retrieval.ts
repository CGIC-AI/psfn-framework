import type { MemoryProvider, EmbeddingService } from '../agent-loop.js';
import type { ContactProfileArtifact, MemoryStore } from './store.js';
import type { PurrMemory } from './types.js';
import { MEMORY_CONFIG } from './types.js';
import type { SubstrateConfig } from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { TrustLevel } from '../trust/types.js';
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
import { computeBoundarySimilarityBoost, isBoundaryMemory } from './boundary-log.js';
import { createComponentLogger } from '../logger.js';
const log = createComponentLogger('Retrieval');

interface ScoredMemory {
  memory: PurrMemory & { similarity: number };
  score: number;
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
  profileIncluded?: boolean;
}

export interface MemoryRetrieverConfig {
  retrievalLimit?: number;
  retrievalBudgetPct?: number;
  contextWindow?: number;
  retrievalThreshold?: number;
  telemetryEnabled?: boolean;
}

function isSubstrateConfig(config: MemoryRetrieverConfig | SubstrateConfig | undefined): config is SubstrateConfig {
  return !!config && typeof config === 'object' && 'defaultContextWindow' in config;
}

export class MemoryRetriever implements MemoryProvider {
  private memoryStore: MemoryStore;
  private embeddingService: EmbeddingService;
  private runtimeConfig: SubstrateConfig | null;
  private fallbackBudgetConfig: ContextBudgetConfigLike | null;
  private retrievalThreshold: number;
  private eventBus?: EventBus;
  private telemetryEnabled: boolean;

  constructor(
    memoryStore: MemoryStore,
    embeddingService: EmbeddingService,
    config?: MemoryRetrieverConfig | SubstrateConfig,
    eventBus?: EventBus,
  ) {
    this.memoryStore = memoryStore;
    this.embeddingService = embeddingService;
    this.eventBus = eventBus;
    if (isSubstrateConfig(config)) {
      this.runtimeConfig = config;
      this.fallbackBudgetConfig = null;
      this.retrievalThreshold = MEMORY_CONFIG.retrievalThreshold;
      this.telemetryEnabled = config.memoryRetrievalTelemetryEnabled ?? true;
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
    }
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
      profileIncluded: false,
    };
    const profile = canonicalContactId
      ? this.memoryStore.getContactProfile(canonicalContactId)
      : undefined;
    telemetry.profileIncluded = !!profile;

    if (!contextText.trim()) {
      telemetry.reason = 'empty_input';
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile);
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
        return renderPromptBlock(profile);
      }

      const scored: ScoredMemory[] = memories
        .map(memory => ({
          memory,
          score: computeRetrievalScore(memory, contextText),
        }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score);

      const ranked = budget.mode === 'hard_limit'
        ? scored.slice(0, limit)
        : scored;
      telemetry.rankedCount = ranked.length;

      if (ranked.length === 0) {
        telemetry.reason = 'score_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        return renderPromptBlock(profile);
      }

      // Trust-gated filtering: apply trust level + channel visibility restrictions
      const allowed = getAllowedSensitivities(effectiveTrust, channelVisibility);

      const filtered = ranked.filter(s => {
        // Quick check: is the sensitivity level allowed for this trust+visibility?
        if (!allowed.includes(s.memory.sensitivity)) return false;

        // Full policy evaluation (includes consent flags, operator approval, etc.)
        const policy = evaluateMemoryPolicy({
          trustLevel: effectiveTrust,
          channelVisibility,
          memorySensitivity: s.memory.sensitivity,
          consentFlags: s.memory.consentFlags,
        });
        return policy.decision === 'allow';
      });

      log.debug('Trust filter applied', {
        trustLevel: effectiveTrust,
        channelVisibility,
        before: ranked.length,
        after: filtered.length,
      });

      if (filtered.length === 0) {
        telemetry.reason = 'trust_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        return renderPromptBlock(profile);
      }

      const selected = budget.mode === 'hard_limit'
        ? filtered.slice(0, limit)
        : selectWithinTokenBudget(filtered, budget.tokenBudget);

      telemetry.returnedCount = selected.length;

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
      return renderPromptBlock(profile, selected);
    } catch (err) {
      log.error('Retrieval error', { error: String(err) });
      telemetry.reason = 'error';
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile);
    }
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

function computeRetrievalScore(memory: PurrMemory & { similarity: number }, contextText: string): number {
  const ageDays = (Date.now() - memory.extractedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = 1 / (1 + ageDays / 30);
  const emotionalWeight = 1 + Math.abs(memory.emotionalValence) * 0.5;
  const typePriorityBoost = isBoundaryMemory(memory) ? 1.6 : 1;
  const boundarySimilarityBoost = isBoundaryMemory(memory)
    ? computeBoundarySimilarityBoost(contextText, memory)
    : 1;

  return (
    memory.similarity *
    recencyBoost *
    emotionalWeight *
    memory.importance *
    memory.salience *
    typePriorityBoost *
    boundarySimilarityBoost
  );
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
): string {
  const sections: string[] = [];
  if (profile && profile.summary.trim().length > 0) {
    sections.push(`Core profile for this person:\n${profile.summary.trim()}`);
  }
  if (scored.length > 0) {
    sections.push(formatMemoriesForPrompt(scored));
  }
  return sections.join('\n\n');
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
