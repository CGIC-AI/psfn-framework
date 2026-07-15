import { cloneMemory } from '../../../core/turns/snapshot.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import {
  memoryMatchesScopeQuery,
  type MemoryScopeQuery,
  type PurrMemory,
} from '../types.js';
import { isInternalMemoryArtifact } from '../internal-artifacts.js';
import {
  resolveMemoryRetrievalPolicy,
  type MemoryRetrievalPolicy,
} from '../../../system/config/memory-retrieval-policy.js';
import {
  clamp,
  tokenizeForExplicitMatch,
} from './scoring.js';

const RECENT_MEMORY_AUGMENT_MIN_OVERLAP = 2;
const RECENT_MEMORY_AUGMENT_BASE_SIMILARITY = 0.62;

export function mergeScoredMemoryCandidates(
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

export async function collectRecentLexicalMemoryCandidates(input: {
  memoryStore: MemoryStorePort;
  contextText: string;
  existingIds: ReadonlySet<string>;
  scopeQuery: MemoryScopeQuery | undefined;
  memoryRetrievalPolicy?: MemoryRetrievalPolicy;
}): Promise<Array<PurrMemory & { similarity: number }>> {
  const contextTokens = new Set(tokenizeForExplicitMatch(input.contextText));
  if (contextTokens.size === 0) return [];
  const policy = resolveMemoryRetrievalPolicy(input.memoryRetrievalPolicy);

  const candidates: Array<PurrMemory & { similarity: number }> = [];
  let scanned = 0;
  while (scanned < policy.lexicalAugment.maxScan) {
    const pageLimit = Math.min(
      policy.lexicalAugment.pageSize,
      policy.lexicalAugment.maxScan - scanned,
    );
    const recentMemories = (await input.memoryStore.listActiveMemories({
      limit: pageLimit,
      offset: scanned,
    })).slice(0, pageLimit);
    for (const memory of recentMemories) {
      if (input.existingIds.has(memory.id)) continue;
      if (isInternalMemoryArtifact(memory)) continue;
      if (input.scopeQuery?.mode === 'only' && !memoryMatchesScopeQuery(memory, input.scopeQuery)) {
        continue;
      }

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

    scanned += recentMemories.length;
    if (recentMemories.length < pageLimit) break;
  }

  return candidates
    .sort((left, right) => (
      right.similarity - left.similarity
      || right.extractedAt - left.extractedAt
    ))
    .slice(0, policy.lexicalAugment.selectedLimit);
}
