import type { LLMProviderPort } from '../../core/agent/contracts.js';

export const RETRIEVAL_COMPOSITION_BATCH_SIZE = 4;
export const RETRIEVAL_COMPOSITION_MAX_CANDIDATES = 12;
export const RETRIEVAL_COMPOSITION_FINALIST_LIMIT = 6;

export interface RetrievalComposeCandidate {
  id: string;
  text: string;
  type: string;
  score: number;
  similarity: number;
  importance: number;
  confidence: number;
  salience: number;
  evidenceSupport: number;
  explicitlyQueried: boolean;
}

export interface RetrievalCompositionDecision {
  relevanceById: Map<string, number>;
  finalOrder: string[];
}

export async function composeRetrievalRanking(options: {
  llmClient: LLMProviderPort;
  query: string;
  channelId: string;
  candidates: RetrievalComposeCandidate[];
}): Promise<RetrievalCompositionDecision | null> {
  const focusCandidates = options.candidates
    .slice(0, RETRIEVAL_COMPOSITION_MAX_CANDIDATES);
  if (focusCandidates.length < 2) return null;

  const queryTerms = extractSearchTerms(options.query);
  const relevanceById = new Map<string, number>();
  for (const candidate of focusCandidates) {
    relevanceById.set(candidate.id, scoreDeterministicRelevance(queryTerms, candidate));
  }

  const finalOrder = focusCandidates
    .map((candidate) => ({
      candidate,
      interimScore: candidate.score * (1 + ((relevanceById.get(candidate.id) ?? 0) * 0.5)),
    }))
    .sort((left, right) => (
      right.interimScore - left.interimScore
      || right.candidate.score - left.candidate.score
      || right.candidate.evidenceSupport - left.candidate.evidenceSupport
      || left.candidate.id.localeCompare(right.candidate.id)
    ))
    .slice(0, Math.min(RETRIEVAL_COMPOSITION_FINALIST_LIMIT, focusCandidates.length))
    .map(item => item.candidate.id);

  return {
    relevanceById,
    finalOrder,
  };
}

function clampScore01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

const STOPWORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'best',
  'by',
  'can',
  'did',
  'do',
  'does',
  'for',
  'from',
  'how',
  'i',
  'in',
  'is',
  'it',
  'me',
  'memory',
  'of',
  'on',
  'or',
  'our',
  'question',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'with',
  'you',
]);

function extractSearchTerms(value: string): Set<string> {
  const terms = new Set<string>();
  for (const token of value.toLowerCase().match(/[a-z0-9][a-z0-9'-]*/gu) ?? []) {
    const normalized = token.replace(/^'+|'+$/gu, '');
    if (normalized.length < 3 || STOPWORDS.has(normalized)) continue;
    terms.add(normalized);
  }
  return terms;
}

function scoreDeterministicRelevance(
  queryTerms: ReadonlySet<string>,
  candidate: RetrievalComposeCandidate,
): number {
  const candidateTerms = extractSearchTerms(candidate.text);
  let overlap = 0;
  for (const term of queryTerms) {
    if (candidateTerms.has(term)) overlap += 1;
  }
  const overlapScore = queryTerms.size > 0 ? overlap / queryTerms.size : 0;
  const structuredScore = (
    (candidate.similarity * 0.28)
    + (candidate.evidenceSupport * 0.22)
    + (candidate.importance * 0.18)
    + (candidate.confidence * 0.14)
    + (candidate.salience * 0.12)
    + (candidate.explicitlyQueried ? 0.06 : 0)
  );
  return clampScore01((overlapScore * 0.55) + (structuredScore * 0.45));
}
