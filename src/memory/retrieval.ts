import type { MemoryProvider, EmbeddingService } from '../agent-loop.js';
import type { MemoryStore } from './store.js';
import type { PurrMemory } from './types.js';
import { MEMORY_CONFIG } from './types.js';
import { createComponentLogger } from '../logger.js';
const log = createComponentLogger('Retrieval');

interface ScoredMemory {
  memory: PurrMemory & { similarity: number };
  score: number;
}

export class MemoryRetriever implements MemoryProvider {
  private memoryStore: MemoryStore;
  private embeddingService: EmbeddingService;

  constructor(memoryStore: MemoryStore, embeddingService: EmbeddingService) {
    this.memoryStore = memoryStore;
    this.embeddingService = embeddingService;
  }

  async retrieve(contextText: string, channelId: string): Promise<string> {
    if (!contextText.trim()) return '';

    try {
      const embedding = await this.embeddingService.embed(contextText);

      const memories = this.memoryStore.searchByEmbedding(
        embedding,
        MEMORY_CONFIG.retrievalThreshold,
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
        .slice(0, MEMORY_CONFIG.maxRetrievalCount);

      if (scored.length === 0) return '';

      // Update access stats (fire-and-forget)
      for (const s of scored) {
        try {
          this.memoryStore.updateMemory(s.memory.id, {
            lastAccessed: Date.now(),
            accessCount: s.memory.accessCount + 1,
          });
        } catch { /* ignore */ }
      }

      return formatForPrompt(scored);
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
