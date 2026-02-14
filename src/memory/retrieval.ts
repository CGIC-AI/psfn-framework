import type { MemoryProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from './store.js';
import type { PurrMemory } from './types.js';
import { MEMORY_CONFIG } from './types.js';
import type { SubstrateConfig } from '../types.js';
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

export interface MemoryRetrieverConfig {
  retrievalLimit?: number;
  retrievalThreshold?: number;
}

export class MemoryRetriever implements MemoryProvider {
  private memoryStore: MemoryStore;
  private embeddingService: EmbeddingService;
  private runtimeConfig: SubstrateConfig | null;
  private retrievalLimit: number;
  private retrievalThreshold: number;

  constructor(memoryStore: MemoryStore, embeddingService: EmbeddingService, config?: MemoryRetrieverConfig | SubstrateConfig) {
    this.memoryStore = memoryStore;
    this.embeddingService = embeddingService;
    // If config has memoryRetrievalLimit, it's a SubstrateConfig — read per-call
    if (config && 'memoryRetrievalLimit' in config) {
      this.runtimeConfig = config;
      this.retrievalLimit = config.memoryRetrievalLimit;
      this.retrievalThreshold = MEMORY_CONFIG.retrievalThreshold;
    } else {
      this.runtimeConfig = null;
      this.retrievalLimit = (config as MemoryRetrieverConfig | undefined)?.retrievalLimit ?? MEMORY_CONFIG.maxRetrievalCount;
      this.retrievalThreshold = (config as MemoryRetrieverConfig | undefined)?.retrievalThreshold ?? MEMORY_CONFIG.retrievalThreshold;
    }
  }

  async retrieve(
    contextText: string,
    channelId: string,
    trustLevel?: TrustLevel,
    channelMeta?: ChannelMeta,
  ): Promise<string> {
    if (!contextText.trim()) return '';

    // Read limit per-call from live config if available
    const limit = this.runtimeConfig?.memoryRetrievalLimit ?? this.retrievalLimit;

    try {
      const embedding = await this.embeddingService.embed(contextText);

      const memories = this.memoryStore.searchByEmbedding(
        embedding,
        this.retrievalThreshold,
        20,
      );

      if (memories.length === 0) return '';

      // Score, rank, take top N
      const scored: ScoredMemory[] = memories
        .map(memory => ({
          memory,
          score: computeRetrievalScore(memory),
        }))
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit);

      if (scored.length === 0) return '';

      // Trust-gated filtering: apply trust level + channel visibility restrictions
      const effectiveTrust = trustLevel ?? 'regular';
      const channelVisibility = classifyChannel(channelId, channelMeta);
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

      log.debug('Trust filter applied', {
        trustLevel: effectiveTrust,
        channelVisibility,
        before: scored.length,
        after: filtered.length,
      });

      if (filtered.length === 0) return '';

      // Update access stats (fire-and-forget)
      for (const s of filtered) {
        try {
          this.memoryStore.updateMemory(s.memory.id, {
            lastAccessed: Date.now(),
            accessCount: s.memory.accessCount + 1,
          });
        } catch { /* ignore */ }
      }

      return formatForPrompt(filtered);
    } catch (err) {
      log.error('Retrieval error', { error: String(err) });
      return '';
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

function formatForPrompt(scored: ScoredMemory[]): string {
  const lines = scored.map(s => {
    const m = s.memory;
    const valence =
      m.emotionalValence > 0.3 ? ' (+)' :
      m.emotionalValence < -0.3 ? ' (-)' : '';
    return `- [${m.type}] ${m.text}${valence}`;
  });

  return `What you remember about this person:\n${lines.join('\n')}`;
}
