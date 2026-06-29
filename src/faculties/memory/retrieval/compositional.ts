import type { LLMProviderPort } from '../../../core/agent/contracts.js';
import { evaluateCompositionalPolicyForChannelId } from '../../../system/capabilities/compositional-policy.js';
import type { SubstrateConfig } from '../../../system/config/runtime-config-contracts.js';
import {
  composeRetrievalRanking,
  RETRIEVAL_COMPOSITION_BATCH_SIZE,
  RETRIEVAL_COMPOSITION_FINALIST_LIMIT,
  RETRIEVAL_COMPOSITION_MAX_CANDIDATES,
  type RetrievalComposeCandidate,
} from '../retrieval-compose.js';
import type {
  CompositionalRetrievalDecision,
  ScoredMemory,
} from './types.js';

export function shouldUseCompositionalRetrieval(input: {
  runtimeConfig: SubstrateConfig | null;
  llmProvider: LLMProviderPort | null;
  channelId: string;
}): boolean {
  if (!input.runtimeConfig || !input.llmProvider) return false;

  return evaluateCompositionalPolicyForChannelId({
    policy: input.runtimeConfig.compositionalPolicy,
    capabilityTier: input.runtimeConfig.capabilityTier,
    channelId: input.channelId,
    purpose: 'retrieval',
  }).allowed;
}

export async function applyCompositionalRetrievalRanking(input: {
  contextText: string;
  channelId: string;
  candidates: ScoredMemory[];
  runtimeConfig: SubstrateConfig | null;
  llmProvider: LLMProviderPort | null;
}): Promise<CompositionalRetrievalDecision> {
  const compositionalCandidateCount = Math.min(
    input.candidates.length,
    RETRIEVAL_COMPOSITION_MAX_CANDIDATES,
  );
  const finalistCount = compositionalCandidateCount < 2
    ? compositionalCandidateCount
    : Math.min(RETRIEVAL_COMPOSITION_FINALIST_LIMIT, compositionalCandidateCount);
  const evaluationBatchCount = compositionalCandidateCount < 2
    ? 0
    : Math.ceil(compositionalCandidateCount / RETRIEVAL_COMPOSITION_BATCH_SIZE);

  if (!shouldUseCompositionalRetrieval(input)) {
    return {
      ranked: null,
      mode: 'disabled_policy',
      candidateCount: compositionalCandidateCount,
      evaluationBatchCount,
      finalistCount,
    };
  }
  if (input.candidates.length < 2) {
    return {
      ranked: null,
      mode: 'insufficient_candidates',
      candidateCount: compositionalCandidateCount,
      evaluationBatchCount,
      finalistCount,
    };
  }
  if (!input.llmProvider) {
    return {
      ranked: null,
      mode: 'llm_unavailable',
      candidateCount: compositionalCandidateCount,
      evaluationBatchCount,
      finalistCount,
    };
  }

  const decision = await composeRetrievalRanking({
    llmClient: input.llmProvider,
    query: input.contextText,
    channelId: input.channelId,
    candidates: input.candidates.map((candidate): RetrievalComposeCandidate => ({
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
    ranked: input.candidates
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
