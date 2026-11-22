import { cloneMemory } from '../../../core/turns/snapshot.js';
import type { MemoryStorePort } from '../memory-store-port.js';
import {
  memoryMatchesScopeQuery,
  type MemoryScopeQuery,
  type PurrMemory,
  type RetrievalCandidateChannel,
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

export type RetrievedMemoryCandidate = PurrMemory & {
  similarity: number;
  retrievalChannel?: RetrievalCandidateChannel;
};

const ZERO_UNIT = 0;
const ONE_UNIT = 1;
const LONG_TOKEN_CHARS = 6;
const LEXICAL_AUGMENT_BASE_SCALE = 0.6;
const LEXICAL_AUGMENT_BASE_LOW = 0.25;
const LEXICAL_AUGMENT_BASE_HIGH = 0.52;
const LEXICAL_AUGMENT_OVERLAP_STEP = 0.02;
const LEXICAL_AUGMENT_OVERLAP_CEILING = 0.12;
const LEXICAL_AUGMENT_SALIENCE_WEIGHT = 0.04;
const LEXICAL_AUGMENT_IMPORTANCE_WEIGHT = 0.03;
const LEXICAL_AUGMENT_SIMILARITY_CEILING = 0.58;
const HYBRID_RRF_CONSTANT = 60;
const HYBRID_DUAL_MATCH_LIFT_CEILING = 0.06;
const FTS_RANK_SIMILARITY_BASE = 0.42;
const FTS_RANK_SIMILARITY_SPAN = 0.16;
const FTS_CALIBRATED_SIMILARITY_CEILING = 0.60;

export function mergeScoredMemoryCandidates(
  primary: RetrievedMemoryCandidate[],
  augment: RetrievedMemoryCandidate[],
): RetrievedMemoryCandidate[] {
  if (augment.length === 0) return primary;
  const byId = new Map<string, RetrievedMemoryCandidate>();
  for (const memory of primary) {
    byId.set(memory.id, memory);
  }
  for (const memory of augment) {
    const existing = byId.get(memory.id);
    if (!existing) {
      byId.set(memory.id, memory);
    } else if (
      existing.retrievalChannel !== 'embedding'
      && memory.similarity > existing.similarity
    ) {
      byId.set(memory.id, memory);
    }
  }
  return [...byId.values()].sort((left, right) => (
    right.similarity - left.similarity
    || right.salience - left.salience
    || right.extractedAt - left.extractedAt
  ));
}

function calibrateFtsRankSimilarity(rawSimilarity: number, rankOneBased: number, pureFallback: boolean): number {
  const rankDecay = (HYBRID_RRF_CONSTANT + ONE_UNIT) / (HYBRID_RRF_CONSTANT + rankOneBased);
  const rankCalibrated = Math.min(
    FTS_CALIBRATED_SIMILARITY_CEILING,
    FTS_RANK_SIMILARITY_BASE + FTS_RANK_SIMILARITY_SPAN * rankDecay,
  );
  if (pureFallback && Number.isFinite(rawSimilarity) && rawSimilarity > rankCalibrated) {
    return clamp(rawSimilarity, ZERO_UNIT, ONE_UNIT);
  }
  return rankCalibrated;
}

/**
 * Fuses embedding candidates, Postgres full-text search (FTS) candidates, and
 * recent lexical-augment candidates on a commensurate similarity scale using
 * reciprocal-rank weighting (psfn-framework-d5e0p.19, psfn-framework-d5e0p.24).
 */
export function fuseHybridMemoryCandidates(input: {
  embedding: readonly RetrievedMemoryCandidate[];
  fts: readonly RetrievedMemoryCandidate[];
  lexicalAugment: readonly RetrievedMemoryCandidate[];
}): RetrievedMemoryCandidate[] {
  const pureFallback = input.embedding.length === 0 && input.lexicalAugment.length === 0;
  const byId = new Map<string, RetrievedMemoryCandidate>();
  const rrfById = new Map<string, number>();

  for (let index = 0; index < input.embedding.length; index += 1) {
    const memory = input.embedding[index]!;
    const tagged: RetrievedMemoryCandidate = {
      ...memory,
      retrievalChannel: memory.retrievalChannel ?? 'embedding',
    };
    const existing = byId.get(memory.id);
    if (!existing || tagged.similarity > existing.similarity) {
      byId.set(memory.id, tagged);
    }
    rrfById.set(
      memory.id,
      (rrfById.get(memory.id) ?? ZERO_UNIT) + ONE_UNIT / (HYBRID_RRF_CONSTANT + index + ONE_UNIT),
    );
  }

  for (let index = 0; index < input.fts.length; index += 1) {
    const memory = input.fts[index]!;
    const rankOneBased = index + ONE_UNIT;
    const rankDecay = (HYBRID_RRF_CONSTANT + ONE_UNIT) / (HYBRID_RRF_CONSTANT + rankOneBased);
    rrfById.set(
      memory.id,
      (rrfById.get(memory.id) ?? ZERO_UNIT) + ONE_UNIT / (HYBRID_RRF_CONSTANT + rankOneBased),
    );
    const existing = byId.get(memory.id);
    if (existing) {
      const dualLift = Math.min(
        HYBRID_DUAL_MATCH_LIFT_CEILING,
        HYBRID_DUAL_MATCH_LIFT_CEILING * rankDecay,
      );
      byId.set(memory.id, {
        ...existing,
        similarity: Math.min(ONE_UNIT, existing.similarity + dualLift),
      });
    } else {
      byId.set(memory.id, {
        ...memory,
        similarity: calibrateFtsRankSimilarity(memory.similarity, rankOneBased, pureFallback),
        retrievalChannel: 'fts',
      });
    }
  }

  for (let index = 0; index < input.lexicalAugment.length; index += 1) {
    const memory = input.lexicalAugment[index]!;
    const rankOneBased = index + ONE_UNIT;
    rrfById.set(
      memory.id,
      (rrfById.get(memory.id) ?? ZERO_UNIT) + ONE_UNIT / (HYBRID_RRF_CONSTANT + rankOneBased),
    );
    if (!byId.has(memory.id)) {
      byId.set(memory.id, {
        ...memory,
        retrievalChannel: 'lexical_augment',
      });
    }
  }

  return [...byId.values()].sort((left, right) => (
    right.similarity - left.similarity
    || (rrfById.get(right.id) ?? ZERO_UNIT) - (rrfById.get(left.id) ?? ZERO_UNIT)
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
}): Promise<RetrievedMemoryCandidate[]> {
  const contextTokens = new Set(tokenizeForExplicitMatch(input.contextText));
  if (contextTokens.size === 0) return [];
  const policy = resolveMemoryRetrievalPolicy(input.memoryRetrievalPolicy);

  const candidates: RetrievedMemoryCandidate[] = [];
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
        if (token.length >= LONG_TOKEN_CHARS) {
          longOverlap = true;
        }
      }
      if (overlap < policy.lexicalAugment.minOverlap || !longOverlap) continue;

      const calibratedBase = clamp(
        policy.lexicalAugment.baseSimilarity * LEXICAL_AUGMENT_BASE_SCALE,
        LEXICAL_AUGMENT_BASE_LOW,
        LEXICAL_AUGMENT_BASE_HIGH,
      );
      const overlapWeight = Math.min(LEXICAL_AUGMENT_OVERLAP_CEILING, overlap * LEXICAL_AUGMENT_OVERLAP_STEP);
      const salienceWeight = clamp(memory.salience, ZERO_UNIT, ONE_UNIT) * LEXICAL_AUGMENT_SALIENCE_WEIGHT;
      const importanceWeight = clamp(memory.importance, ZERO_UNIT, ONE_UNIT) * LEXICAL_AUGMENT_IMPORTANCE_WEIGHT;
      const similarity = Math.min(
        LEXICAL_AUGMENT_SIMILARITY_CEILING,
        calibratedBase + overlapWeight + salienceWeight + importanceWeight,
      );
      candidates.push({
        ...cloneMemory(memory),
        similarity,
        retrievalChannel: 'lexical_augment',
      });
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
