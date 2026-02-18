import type { MemoryProvider, EmbeddingService } from '../agent-loop.js';
import type { ContactProfileArtifact, MemoryStore } from './store.js';
import type { PurrMemory } from './types.js';
import { MEMORY_CONFIG } from './types.js';
import type { SubstrateConfig } from '../types.js';
import type { EventBus } from '../event-bus.js';
import type { TrustLevel } from '../trust/types.js';
import {
  classifyChannel,
  getAllowedSensitivities,
  evaluateMemoryPolicy,
  type ChannelMeta,
} from '../trust/policy.js';
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
  profileIncluded?: boolean;
}

export interface MemoryRetrieverConfig {
  retrievalLimit?: number;
  retrievalThreshold?: number;
  telemetryEnabled?: boolean;
}

export class MemoryRetriever implements MemoryProvider {
  private memoryStore: MemoryStore;
  private embeddingService: EmbeddingService;
  private runtimeConfig: SubstrateConfig | null;
  private retrievalLimit: number;
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
    // If config has memoryRetrievalLimit, it's a SubstrateConfig — read per-call
    if (config && 'memoryRetrievalLimit' in config) {
      this.runtimeConfig = config;
      this.retrievalLimit = config.memoryRetrievalLimit;
      this.retrievalThreshold = MEMORY_CONFIG.retrievalThreshold;
      this.telemetryEnabled = config.memoryRetrievalTelemetryEnabled ?? true;
    } else {
      const retrieverConfig = config as MemoryRetrieverConfig | undefined;
      this.runtimeConfig = null;
      this.retrievalLimit = retrieverConfig?.retrievalLimit ?? MEMORY_CONFIG.maxRetrievalCount;
      this.retrievalThreshold = retrieverConfig?.retrievalThreshold ?? MEMORY_CONFIG.retrievalThreshold;
      this.telemetryEnabled = retrieverConfig?.telemetryEnabled ?? true;
    }
  }

  async retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
    canonicalContactId?: string,
  ): Promise<string> {
    // Read limit per-call from live config if available
    const limit = this.runtimeConfig?.memoryRetrievalLimit ?? this.retrievalLimit;
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

      const memories = this.memoryStore.searchByEmbedding(
        embedding,
        this.retrievalThreshold,
        20,
      );
      telemetry.candidateCount = memories.length;

      if (memories.length === 0) {
        telemetry.reason = 'no_candidates';
        await this.emitRetrievalTelemetry(telemetry);
        return renderPromptBlock(profile);
      }

      // Score, rank, take top N
      const scored: ScoredMemory[] = memories
        .map(memory => ({
          memory,
          score: computeRetrievalScore(memory),
        }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);
      telemetry.rankedCount = scored.length;

      if (scored.length === 0) {
        telemetry.reason = 'score_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        return renderPromptBlock(profile);
      }

      // Trust-gated filtering: apply trust level + channel visibility restrictions
      const allowed = getAllowedSensitivities(effectiveTrust, channelVisibility);

      const filtered = scored.filter(s => {
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

      telemetry.returnedCount = filtered.length;

      log.debug('Trust filter applied', {
        trustLevel: effectiveTrust,
        channelVisibility,
        before: scored.length,
        after: filtered.length,
      });

      if (filtered.length === 0) {
        telemetry.reason = 'trust_filtered';
        await this.emitRetrievalTelemetry(telemetry);
        return renderPromptBlock(profile);
      }

      // Update access stats (fire-and-forget)
      for (const s of filtered) {
        try {
          this.memoryStore.updateMemory(s.memory.id, {
            lastAccessed: Date.now(),
            accessCount: s.memory.accessCount + 1,
          });
        } catch { /* ignore */ }
      }

      telemetry.count = filtered.length;
      telemetry.returnedCount = filtered.length;
      telemetry.reason = 'ok';
      await this.emitRetrievalTelemetry(telemetry);
      return renderPromptBlock(profile, filtered);
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

function computeRetrievalScore(memory: PurrMemory & { similarity: number }): number {
  const ageDays = (Date.now() - memory.extractedAt) / (1000 * 60 * 60 * 24);
  const recencyBoost = 1 / (1 + ageDays / 30);
  const emotionalWeight = 1 + Math.abs(memory.emotionalValence) * 0.5;

  return (
    memory.similarity *
    recencyBoost *
    emotionalWeight *
    memory.importance *
    memory.salience
  );
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
  const lines = scored.map(s => {
    const m = s.memory;
    const valence =
      m.emotionalValence > 0.3 ? ' (+)' :
      m.emotionalValence < -0.3 ? ' (-)' : '';
    return `- [${m.type}] ${m.text}${valence}`;
  });

  return `What you remember about this person:\n${lines.join('\n')}`;
}
